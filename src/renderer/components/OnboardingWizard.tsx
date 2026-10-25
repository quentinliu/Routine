import { useState } from 'react';
import { useAppStore } from '../store';
import { CLOUD_PRESETS } from '../lib/cloudPresets';
import { api } from '../ipc';

const DISMISS_KEY = 'routine.onboardingDismissed';

export function onboardingDismissed(): boolean {
  return localStorage.getItem(DISMISS_KEY) === '1';
}

function dismiss(): void {
  localStorage.setItem(DISMISS_KEY, '1');
}

export function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const applySettings = useAppStore((s) => s.applySettings);
  const [step, setStep] = useState<'pick' | 'key' | 'testing'>('pick');
  const [presetId, setPresetId] = useState<string>(CLOUD_PRESETS[0].id);
  const [apiKey, setApiKey] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const preset = CLOUD_PRESETS.find((p) => p.id === presetId) ?? CLOUD_PRESETS[0];

  function finish(): void {
    dismiss();
    onDone();
  }

  async function chooseLocal(): Promise<void> {
    const saved = await api.settingsSet({ ...settings, providerMode: 'local' });
    applySettings(saved);
    finish();
  }

  async function testAndFinish(): Promise<void> {
    setStep('testing');
    const key = apiKey.trim();
    const profiles = settings.cloudProfiles.map((p, i) =>
      i === 0
        ? {
            ...p,
            baseURL: preset.baseURL,
            model: preset.models[0],
            label: `${preset.label} · ${preset.models[0]}`,
            apiKey: key
          }
        : p
    );
    try {
      const saved = await api.settingsSet({
        ...settings,
        cloudProfiles: profiles,
        activeCloudId: profiles[0].id,
        providerMode: 'cloud'
      });
      applySettings(saved);
      const health = await api.llmHealth();
      if (health.cloud) {
        setResult({ ok: true, message: `${preset.label} 连接成功，开始使用吧` });
      } else {
        setResult({ ok: false, message: '无法连接该服务：请检查 API Key 或网络后重试' });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal wizard-modal">
        <div className="modal-head">
          <h3>欢迎使用 Routine</h3>
        </div>

        {step === 'pick' && (
          <div className="wizard-body">
            <p className="wizard-lead">选择一个云端模型服务，贴入 API Key 即可开始。也可以先用本地 Ollama 隐私模式。</p>
            <div className="wizard-cards">
              {CLOUD_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`wizard-card ${presetId === p.id ? 'selected' : ''}`}
                  onClick={() => setPresetId(p.id)}
                >
                  <span className="wizard-card-name">{p.label}</span>
                  <span className="wizard-card-model">{p.models[0]}</span>
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <button className="btn-primary" onClick={() => setStep('key')}>
                下一步
              </button>
              <button className="btn-secondary" onClick={() => void chooseLocal()}>
                使用本地 Ollama
              </button>
              <button className="btn-secondary wizard-skip" onClick={finish}>
                跳过，稍后在设置中配置
              </button>
            </div>
          </div>
        )}

        {step === 'key' && (
          <div className="wizard-body">
            <p className="wizard-lead">
              {preset.label} · Base URL <code>{preset.baseURL}</code>
            </p>
            <label className="field">
              <span>
                API Key
                <button
                  type="button"
                  className="link-mini"
                  onClick={() => void api.openExternal(preset.keyUrl)}
                >
                  获取 {preset.label} API Key ↗
                </button>
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoFocus
              />
            </label>
            <div className="wizard-actions">
              <button className="btn-primary" disabled={!apiKey.trim()} onClick={() => void testAndFinish()}>
                保存并测试连接
              </button>
              <button className="btn-secondary" onClick={() => setStep('pick')}>
                上一步
              </button>
            </div>
          </div>
        )}

        {step === 'testing' && (
          <div className="wizard-body">
            {!result && <p className="wizard-lead">正在保存并测试连接…</p>}
            {result && (
              <>
                <p className={`wizard-result ${result.ok ? 'ok' : 'fail'}`}>
                  {result.ok ? '✓ ' : '✗ '}
                  {result.message}
                </p>
                <div className="wizard-actions">
                  {result.ok ? (
                    <button className="btn-primary" onClick={finish}>
                      开始使用
                    </button>
                  ) : (
                    <>
                      <button className="btn-primary" onClick={() => setStep('key')}>
                        返回修改
                      </button>
                      <button className="btn-secondary" onClick={finish}>
                        稍后再试
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
