import { useState } from 'react';
import type { Settings } from '../../shared/types';
import type { JSX } from 'react';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { SshSection } from './SshSection';
import { McpSection } from './McpSection';

type HealthState = { cloud: boolean; local: boolean } | null;

type CategoryId = 'models' | 'automation' | 'ssh' | 'mcp';

const CATEGORY_ICONS: Record<CategoryId, JSX.Element> = {
  models: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <rect x="7" y="7" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 3.5V7m4-3.5V7m-4 10v3.5m4-3.5v3.5M3.5 10H7m-3.5 4H7m10-4h3.5m-3.5 4h3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  automation: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path
        d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.3H19A1.5 1.5 0 0 1 20.5 9.3V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8 12.2h5M8 15h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ssh: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M7 9.5l3 2.5-3 2.5M12.5 15H17"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  mcp: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path
        d="M9 7V5a3 3 0 0 1 6 0v2m-8 0h10a2 2 0 0 1 2 2v3a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6V9a2 2 0 0 1 2-2Zm6 11v3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
};

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'models', label: '模型服务' },
  { id: 'automation', label: '文件与自动化' },
  { id: 'ssh', label: 'SSH 主机' },
  { id: 'mcp', label: 'MCP 服务' }
];

export function SettingsView() {
  const settings = useAppStore((s) => s.settings);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const applySettings = useAppStore((s) => s.applySettings);
  const indexProgress = useAppStore((s) => s.indexProgress);

  const [form, setForm] = useState<Settings>(settings);
  const [health, setHealth] = useState<HealthState>(null);
  const [testing, setTesting] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [active, setActive] = useState<CategoryId>('models');

  function update(patch: Partial<Settings>): void {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  }

  async function save() {
    const s = await api.settingsSet(form);
    applySettings(s);
    setForm(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function testConnection() {
    setTesting(true);
    await api.settingsSet(form).catch(() => {});
    try {
      setHealth(await api.llmHealth());
    } finally {
      setTesting(false);
    }
  }

  async function rebuildIndex() {
    setIndexing(true);
    try {
      await api.fileIndexStart();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  }

  const indexPct =
    indexProgress && indexProgress.phase === 'indexing' && indexProgress.totalEstimate
      ? Math.min(100, Math.round((indexProgress.indexed / Math.max(1, indexProgress.indexed + indexProgress.scanned / 2)) * 100))
      : null;

  return (
    <div className="modal-overlay">
      <div className="modal settings-modal">
        <div className="modal-head">
          <h3>设置</h3>
          <button className="modal-close" onClick={() => setSettingsOpen(false)}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                className={`settings-nav-item ${active === c.id ? 'selected' : ''}`}
                onClick={() => setActive(c.id)}
              >
                {CATEGORY_ICONS[c.id]}
                <span>{c.label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-body">
            {active === 'models' && (
              <>
                <section>
                  <h4>工作模式</h4>
                  <div className="mode-cards">
                    <button
                      className={`mode-card ${form.providerMode === 'cloud' ? 'selected' : ''}`}
                      onClick={() => update({ providerMode: 'cloud' })}
                    >
                      <span className="mode-name">效率模式</span>
                      <span className="mode-desc">端云协同，响应快、能力强，需要 API Key</span>
                    </button>
                    <button
                      className={`mode-card ${form.providerMode === 'local' ? 'selected' : ''}`}
                      onClick={() => update({ providerMode: 'local' })}
                    >
                      <span className="mode-name">隐私模式</span>
                      <span className="mode-desc">本地 Ollama 推理，数据不出本机</span>
                    </button>
                  </div>
                </section>

                <section>
                  <h4>云端模型（OpenAI 兼容接口）</h4>
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      value={form.cloud.baseURL}
                      onChange={(e) => update({ cloud: { ...form.cloud, baseURL: e.target.value } })}
                      placeholder="https://open.bigmodel.cn/api/paas/v4"
                    />
                  </label>
                  <label className="field">
                    <span>API Key</span>
                    <div className="key-row">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={form.cloud.apiKey}
                        onChange={(e) => update({ cloud: { ...form.cloud, apiKey: e.target.value } })}
                        placeholder="sk-..."
                      />
                      <button className="btn-mini" onClick={() => setShowKey((v) => !v)}>
                        {showKey ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </label>
                  <label className="field">
                    <span>模型</span>
                    <input
                      value={form.cloud.model}
                      onChange={(e) => update({ cloud: { ...form.cloud, model: e.target.value } })}
                      placeholder="glm-4.6"
                    />
                  </label>
                </section>

                <section>
                  <h4>本地模型（Ollama）</h4>
                  <label className="field">
                    <span>服务地址</span>
                    <input
                      value={form.ollama.baseURL}
                      onChange={(e) => update({ ollama: { ...form.ollama, baseURL: e.target.value } })}
                      placeholder="http://localhost:11434"
                    />
                  </label>
                  <label className="field">
                    <span>模型</span>
                    <input
                      value={form.ollama.model}
                      onChange={(e) => update({ ollama: { ...form.ollama, model: e.target.value } })}
                      placeholder="qwen2.5:3b"
                    />
                  </label>
                </section>

                <section>
                  <h4>联网搜索</h4>
                  <label className="field">
                    <span>搜索引擎</span>
                    <select
                      value={form.search.provider}
                      onChange={(e) =>
                        update({ search: { ...form.search, provider: e.target.value as 'duckduckgo' | 'tavily' } })
                      }
                    >
                      <option value="duckduckgo">DuckDuckGo（免 Key，可能限流）</option>
                      <option value="tavily">Tavily（推荐，需 API Key）</option>
                    </select>
                  </label>
                  {form.search.provider === 'tavily' && (
                    <label className="field">
                      <span>Tavily API Key</span>
                      <input
                        type="password"
                        value={form.search.tavilyApiKey}
                        onChange={(e) =>
                          update({ search: { ...form.search, tavilyApiKey: e.target.value } })
                        }
                        placeholder="tvly-..."
                      />
                    </label>
                  )}
                </section>

                <section>
                  <h4>连接检测</h4>
                  <div className="settings-test-row">
                    <button className="btn-secondary" disabled={testing} onClick={() => void testConnection()}>
                      {testing ? '检测中…' : '测试连接'}
                    </button>
                    {health && (
                      <span className="health-report">
                        云端 {health.cloud ? '✓ 可用' : '✗ 不可用'} · 本地 {health.local ? '✓ 可用' : '✗ 不可用'}
                      </span>
                    )}
                  </div>
                </section>
              </>
            )}

            {active === 'automation' && (
              <>
                <section>
                  <h4>文件索引</h4>
                  <label className="field">
                    <span>索引目录（每行一个，支持 ~）</span>
                    <textarea
                      rows={3}
                      value={form.indexDirs.join('\n')}
                      onChange={(e) => update({ indexDirs: e.target.value.split('\n').filter((l) => l.trim()) })}
                    />
                  </label>
                  <label className="field">
                    <span>排除规则（每行一个 glob）</span>
                    <textarea
                      rows={3}
                      value={form.excludeGlobs.join('\n')}
                      onChange={(e) => update({ excludeGlobs: e.target.value.split('\n').filter((l) => l.trim()) })}
                    />
                  </label>
                  <div className="index-row">
                    <button className="btn-secondary" disabled={indexing} onClick={() => void rebuildIndex()}>
                      {indexing ? '索引中…' : '重建索引'}
                    </button>
                    {indexProgress && indexProgress.phase !== 'idle' && (
                      <span className="index-status">
                        {indexProgress.phase === 'done'
                          ? `完成：已索引 ${indexProgress.indexed} 个文件`
                          : `${indexProgress.phase === 'scanning' ? '扫描中' : '索引中'}：${indexProgress.indexed} / ${indexProgress.scanned}`}
                      </span>
                    )}
                  </div>
                  {indexPct !== null && (
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${indexPct}%` }} />
                    </div>
                  )}
                </section>
                <section>
                  <h4>定时任务</h4>
                  <label className="field">
                    <span>同时执行任务数（1 = 串行执行）</span>
                    <select
                      value={String(form.scheduler.maxConcurrent)}
                      onChange={(e) =>
                        update({ scheduler: { maxConcurrent: Number(e.target.value) } })
                      }
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                        <option key={n} value={n}>
                          {n} 个
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
                <section>
                  <h4>Agent 循环</h4>
                  <label className="field">
                    <span>单次任务最大规划轮数</span>
                    <select
                      value={String(form.agent.maxSteps)}
                      onChange={(e) => update({ agent: { maxSteps: Number(e.target.value) } })}
                    >
                      {[4, 6, 8, 12, 16, 20, 24, 30].map((n) => (
                        <option key={n} value={n}>
                          {n} 轮
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
              </>
            )}

            {active === 'ssh' && <SshSection />}

            {active === 'mcp' && <McpSection />}
          </div>
        </div>

        <div className="settings-footer">
          <button className="btn-primary" onClick={() => void save()}>
            {saved ? '已保存 ✓' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
