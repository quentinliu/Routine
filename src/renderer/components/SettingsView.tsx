import { useState } from 'react';
import type { Settings } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';

type HealthState = { cloud: boolean; local: boolean } | null;

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

        <div className="settings-body">
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
        </div>

        <div className="settings-footer">
          {health && (
            <span className="health-report">
              云端 {health.cloud ? '✓ 可用' : '✗ 不可用'} · 本地 {health.local ? '✓ 可用' : '✗ 不可用'}
            </span>
          )}
          <button className="btn-secondary" disabled={testing} onClick={() => void testConnection()}>
            {testing ? '检测中…' : '测试连接'}
          </button>
          <button className="btn-primary" onClick={() => void save()}>
            {saved ? '已保存 ✓' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
