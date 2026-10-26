'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStorage, getStorage } = require('../dist-main/main/services/storage.js');
const { ChatService } = require('../dist-main/main/services/chatService.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routine-chat-id-'));
}

/** 与 ipc.ts orchestratorEmit 相同的文本汇聚行为 */
function emitBridge(ev, sink) {
  if (ev.type === 'chat-delta') sink.text += ev.delta;
}

function okOrchestrator(msgId, text) {
  return {
    handleUserMessage: async (sessionId, _text, emit) => {
      emit({ type: 'trace', event: { sessionId, msgId, phase: 'thought', thought: '想一下' } });
      emit({ type: 'chat-delta', sessionId, msgId, delta: text });
      emit({ type: 'chat-delta', sessionId, msgId, delta: '', done: true });
      return text;
    }
  };
}

test('成功任务落盘的 assistant 消息 id 复用流式 msgId', async () => {
  initStorage(tmpDir());
  const svc = new ChatService(okOrchestrator('msg-abc', '回答正文'), emitBridge, () => {});
  const result = await svc.runTurn({ sessionId: 's-ok', text: '任务', source: 'chat' });
  assert.strictEqual(result.ok, true);

  const session = getStorage().listSessions().find((s) => s.id === 's-ok');
  const assistant = session.messages.filter((m) => m.role === 'assistant');
  assert.strictEqual(assistant.length, 1);
  assert.strictEqual(assistant[0].id, 'msg-abc');
});

test('失败任务落盘的失败说明同样复用 msgId（轮次重载后可吸附）', async () => {
  initStorage(tmpDir());
  const boom = {
    handleUserMessage: async (sessionId, _text, emit) => {
      emit({ type: 'trace', event: { sessionId, msgId: 'msg-err', phase: 'thought', thought: '想' } });
      throw new Error('LLM 连接失败');
    }
  };
  const svc = new ChatService(boom, emitBridge, () => {});
  const result = await svc.runTurn({ sessionId: 's-fail', text: '任务', source: 'chat' });
  assert.strictEqual(result.ok, false);

  const session = getStorage().listSessions().find((s) => s.id === 's-fail');
  const assistant = session.messages.filter((m) => m.role === 'assistant');
  assert.strictEqual(assistant.length, 1);
  assert.strictEqual(assistant[0].id, 'msg-err');
  assert.match(assistant[0].content, /执行失败/);
});

test('任务未发出任何事件即失败时回落随机 id，不阻塞持久化', async () => {
  initStorage(tmpDir());
  const silent = {
    handleUserMessage: async () => {
      throw new Error('即刻失败');
    }
  };
  const svc = new ChatService(silent, emitBridge, () => {});
  await svc.runTurn({ sessionId: 's-silent', text: '任务', source: 'chat' });

  const session = getStorage().listSessions().find((s) => s.id === 's-silent');
  const assistant = session.messages.filter((m) => m.role === 'assistant');
  assert.strictEqual(assistant.length, 1);
  assert.ok(assistant[0].id.length > 0);
});
