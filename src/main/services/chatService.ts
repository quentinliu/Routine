import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSession } from '../../shared/types';
import type { Orchestrator, OrchestratorEvent } from '../agent/orchestrator';
import { getStorage } from './storage';

export type TurnSource = 'chat' | 'scheduled';

export interface RunTurnInput {
  /** chat：已有会话 id；scheduled：缺省自动创建 */
  sessionId?: string;
  text: string;
  source: TurnSource;
  emitLog?: (line: string) => void;
}

export interface RunTurnResult {
  sessionId: string;
  ok: boolean;
  summary: string;
}

type EmitBridge = (ev: OrchestratorEvent, assistantSink: { text: string }) => void;

/**
 * 统一「对话一轮」用例：会话持久化、标题、事件桥接、失败清理。
 * ChatSend 与调度 runner 共用此唯一实现，持久化语义不再分叉：
 * 失败且无输出时落一条失败说明，避免悬空 user 消息（连续 user 历史）与空会话。
 */
export class ChatService {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly emitBridge: EmitBridge,
    private readonly resetStatuses: () => void
  ) {}

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const storage = getStorage();
    const scheduled = input.source === 'scheduled';
    let session: ChatSession;
    if (scheduled) {
      const now = Date.now();
      session = {
        id: input.sessionId ?? randomUUID(),
        title: `[定时] ${input.text}`.slice(0, 24),
        messages: [],
        createdAt: now,
        updatedAt: now
      };
      input.emitLog?.(`创建执行会话: ${session.title}`);
    } else {
      const found = input.sessionId
        ? storage.listSessions().find((s) => s.id === input.sessionId)
        : undefined;
      session =
        found ??
        {
          id: input.sessionId ?? randomUUID(),
          title: '新会话',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
    }

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: input.text,
      createdAt: Date.now()
    };
    session.messages.push(userMsg);
    if (!scheduled && session.messages.filter((m) => m.role === 'user').length === 1) {
      session.title = input.text.slice(0, 20);
    }
    session.updatedAt = Date.now();
    storage.saveSession(session);
    this.resetStatuses();

    const sink = { text: '' };
    let failed: string | null = null;
    try {
      await this.orchestrator.handleUserMessage(
        session.id,
        input.text,
        (ev) => this.emitBridge(ev, sink),
        session.messages.slice(0, -1)
      );
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }

    const answer = sink.text.trim();
    if (answer) {
      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: sink.text,
        createdAt: Date.now()
      });
      session.updatedAt = Date.now();
    } else if (failed) {
      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: `（执行失败：${failed}）`,
        createdAt: Date.now()
      });
      session.updatedAt = Date.now();
    }
    storage.saveSession(session);

    return {
      sessionId: session.id,
      ok: failed === null,
      summary: answer.slice(0, 200) || failed || '（无输出）'
    };
  }
}
