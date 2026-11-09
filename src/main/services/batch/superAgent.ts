import type { BatchInstanceResult, BatchJobMode } from '../../../shared/types';
import { getRouter } from '../../llm/router';
import { buildReport, buildStructuredSummary, DIMENSION_LABELS } from './contract';

export interface SuperContext {
  mode: BatchJobMode;
  jobId: string;
  results: BatchInstanceResult[];
  llmBudget: number;
  signal: AbortSignal;
  /** 每次真实 LLM 请求前调用，用于进度条的真实计数 */
  onLlmCall(): void;
  /** B 模式补检：只重采指定实例，结果由 jobService 幂等合并 */
  recheck(ids: string[]): Promise<BatchInstanceResult[]>;
}

export interface SuperOutcome {
  summary: string;
  summarySource: 'structured' | 'llm' | 'none';
  /** B 模式 LLM 不可用 / 预算耗尽时降级为 A，报告仍完整 */
  degradedFrom?: BatchJobMode;
  degradedReason?: string;
}

const MAX_RECHECK_ROUNDS = 3;
const MAX_RECHECK_TARGETS = 10;

const ATTRIBUTION_SYSTEM = [
  '你是批量数据库巡检的归因助手。只能使用下方给出的结构化巡检结果，不得补充、推算或编造任何未出现的数字、实例名或趋势。',
  '输出中文，不超过 200 字，按「最需要优先处理的问题 → 建议动作」组织；若数据不足，直接说明哪些维度未获取。',
  '不要复述全部实例清单，不要输出表格，不要写「根据历史」「环比」等趋势结论。'
].join('\n');

const DECISION_SYSTEM = [
  '你是批量数据库巡检的 super agent，负责决定是否对异常实例补检一次。',
  '只输出一个 JSON 对象，不要输出其它文字。格式二选一：',
  '{"action":"recheck","datasourceIds":["id1","id2"]} —— 仅当你认为某台实例的结论证据不足需要重采时；',
  '{"action":"finish","summary":"中文结论，不超过 150 字"} —— 数据已经足够。',
  '硬性约束：datasourceIds 只能来自下方给出的实例 id，最多 10 个；同一实例不要重复补检；',
  '不得编造实例、数字或趋势；补检轮次有限，优先结束而不是反复重采。'
].join('\n');

async function askLlm(
  system: string,
  user: string,
  signal: AbortSignal,
  maxTokens: number
): Promise<string> {
  const provider = await getRouter().getActive();
  const res = await provider.chatStream(
    {
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens,
      signal
    },
    () => {}
  );
  return res.content.trim();
}

/** 紧凑的结构化摘要：只放真实采集到的字段，避免把 600 台原始结果塞进单一上下文 */
function compactResults(results: readonly BatchInstanceResult[], limit = 60): string {
  const lines = results.slice(0, limit).map((r) => {
    const dims = r.dimensions
      .map((d) => `${DIMENSION_LABELS[d.name]}:${d.status}${d.display ? `(${d.display})` : ''}`)
      .join(' ');
    return `${r.datasourceId} | ${r.datasourceName} | score=${String(r.healthScore ?? '未给出')} | ok=${String(r.ok)} | ${dims}`;
  });
  const tail =
    results.length > limit ? `\n（其余 ${results.length - limit} 台略，均为同形状结构化结果）` : '';
  return `共 ${results.length} 台实例。\n${lines.join('\n')}${tail}`;
}

interface SuperDecision {
  action: 'recheck' | 'finish';
  datasourceIds?: string[];
  summary?: string;
}

function parseDecision(text: string): SuperDecision | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw: unknown = JSON.parse(match[0]);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (obj.action === 'finish') {
      return { action: 'finish', summary: typeof obj.summary === 'string' ? obj.summary : '' };
    }
    if (obj.action === 'recheck' && Array.isArray(obj.datasourceIds)) {
      return {
        action: 'recheck',
        datasourceIds: obj.datasourceIds.filter((v): v is string => typeof v === 'string')
      };
    }
    return null;
  } catch {
    return null;
  }
}

function structuredFallback(results: BatchInstanceResult[], jobId: string): SuperOutcome {
  const report = buildReport(jobId, results, '', 'none');
  return {
    summary: buildStructuredSummary(report),
    summarySource: 'structured'
  };
}

/**
 * A 混合：规则化调度已在 jobService 完成，super 只做一次可选异常归因；
 * LLM 不可用时退回纯结构化摘要，报告其余部分不受影响。
 * B LLM 全权：super 自行读回摘要、决定补检、再收敛；带预算与轮次护栏，
 * 任一环节失败即降级为 A 并在作业上记录 degradedFrom。
 */
export async function runSuper(ctx: SuperContext): Promise<SuperOutcome> {
  if (ctx.signal.aborted || ctx.llmBudget <= 0) {
    return structuredFallback(ctx.results, ctx.jobId);
  }

  if (ctx.mode === 'hybrid') {
    const anomalies = ctx.results.filter(
      (r) => typeof r.healthScore === 'number' && r.healthScore < 90
    );
    if (anomalies.length === 0) return structuredFallback(ctx.results, ctx.jobId);
    try {
      ctx.onLlmCall();
      const text = await askLlm(
        ATTRIBUTION_SYSTEM,
        compactResults(anomalies, 30),
        ctx.signal,
        1024
      );
      if (!text) return structuredFallback(ctx.results, ctx.jobId);
      return { summary: text, summarySource: 'llm' };
    } catch {
      return structuredFallback(ctx.results, ctx.jobId);
    }
  }

  // B：LLM 自主决策补检
  const rounds = Math.min(ctx.llmBudget, MAX_RECHECK_ROUNDS);
  const alreadyRechecked = new Set<string>();
  let finalSummary = '';
  try {
    for (let round = 0; round < rounds; round += 1) {
      if (ctx.signal.aborted) break;
      ctx.onLlmCall();
      const raw = await askLlm(
        DECISION_SYSTEM,
        compactResults(ctx.results),
        ctx.signal,
        1024
      );
      const decision = parseDecision(raw);
      if (!decision) continue;
      if (decision.action === 'finish') {
        finalSummary = decision.summary ?? '';
        break;
      }
      const targets = [...new Set(decision.datasourceIds ?? [])]
        .filter((id) => ctx.results.some((r) => r.datasourceId === id))
        .filter((id) => !alreadyRechecked.has(id))
        .slice(0, MAX_RECHECK_TARGETS);
      if (targets.length === 0) break;
      targets.forEach((id) => alreadyRechecked.add(id));
      const refreshed = await ctx.recheck(targets);
      ctx.results = ctx.results.map(
        (r) => refreshed.find((n) => n.datasourceId === r.datasourceId) ?? r
      );
    }
    const outcome = structuredFallback(ctx.results, ctx.jobId);
    return {
      ...outcome,
      summary: finalSummary || outcome.summary,
      summarySource: finalSummary ? 'llm' : outcome.summarySource
    };
  } catch {
    return {
      ...structuredFallback(ctx.results, ctx.jobId),
      degradedFrom: 'llm-full',
      degradedReason: 'LLM 不可用或请求失败，已降级为规则化汇总'
    };
  }
}
