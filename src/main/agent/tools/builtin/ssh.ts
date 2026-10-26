import type { SshHostConfig } from '../../../../shared/types';
import type { SshService } from '../../../services/ssh/service';
import { resolveHostRef, validateSshCommand } from '../../../services/ssh/util';
import { SECTION_ORDERS } from '../../prompt/registry';
import type { ToolDefinition } from '../types';

function formatSshHostsBlock(hosts: SshHostConfig[]): string {
  if (hosts.length === 0) return '';
  const lines = hosts
    .map(
      (h) =>
        `  - ${h.name} → ${h.user}@${h.host}:${h.port}${h.enabled ? '' : '（已禁用，不可执行）'}`
    )
    .join('\n');
  return `SSH 主机清单（ssh.exec 的 host 参数使用名称）：\n${lines}`;
}

export function createSshTools(ssh: SshService): ToolDefinition[] {
  return [
    {
      name: 'ssh.hosts',
      description: '列出已配置的 SSH 远程主机（名称、地址、是否启用）',
      inputSchema: { type: 'object', properties: {} },
      agent: 'ssh',
      risk: 'safe',
      render(result) {
        const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
        if (rows.length === 0) return '（尚未配置任何 SSH 主机）';
        return rows
          .map(
            (r) =>
              `- ${String(r.name)} ${String(r.address)}（${String(r.authType)}）${r.enabled === false ? '（已禁用）' : ''}`
          )
          .join('\n');
      },
      async execute() {
        return ssh.listHosts().map((h) => ({
          id: h.id,
          name: h.name,
          address: `${h.user}@${h.host}:${h.port}`,
          authType: h.authType,
          enabled: h.enabled
        }));
      }
    },
    {
      name: 'ssh.exec',
      description:
        '通过 SSH 在指定远程主机上执行 shell 命令，返回 stdout/stderr/退出码。host 填主机名称或 id；该命令会在远程主机上真实执行并需用户确认',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '主机名称（推荐）或 id，支持唯一模糊匹配' },
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeoutMs: { type: 'number', description: '超时毫秒，范围 [1000, 300000]，默认 30000' }
        },
        required: ['host', 'command']
      },
      agent: 'ssh',
      risk: 'medium',
      // 安全底线：远程命令不允许被 Settings.riskOverrides 降为 safe（否则一条设置即可静默执行）
      riskFloor: 'medium',
      promptSection: {
        name: 'tool:ssh',
        order: SECTION_ORDERS.TOOL_GUIDES + 10,
        text: 'SSH 任务：ssh.exec 的 host 参数填主机名称（主机清单见消息结尾的运行时上下文快照）；远程命令会真实执行且每次都需用户确认，被拒绝时不要原样重试；优先使用非破坏性的查看类命令；快照中没有主机清单说明尚未配置，请引导用户到设置页添加'
      },
      describe(args) {
        // 校验错误在审批前抛出（与原行为一致：无效主机/命令不触发确认弹窗）
        const host = resolveHostRef(ssh.listHosts(), String(args.host ?? ''));
        const command = validateSshCommand(String(args.command ?? ''));
        return {
          actionSummary: `在远程主机「${host.name}」（${host.user}@${host.host}）执行命令`,
          plan: [`命令: ${command}`, '该命令将在远程主机上真实执行，请确认内容安全'],
          waitingStatus: `等待确认: ${command.slice(0, 50)}`,
          waitingLog: `远程命令等待用户确认: ${command.slice(0, 80)}`,
          rejectStatus: '用户已拒绝该命令',
          rejectError: '用户拒绝执行该远程命令'
        };
      },
      async execute(args, ctx) {
        const host = resolveHostRef(ssh.listHosts(), String(args.host ?? ''));
        const command = validateSshCommand(String(args.command ?? ''));
        ctx.status('acting', command.slice(0, 80));
        ctx.log(`执行: ${command}`);
        const result = await ssh.exec(host.id, command, {
          timeoutMs: Number(args.timeoutMs) || undefined
        });
        return {
          host: host.name,
          command,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          durationMs: result.durationMs
        };
      },
      promptContext() {
        let hosts: SshHostConfig[] = [];
        try {
          hosts = ssh.listHosts();
        } catch {
          hosts = [];
        }
        // 无主机时不产出快照块：编排器据此判断「本任务无运行时上下文」
        return hosts.length === 0 ? '' : formatSshHostsBlock(hosts);
      }
    }
  ];
}
