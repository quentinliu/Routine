import type { AgentName, AgentStatus, LogEntry, SafetyRequest } from '../../shared/types';
import type { LLMRouter } from '../llm/router';
import type { LLMChatMessage } from '../llm/provider';
import { COMPUTER_OPS } from '../services/computer';
import type { SafetyGate } from './safety';
import type { FileAgentService } from '../services/fileAgent';
import type { ComputerService } from '../services/computer';
import type { WebSearchService } from '../services/webSearch';
import type { BrowserAgentService } from '../services/browser';

export type OrchestratorEvent =
  | { type: 'agent-status'; status: AgentStatus }
  | { type: 'log'; entry: LogEntry }
  | { type: 'chat-delta'; sessionId: string; msgId: string; delta: string; done?: boolean }
  | { type: 'safety'; request: SafetyRequest };

export interface OrchestratorDeps {
  router: LLMRouter;
  safety: SafetyGate;
  fileAgent: FileAgentService;
  computer: ComputerService;
  web: WebSearchService;
  browser: BrowserAgentService;
}

interface PlanAction {
  tool: string;
  args: Record<string, unknown>;
}

interface PlanOutput {
  thought?: string;
  action?: PlanAction | null;
  final?: string | null;
}

const MAX_ITERATIONS = 6;
const TOOL_RESULT_LIMIT = 4000;

const TOOL_AGENT: Record<string, AgentName> = {
  'file.search': 'file',
  'file.read': 'file',
  'computer.info': 'computer',
  'computer.exec': 'computer',
  'search.web': 'search',
  'browser.run': 'browser'
};

const OP_LIST_TEXT = COMPUTER_OPS.map((o) => `  - ${o.op}: ${o.description}（风险 ${o.risk}）`).join(
  '\n'
);

const PLANNING_SYSTEM = `你是 Routine 主 Agent，一个运行在 macOS 上的智能助手调度中心，负责理解用户需求并调度子工具完成任务。

可用工具：
- file.search {query, limit?} — 本地文件搜索（桌面/文档/下载目录已建立索引）
- file.read {path, maxBytes?} — 读取文本文件内容
- computer.info {} — 获取系统信息快照（CPU/内存/磁盘/电池）
- computer.exec {op, args} — 执行系统操作，op 白名单：
${OP_LIST_TEXT}
- search.web {query, limit?} — 联网搜索
- browser.run {instruction} — 视觉浏览器 Agent，自动完成打开页面/登录（需在设置中配置站点凭据）/点击/表单/截图等网页任务

输出规则（严格遵守）：
每一轮你必须只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：
{"thought": "简短的中文推理", "action": {"tool": "工具名", "args": {...}}, "final": null}
或当信息足够回答用户时：
{"thought": "简短的中文推理", "action": null, "final": "面向用户的完整中文回答"}

规则：
- 需要调用工具时 action 非空且 final 必须为 null
- 信息足以回答时 final 非空且 action 必须为 null
- 高风险系统操作（清空废纸篓、强制退出应用）会先征求用户确认，被拒绝时换其他思路
- 浏览器任务请把完整自然语言指令传给 browser.run，例如 "打开 github.com 截图并提取正文"
- 回答一律使用中文`;

const FINAL_SYSTEM =
  '你是 Routine 主 Agent。用中文直接、简洁地回答用户，合理利用已获得的工具结果。使用 Markdown 格式，重点信息可用列表呈现。';

function extractJson(raw: string): PlanOutput | null {
  const stripped = raw.replace(/```(?:json)?/g, '').trim();
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as PlanOutput;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function truncateResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '(空结果)';
  return text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}…(已截断)` : text;
}

export class Orchestrator {
  aborted = false;

  constructor(public readonly deps: OrchestratorDeps) {}

  abort(): void {
    this.aborted = true;
  }

  private status(
    emit: (e: OrchestratorEvent) => void,
    agent: AgentName,
    state: AgentStatus['state'],
    detail: string
  ): void {
    emit({ type: 'agent-status', status: { agent, state, detail, updatedAt: Date.now() } });
  }

  private log(
    emit: (e: OrchestratorEvent) => void,
    agent: AgentName | 'system',
    text: string,
    level: LogEntry['level'] = 'info'
  ): void {
    emit({
      type: 'log',
      entry: { id: crypto.randomUUID(), ts: Date.now(), agent, level, text }
    });
  }

  private async dispatch(
    emit: (e: OrchestratorEvent) => void,
    action: PlanAction
  ): Promise<unknown> {
    const { fileAgent, computer, web, browser } = this.deps;
    const args = action.args ?? {};

    switch (action.tool) {
      case 'file.search':
        return fileAgent.searchFiles(String(args.query ?? ''), Number(args.limit ?? 20));
      case 'file.read':
        return fileAgent.readFile(String(args.path ?? ''), Number(args.maxBytes ?? 65536));
      case 'computer.info':
        return computer.snapshot();
      case 'computer.exec': {
        const op = String(args.op ?? '');
        const risk = this.deps.safety.classify('computer.exec', { op });
        if (risk !== 'safe') {
          const opMeta = COMPUTER_OPS.find((o) => o.op === op);
          const request = this.deps.safety.createRequest(
            'computer',
            opMeta ? opMeta.description : `执行系统操作 ${op}`,
            [`操作: ${op}`, `参数: ${JSON.stringify(args)}`, risk === 'high' ? '该操作不可逆，请谨慎确认' : '该操作会改变系统状态'],
            risk
          );
          this.status(emit, 'computer', 'waiting-approval', `等待确认: ${op}`);
          this.log(emit, 'computer', `高风险操作 ${op} 等待用户确认`, 'warn');
          emit({ type: 'safety', request });
          const approved = await this.deps.safety.awaitApproval(request);
          if (!approved) {
            this.status(emit, 'computer', 'done', `用户已拒绝: ${op}`);
            throw new Error(`用户拒绝执行该操作: ${op}`);
          }
        }
        return computer.execWhitelisted(op, args.args as Record<string, unknown>);
      }
      case 'search.web':
        return web.search(String(args.query ?? ''), Number(args.limit ?? 6));
      case 'browser.run': {
        const result = await browser.run(String(args.instruction ?? ''), (line) =>
          this.log(emit, 'browser', line)
        );
        return result;
      }
      default:
        throw new Error(`未知工具: ${action.tool}`);
    }
  }

  async handleUserMessage(
    sessionId: string,
    text: string,
    emit: (e: OrchestratorEvent) => void,
    history?: ChatMessageLite[]
  ): Promise<string> {
    this.aborted = false;
    const msgId = crypto.randomUUID();

    for (const agent of Object.values(TOOL_AGENT)) {
      this.status(emit, agent, 'idle', '');
    }
    this.status(emit, 'main', 'thinking', '正在理解你的需求');
    this.log(emit, 'system', `收到任务: ${text.slice(0, 100)}`);

    const baseMessages: LLMChatMessage[] = (history ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    baseMessages.push({ role: 'user', content: text });

    let planMessages = [...baseMessages];
    let finalText: string | null = null;
    let parseFailures = 0;

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (this.aborted) break;

        const provider = await this.deps.router.getActive();
        this.status(emit, 'main', 'thinking', `规划第 ${i + 1} 轮`);
        const res = await provider.chatStream(
          { system: PLANNING_SYSTEM, messages: planMessages, jsonMode: true, temperature: 0.2 },
          () => {}
        );
        const plan = extractJson(res.content);

        if (!plan) {
          parseFailures++;
          this.log(emit, 'main', `第 ${parseFailures} 次 JSON 解析失败`, 'warn');
          if (parseFailures >= 2) {
            finalText = res.content.trim() || '抱歉，我暂时无法完成这个任务。';
            break;
          }
          planMessages.push({ role: 'assistant', content: res.content });
          planMessages.push({
            role: 'user',
            content: 'JSON 格式错误，请重新只输出一个严格的 JSON 对象'
          });
          continue;
        }

        if (plan.thought) this.log(emit, 'main', plan.thought);

        if (plan.final) {
          finalText = plan.final;
          break;
        }

        if (!plan.action?.tool) {
          planMessages.push({ role: 'assistant', content: res.content });
          planMessages.push({
            role: 'user',
            content: '请给出 action（调用工具）或 final（最终回答），二者必须有其一'
          });
          continue;
        }

        const tool = plan.action.tool;
        const agent = TOOL_AGENT[tool];
        if (!agent) {
          planMessages.push({ role: 'assistant', content: res.content });
          planMessages.push({
            role: 'user',
            content: `工具结果: 未知工具 ${tool}，请从白名单中选择`
          });
          continue;
        }

        this.status(emit, 'main', 'acting', `调度 ${tool}`);
        this.status(emit, agent, 'acting', `${tool} ${JSON.stringify(plan.action.args ?? {})}`);

        let resultText: string;
        try {
          const result = await this.dispatch(emit, plan.action);
          resultText = truncateResult(result);
          this.status(emit, agent, 'done', `${tool} 完成`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          resultText = `工具执行失败: ${msg}`;
          this.status(emit, agent, 'error', msg);
          this.log(emit, agent, `${tool} 失败: ${msg}`, 'error');
        }

        planMessages.push({ role: 'assistant', content: res.content });
        planMessages.push({ role: 'user', content: `工具结果: ${resultText}` });
      }

      if (this.aborted) {
        emit({
          type: 'chat-delta',
          sessionId,
          msgId,
          delta: '\n\n（任务已被用户中止）',
          done: true
        });
        this.status(emit, 'main', 'done', '已中止');
        return '';
      }

      if (!finalText) {
        this.status(emit, 'main', 'thinking', '正在生成回答');
        const provider = await this.deps.router.getActive();
        const digest = planMessages
          .filter((m) => typeof m.content === 'string' && m.content.startsWith('工具结果:'))
          .map((m) => m.content as string)
          .join('\n');
        const res = await provider.chatStream(
          {
            system: FINAL_SYSTEM,
            messages: [
              { role: 'user', content: text },
              { role: 'user', content: `已执行的工具与结果：\n${digest || '（无）'}` }
            ],
            temperature: 0.5
          },
          (d) => emit({ type: 'chat-delta', sessionId, msgId, delta: d })
        );
        finalText = res.content;
        emit({ type: 'chat-delta', sessionId, msgId, delta: '', done: true });
      } else {
        const chunks = finalText.match(/[\s\S]{1,40}/g) ?? [finalText];
        for (const c of chunks) {
          if (this.aborted) break;
          emit({ type: 'chat-delta', sessionId, msgId, delta: c });
          await new Promise((r) => setTimeout(r, 20));
        }
        emit({ type: 'chat-delta', sessionId, msgId, delta: '', done: true });
      }

      this.status(emit, 'main', 'done', '任务完成');
      return finalText;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status(emit, 'main', 'error', msg);
      this.log(emit, 'system', `任务失败: ${msg}`, 'error');
      throw err;
    }
  }
}

export interface ChatMessageLite {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
