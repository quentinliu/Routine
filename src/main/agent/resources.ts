import {
  MAX_SESSION_REFS,
  type DatasourceConfig,
  type ResourceRef,
  type ResourceRefKind,
  type SshHostConfig
} from '../../shared/types';

/**
 * 会话级资源引用（U15）：把「对话框里 @ 选中的资源」翻译成
 * ① 提示词快照块 ② 工具执行前的硬校验范围。
 *
 * 纯函数 + 外部注入清单：解析与校验不依赖单例服务，便于单测。
 * 只认 id：label 仅用于展示，资源被改名或改地址时以当前配置为准。
 */

const KINDS: readonly ResourceRefKind[] = ['datasource', 'sshHost'];

const KIND_LABELS: Record<ResourceRefKind, string> = {
  datasource: '数据源',
  sshHost: 'SSH 主机'
};

export interface ResourceLookup {
  datasources: readonly DatasourceConfig[];
  sshHosts: readonly SshHostConfig[];
}

/** 允许的工具目标：id 用于校验，label 用于错误文案 */
export interface ScopeTarget {
  id: string;
  label: string;
}

/** 空数组 / 缺省 = 该类别不限制（沿用「全部已配置资源可用」的既有行为） */
export interface ResourceScope {
  datasources?: ScopeTarget[];
  sshHosts?: ScopeTarget[];
}

export interface InvalidRef {
  ref: ResourceRef;
  reason: string;
}

export interface KindState {
  kind: ResourceRefKind;
  /** 用户在本会话引用过该类资源（含已失效项） */
  referenced: boolean;
  targets: ScopeTarget[];
  invalid: InvalidRef[];
}

export interface ResolvedRefs {
  scope: ResourceScope;
  states: KindState[];
  /** 存在失效引用：调用方据此提示用户，不阻断提问 */
  invalid: InvalidRef[];
  block: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isKind(value: unknown): value is ResourceRefKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

/**
 * 归一：过滤非法形状、去重（kind+id）、截断上限。
 * IPC 入参与旧配置文件都要过这一步，避免坏数据进入提示词与 scope。
 */
export function normalizeRefs(raw: unknown): ResourceRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ResourceRef[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SESSION_REFS) break;
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { kind?: unknown; id?: unknown; label?: unknown };
    if (!isKind(candidate.kind)) continue;
    const id = str(candidate.id);
    if (!id) continue;
    const key = `${candidate.kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: candidate.kind, id, label: str(candidate.label) || id });
  }
  return out;
}

function datasourceTarget(ds: DatasourceConfig): ScopeTarget {
  return {
    id: ds.id,
    label: `${ds.name} [${ds.type}] ${ds.host}:${ds.port}${ds.database ? `/${ds.database}` : ''}`
  };
}

export function sshScopeTarget(host: SshHostConfig): ScopeTarget {
  return { id: host.id, label: `${host.name} ${host.user}@${host.host}:${host.port}` };
}

function resolveKind(
  kind: ResourceRefKind,
  refs: readonly ResourceRef[],
  lookup: ResourceLookup
): KindState {
  const mine = refs.filter((r) => r.kind === kind);
  const state: KindState = { kind, referenced: mine.length > 0, targets: [], invalid: [] };
  for (const ref of mine) {
    if (kind === 'datasource') {
      const ds = lookup.datasources.find((d) => d.id === ref.id);
      if (!ds) state.invalid.push({ ref, reason: '数据源已删除' });
      else if (!ds.enabled) state.invalid.push({ ref, reason: '数据源已禁用' });
      else state.targets.push(datasourceTarget(ds));
      continue;
    }
    const host = lookup.sshHosts.find((h) => h.id === ref.id);
    if (!host) state.invalid.push({ ref, reason: '主机已删除' });
    else if (!host.enabled) state.invalid.push({ ref, reason: '主机已禁用' });
    else state.targets.push(sshScopeTarget(host));
  }
  return state;
}

/** 提示词块：只声明「允许的目标」，权威约束由工具 validate 承担 */
function buildBlock(states: readonly KindState[], invalid: readonly InvalidRef[]): string {
  const restricted = states.filter((s) => s.targets.length > 0);
  if (restricted.length === 0) {
    const names = invalid.map((i) => `${i.ref.label}（${i.reason}）`).join('、');
    return (
      `本会话资源引用${names ? `：${names}` : ''}\n` +
      '引用的资源均已失效，本轮不限制工具目标；如需指定目标，请在对话框移除后重新 @ 引用。'
    );
  }
  const lines: string[] = [];
  for (const state of restricted) {
    const label = KIND_LABELS[state.kind];
    lines.push(`  - ${label}：${state.targets.map((t) => `${t.label}（id=${t.id}）`).join('；')}`);
  }
  const dead = invalid.map((i) => `${i.ref.label}（${i.reason}）`).join('、');
  const constraints: string[] = [];
  if (restricted.some((s) => s.kind === 'datasource')) {
    constraints.push('db.query / db.exec 的 datasourceId 只能取上面的数据源 id');
  }
  if (restricted.some((s) => s.kind === 'sshHost')) {
    constraints.push('ssh.exec 的 host 只能取上面的主机名称或 id');
  }
  return [
    '本会话资源引用（用户在对话框 @ 指定，工具目标仅限以下资源）：',
    ...lines,
    `${constraints.join('；')}。越界调用会被主进程直接拒绝，不会进入审批与执行。`,
    ...(dead ? [`已失效的引用（本轮忽略）：${dead}`] : [])
  ].join('\n');
}

/**
 * 解析会话引用：按当前配置过滤已删除/已禁用的资源。
 * 某类别全部失效时该类不限制（scope 空数组），由调用方提示用户，
 * 不能把「引用失效」静默升级成「什么都没引用」或「全部禁止」。
 */
export function resolveRefs(refs: readonly ResourceRef[], lookup: ResourceLookup): ResolvedRefs {
  const states = KINDS.map((kind) => resolveKind(kind, refs, lookup));
  const scope: ResourceScope = {
    datasources: states.find((s) => s.kind === 'datasource')?.targets ?? [],
    sshHosts: states.find((s) => s.kind === 'sshHost')?.targets ?? []
  };
  const invalid = states.flatMap((s) => s.invalid);
  return { scope, states, invalid, block: buildBlock(states, invalid) };
}

function formatTargets(targets: readonly ScopeTarget[]): string {
  return targets.map((t) => `${t.id}（${t.label}）`).join('、');
}

/** db.query / db.exec 的执行前校验：越界直接抛错，早于审批与执行 */
export function assertDatasourceAllowed(scope: ResourceScope | undefined, datasourceId: string): void {
  const allowed = scope?.datasources ?? [];
  if (allowed.length === 0) return;
  if (allowed.some((t) => t.id === datasourceId)) return;
  throw new Error(
    `本会话只引用了数据源 ${formatTargets(allowed)}，datasourceId=${datasourceId} 不在引用范围内，未执行。` +
      '请改用被引用的 id；如确需其他数据源，请让用户在对话框移除引用或追加 @ 引用'
  );
}

/** ssh.exec 的执行前校验：host 传解析后的 id，避免名称/模糊匹配绕过 */
export function assertSshHostAllowed(scope: ResourceScope | undefined, host: ScopeTarget): void {
  const allowed = scope?.sshHosts ?? [];
  if (allowed.length === 0) return;
  if (allowed.some((t) => t.id === host.id)) return;
  throw new Error(
    `本会话只引用了主机 ${formatTargets(allowed)}，目标「${host.label}」不在引用范围内，未执行。` +
      '请改用被引用的主机；如确需其他主机，请让用户在对话框移除引用或追加 @ 引用'
  );
}
