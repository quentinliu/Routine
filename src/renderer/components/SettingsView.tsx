import { useEffect, useState } from 'react';
import type { CloudProfile, Settings, ThemeMode } from '../../shared/types';
import type { JSX } from 'react';
import type { CloudPreset } from '../lib/cloudPresets';
import { CLOUD_PRESETS, matchPreset } from '../lib/cloudPresets';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { DatasourceSection } from './DatasourceSection';
import { SshSection } from './SshSection';
import { McpSection } from './McpSection';
import { SkillsSection } from './SkillsSection';

type HealthState = { cloud: boolean; local: boolean } | null;

type CategoryId = 'models' | 'appearance' | 'automation' | 'db' | 'ssh' | 'skills' | 'mcp';

const THEMES: { id: ThemeMode; label: string; desc: string }[] = [
  { id: 'system', label: '跟随系统', desc: '随操作系统自动切换' },
  { id: 'light', label: '浅色', desc: '明亮界面，适合白天' },
  { id: 'dark', label: '深色', desc: '低光环境更省眼' }
];

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
  appearance: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.6"
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
  db: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  ),
  skills: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path
        d="M12 3.5l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.2l5.4-.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
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
  { id: 'appearance', label: '外观' },
  { id: 'automation', label: '文件与自动化' },
  { id: 'db', label: '数据库' },
  { id: 'ssh', label: 'SSH 主机' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP 服务' }
];

export function SettingsView() {
  const settings = useAppStore((s) => s.settings);
  const cloudHealth = useAppStore((s) => s.cloudHealth);
  const refreshCloudHealth = useAppStore((s) => s.refreshCloudHealth);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const applySettings = useAppStore((s) => s.applySettings);
  const indexProgress = useAppStore((s) => s.indexProgress);

  const [form, setForm] = useState<Settings>(settings);
  const [editingProfileId, setEditingProfileId] = useState<string>(settings.cloudProfiles[0].id);
  const [health, setHealth] = useState<HealthState>(null);
  const [testing, setTesting] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [active, setActive] = useState<CategoryId>('models');
  const [memoryText, setMemoryText] = useState<string | null>(null);
  const [riskTool, setRiskTool] = useState('');
  const [riskLevel, setRiskLevel] = useState<'safe' | 'medium' | 'high'>('medium');
  const setNotice = useAppStore((s) => s.setNotice);

  useEffect(() => {
    if (active === 'automation' && memoryText === null) {
      void api
        .memoryGet()
        .then(setMemoryText)
        .catch(() => setMemoryText(''));
    }
  }, [active, memoryText]);

  async function saveMemory(): Promise<void> {
    if (memoryText === null) return;
    try {
      await api.memorySave(memoryText);
      setNotice('长期记忆已保存');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function addRiskOverride(): void {
    const tool = riskTool.trim();
    if (!tool) return;
    update({ riskOverrides: { ...(form.riskOverrides ?? {}), [tool]: riskLevel } });
    setRiskTool('');
  }

  function removeRiskOverride(tool: string): void {
    const next = { ...(form.riskOverrides ?? {}) };
    delete next[tool];
    update({ riskOverrides: next });
  }

  function update(patch: Partial<Settings>): void {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  }

  const profiles = form.cloudProfiles;
  const editingProfile = profiles.find((p) => p.id === editingProfileId) ?? profiles[0];
  const activePreset = matchPreset(editingProfile.baseURL);

  function patchProfile(id: string, patch: Partial<CloudProfile>): void {
    setForm((f) => ({
      ...f,
      cloudProfiles: f.cloudProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }));
    setSaved(false);
  }

  function applyPreset(preset: CloudPreset): void {
    patchProfile(editingProfile.id, {
      baseURL: preset.baseURL,
      model: preset.models[0],
      label: `${preset.label} · ${preset.models[0]}`
    });
  }

  function addProfile(): void {
    const p: CloudProfile = {
      id: crypto.randomUUID(),
      label: '新模型',
      baseURL: '',
      apiKey: '',
      model: ''
    };
    setForm((f) => ({ ...f, cloudProfiles: [...f.cloudProfiles, p] }));
    setEditingProfileId(p.id);
    setSaved(false);
  }

  function removeProfile(id: string): void {
    if (profiles.length <= 1) return;
    const rest = profiles.filter((p) => p.id !== id);
    setForm((f) => ({
      ...f,
      cloudProfiles: rest,
      activeCloudId: f.activeCloudId === id ? rest[0].id : f.activeCloudId
    }));
    if (editingProfileId === id) setEditingProfileId(rest[0].id);
    setSaved(false);
  }

  async function save() {
    const s = await api.settingsSet(form);
    applySettings(s);
    setForm(s);
    setSaved(true);
    void refreshCloudHealth();
    setTimeout(() => setSaved(false), 2000);
  }

  // 主题是低风险偏好：选择即生效并立即持久化，不影响其他分类未保存的编辑
  async function chooseTheme(theme: ThemeMode) {
    setForm((f) => ({ ...f, appearance: { theme } }));
    try {
      const s = await api.settingsSet({ ...settings, appearance: { theme } });
      applySettings(s);
    } catch (err) {
      setForm((f) => ({ ...f, appearance: settings.appearance ?? { theme: 'system' } }));
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function testConnection() {
    setTesting(true);
    await api.settingsSet(form).catch(() => {});
    try {
      setHealth(await api.llmHealth());
      await refreshCloudHealth();
    } finally {
      setTesting(false);
    }
  }

  async function rebuildIndex() {
    setIndexing(true);
    try {
      await api.fileIndexStart();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
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
                  <div className="profile-list">
                    {profiles.map((p) => (
                      <div
                        key={p.id}
                        className={`profile-row ${p.id === editingProfile.id ? 'selected' : ''}`}
                        onClick={() => setEditingProfileId(p.id)}
                      >
                        <span
                          className={`health-dot ${
                            cloudHealth[p.id] === undefined ? 'unknown' : cloudHealth[p.id] ? 'ok' : 'fail'
                          }`}
                          title={
                            cloudHealth[p.id] === undefined
                              ? '未检测'
                              : cloudHealth[p.id]
                                ? '可用'
                                : '不可用'
                          }
                        />
                        <span className="profile-label">{p.label || p.model || '未命名模型'}</span>
                        <span className="profile-model">{p.model}</span>
                        {form.activeCloudId === p.id ? (
                          <span className="profile-active">使用中</span>
                        ) : (
                          <button
                            className="btn-mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              update({ activeCloudId: p.id });
                            }}
                          >
                            设为使用中
                          </button>
                        )}
                        {profiles.length > 1 && (
                          <button
                            className="btn-mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeProfile(p.id);
                            }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    ))}
                    <button className="profile-add" onClick={addProfile}>
                      + 添加模型
                    </button>
                  </div>

                  <label className="field">
                    <span>名称</span>
                    <input
                      value={editingProfile.label}
                      onChange={(e) => patchProfile(editingProfile.id, { label: e.target.value })}
                      placeholder="如 DeepSeek · deepseek-chat"
                    />
                  </label>
                  <div className="preset-row" role="group" aria-label="云端服务预设">
                    {CLOUD_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`preset-chip ${activePreset?.id === p.id ? 'selected' : ''}`}
                        onClick={() => applyPreset(p)}
                      >
                        {p.label}
                      </button>
                    ))}
                    <span className={`preset-chip preset-chip-static ${activePreset ? '' : 'selected'}`}>
                      自定义
                    </span>
                  </div>
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      value={editingProfile.baseURL}
                      onChange={(e) => patchProfile(editingProfile.id, { baseURL: e.target.value })}
                      placeholder="https://open.bigmodel.cn/api/paas/v4"
                    />
                  </label>
                  <label className="field">
                    <span>
                      API Key
                      {activePreset && (
                        <button
                          type="button"
                          className="link-mini"
                          onClick={() => void api.openExternal(activePreset.keyUrl)}
                        >
                          获取 {activePreset.label} API Key ↗
                        </button>
                      )}
                    </span>
                    <div className="key-row">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={editingProfile.apiKey}
                        onChange={(e) => patchProfile(editingProfile.id, { apiKey: e.target.value })}
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
                      value={editingProfile.model}
                      onChange={(e) => patchProfile(editingProfile.id, { model: e.target.value })}
                      list="cloud-model-options"
                      placeholder={activePreset?.models[0] ?? 'glm-4.6'}
                    />
                    <datalist id="cloud-model-options">
                      {(activePreset?.models ?? []).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
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
                        update({
                          search: {
                            ...form.search,
                            provider: e.target.value as 'auto' | 'bing' | 'tavily'
                          }
                        })
                      }
                    >
                      <option value="auto">自动（推荐：Tavily → 必应）</option>
                      <option value="bing">必应（免 Key，国内直连）</option>
                      <option value="tavily">仅 Tavily（需 API Key）</option>
                    </select>
                  </label>
                  {(form.search.provider === 'tavily' || form.search.provider === 'auto') && (
                    <label className="field">
                      <span>Tavily API Key{form.search.provider === 'auto' ? '（可选，自动模式下优先使用）' : ''}</span>
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
                        当前模型 {health.cloud ? '✓ 可用' : '✗ 不可用'} · 本地 {health.local ? '✓ 可用' : '✗ 不可用'}
                      </span>
                    )}
                  </div>
                </section>
              </>
            )}

            {active === 'appearance' && (
              <section>
                <h4>界面主题</h4>
                <p className="field-hint">
                  选择即生效并立即保存；「跟随系统」会随操作系统的浅色/深色模式自动切换。
                </p>
                <div className="theme-cards">
                  {THEMES.map((t) => {
                    const currentTheme = form.appearance?.theme ?? 'system';
                    return (
                      <button
                        key={t.id}
                        className={`theme-card ${currentTheme === t.id ? 'selected' : ''}`}
                        onClick={() => void chooseTheme(t.id)}
                      >
                        <span className={`theme-preview ${t.id}`}>
                          <span className="theme-preview-bar" />
                          <span className="theme-preview-body">
                            <span className="theme-preview-line long" />
                            <span className="theme-preview-line" />
                            <span className="theme-preview-chip" />
                          </span>
                        </span>
                        <span className="theme-card-name">{t.label}</span>
                        <span className="theme-card-desc">{t.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
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
                  <p className="field-hint">
                    调度任务串行执行（并发已固定为 1）；失败任务 15
                    分钟后自动重试一次，仍失败则终止。
                  </p>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={form.tray?.closeToTray ?? true}
                      onChange={(e) => update({ tray: { closeToTray: e.target.checked } })}
                    />
                    <span>关闭窗口时最小化到托盘，任务继续执行</span>
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={form.notifications?.enabled ?? true}
                      onChange={(e) =>
                        update({ notifications: { enabled: e.target.checked } })
                      }
                    />
                    <span>任务完成与异常时发送系统通知</span>
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
                <section>
                  <h4>长期记忆</h4>
                  <label className="field">
                    <span>
                      跨会话记忆（Agent 经 memory.write 追加；注入提示词上限 4000 字符，总量上限
                      8000）
                    </span>
                    <textarea
                      rows={6}
                      value={memoryText ?? ''}
                      onChange={(e) => setMemoryText(e.target.value)}
                      placeholder="（空）"
                    />
                  </label>
                  <div className="index-row">
                    <button
                      className="btn-secondary"
                      disabled={memoryText === null}
                      onClick={() => void saveMemory()}
                    >
                      保存记忆
                    </button>
                    {memoryText !== null && (
                      <span className="index-status">{memoryText.length} / 8000 字符</span>
                    )}
                  </div>
                </section>
                <section>
                  <h4>安全与审计</h4>
                  <p className="field-hint">
                    工具风险级覆盖：medium/high 执行前弹确认，safe 自动执行；基线为 high
                    的工具下调至 safe 时按 medium 生效。审计日志记录于用户数据目录
                    audit.json（仅 medium/high 操作，环形 500 条）。
                  </p>
                  {Object.entries(form.riskOverrides ?? {}).map(([tool, level]) => (
                    <div key={tool} className="index-row">
                      <span className="index-status">
                        {tool} → {level}
                      </span>
                      <button className="btn-mini danger" onClick={() => removeRiskOverride(tool)}>
                        移除
                      </button>
                    </div>
                  ))}
                  <div className="index-row">
                    <input
                      className="risk-tool-input"
                      value={riskTool}
                      onChange={(e) => setRiskTool(e.target.value)}
                      placeholder="工具名，如 computer.exec"
                    />
                    <select
                      value={riskLevel}
                      onChange={(e) => setRiskLevel(e.target.value as 'safe' | 'medium' | 'high')}
                    >
                      <option value="safe">safe</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                    <button
                      className="btn-secondary"
                      disabled={!riskTool.trim()}
                      onClick={addRiskOverride}
                    >
                      添加覆盖
                    </button>
                  </div>
                </section>
              </>
            )}

            {active === 'ssh' && <SshSection />}

            {active === 'db' && <DatasourceSection />}

            {active === 'skills' && <SkillsSection />}

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
