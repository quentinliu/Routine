import { createRoot } from 'react-dom/client';
import './styles.css';
import { useAppStore } from './store';
import { ChatView } from './components/ChatView';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { AgentPanel } from './components/AgentPanel';
import { DEFAULT_SETTINGS, type AgentTraceEvent, type ChatMessage } from '../shared/types';

const s = 's1';
const now = Date.now();

const userMsg: ChatMessage = {
  id: 'm1',
  role: 'user',
  content: '帮我找一下桌面上和报告相关的文件，读出年度报告的关键结论',
  createdAt: now - 60000
};

const answerMsg: ChatMessage = {
  id: 'm2',
  role: 'assistant',
  content:
    '桌面上共有 3 个相关文件，年度报告的结论集中在第 2 节：\n\n1. **营收**同比增长 18.4%，主要来自海外市场；\n2. **成本**增速回落到 9%，毛利率提升 3.1 个百分点；\n3. 明年重点投入端侧推理与数据合规。\n\n> 完整数据见 `~/Documents/年度报告.pdf` 第 12 页。',
  createdAt: now - 20000
};

const settled: AgentTraceEvent[] = [
  { sessionId: s, msgId: 'm2', phase: 'thought', thought: '先确认桌面上有哪些与「报告」相关的文件。' },
  {
    sessionId: s,
    msgId: 'm2',
    phase: 'tool-start',
    tool: 'file.search',
    argsDigest: '{"query":"报告","limit":10}'
  },
  {
    sessionId: s,
    msgId: 'm2',
    phase: 'tool-end',
    tool: 'file.search',
    resultDigest: '找到 3 个文件：季度报告.docx / 年度报告.pdf / 周报模板.md',
    durationMs: 418
  },
  { sessionId: s, msgId: 'm2', phase: 'thought', thought: '年度报告最相关，读取正文前 8k 字符确认结论部分。' },
  {
    sessionId: s,
    msgId: 'm2',
    phase: 'tool-start',
    tool: 'file.read',
    argsDigest: '{"path":"~/Documents/年度报告.pdf","maxBytes":8192}'
  },
  {
    sessionId: s,
    msgId: 'm2',
    phase: 'tool-end',
    tool: 'file.read',
    resultDigest: '第 2 节 关键结论 …（已截断）',
    durationMs: 1263
  },
  {
    sessionId: s,
    msgId: 'm2',
    phase: 'tool-start',
    tool: 'computer.exec',
    argsDigest: '{"op":"screenshot","description":"截取年度报告第 12 页图表区域并保存到桌面"}'
  },
  {
    sessionId: s,
    msgId: 'm2',
    phase: 'tool-end',
    tool: 'computer.exec',
    resultDigest: '截屏失败：屏幕录制权限未授予',
    error: true,
    durationMs: 3204
  }
];

const running: AgentTraceEvent[] = [
  {
    sessionId: s,
    msgId: 'm3',
    phase: 'thought',
    thought: '再检索一次线上的最新 AI 新闻，按时间倒序取前五条。'
  },
  {
    sessionId: s,
    msgId: 'm3',
    phase: 'tool-start',
    tool: 'search.web',
    argsDigest: '{"query":"端侧推理 最新进展","maxResults":5}'
  }
];

useAppStore.setState({
  settings: DEFAULT_SETTINGS,
  sessions: [
    {
      id: s,
      title: '整理桌面报告并总结',
      messages: [userMsg, answerMsg],
      createdAt: now - 60000,
      updatedAt: now
    },
    { id: 's2', title: '查看电脑配置', messages: [], createdAt: now - 90000, updatedAt: now - 90000 }
  ],
  currentSessionId: s,
  messages: [userMsg, answerMsg],
  turnsBySession: {
    [s]: [
      { msgId: 'm2', startedAt: now - 42000, endedAt: now - 20000, traces: settled },
      { msgId: 'm3', startedAt: now - 9000, endedAt: null, traces: running }
    ]
  },
  streamingMsg: { id: 'm3', content: '正在汇总搜索结果，稍后给出结论。' },
  runningSessionId: s,
  runningStartedAt: now - 9000
});

createRoot(document.getElementById('root')!).render(
  <div className="app-shell">
    <Topbar />
    <Sidebar />
    <ChatView />
    <AgentPanel />
  </div>
);
