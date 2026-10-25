import { useEffect, useMemo, useState } from 'react';
import type { SshExecResult, SshHostConfig, SshTestResult } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { useEntityForm } from '../lib/useEntityForm';

type FormState = {
  id: string;
  name: string;
  host: string;
  port: string;
  user: string;
  authType: 'password' | 'key';
  password: string;
  privateKeyPath: string;
  passphrase: string;
  enabled: boolean;
  timeoutMs: string;
};

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  host: '',
  port: '22',
  user: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: '~/.ssh/id_ed25519',
  passphrase: '',
  enabled: true,
  timeoutMs: '10000'
};

function toForm(host: SshHostConfig): FormState {
  return {
    id: host.id,
    name: host.name,
    host: host.host,
    port: String(host.port),
    user: host.user,
    authType: host.authType,
    password: host.password ?? '',
    privateKeyPath: host.privateKeyPath ?? '',
    passphrase: host.passphrase ?? '',
    enabled: host.enabled,
    timeoutMs: String(host.timeoutMs ?? 10000)
  };
}

export function SshSection() {
  const [hosts, setHosts] = useState<SshHostConfig[]>([]);
  const { form, setForm, update } = useEntityForm<FormState>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, SshTestResult | { error: string }>>({});
  const [execHostId, setExecHostId] = useState('');
  const [command, setCommand] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<SshExecResult | null>(null);
  const [execError, setExecError] = useState('');
  const setNotice = useAppStore((s) => s.setNotice);
  const requestConfirm = useAppStore((s) => s.requestConfirm);

  useEffect(() => {
    void api.sshList().then(setHosts).catch(() => setHosts([]));
  }, []);

  const enabledHosts = useMemo(() => hosts.filter((h) => h.enabled), [hosts]);
  const execHost = enabledHosts.find((h) => h.id === execHostId) ?? null;
  async function refresh(): Promise<SshHostConfig[]> {
    const list = await api.sshList();
    setHosts(list);
    return list;
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const saved = await api.sshSave({
        id: form.id,
        name: form.name,
        host: form.host,
        port: Number(form.port) || 0,
        user: form.user,
        authType: form.authType,
        password: form.password,
        privateKeyPath: form.privateKeyPath,
        passphrase: form.passphrase,
        enabled: form.enabled,
        timeoutMs: Number(form.timeoutMs) || undefined
      });
      await refresh();
      setForm(null);
      if (!execHostId) setExecHostId(saved.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function test(host: SshHostConfig) {
    setTestingId(host.id);
    try {
      const result = await api.sshTest(host.id);
      setTestResults((r) => ({ ...r, [host.id]: result }));
    } catch (err) {
      setTestResults((r) => ({
        ...r,
        [host.id]: { error: err instanceof Error ? err.message : String(err) }
      }));
    } finally {
      setTestingId(null);
    }
  }

  function remove(host: SshHostConfig): void {
    requestConfirm({
      message: `删除主机「${host.name}」？`,
      danger: true,
      onConfirm: () => {
        void doRemove(host);
      }
    });
  }

  async function doRemove(host: SshHostConfig) {
    try {
      await api.sshDelete(host.id);
      const list = await refresh();
      if (execHostId === host.id) {
        setExecHostId(list.find((h) => h.enabled)?.id ?? '');
        setExecResult(null);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleEnabled(host: SshHostConfig) {
    try {
      await api.sshSave({ ...host, enabled: !host.enabled });
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function runCommand() {
    if (!execHost || !command.trim()) return;
    setExecuting(true);
    setExecError('');
    setExecResult(null);
    try {
      setExecResult(await api.sshExec(execHost.id, command));
    } catch (err) {
      setExecError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }

  return (
    <section>
      <h4>SSH 远程主机</h4>

      <div className="entity-list">
        {hosts.length === 0 && <div className="field-hint">尚未配置主机，点击下方按钮新增。</div>}
        {hosts.map((host) => {
          const result = testResults[host.id];
          return (
            <div key={host.id} className="entity-item">
              <div className="entity-main">
                <span className={`entity-dot ${host.enabled ? 'on' : ''}`} title={host.enabled ? '已启用' : '已禁用'} />
                <span className="entity-name">{host.name}</span>
                <span className="entity-meta">
                  {host.user}@{host.host}:{host.port} · {host.authType === 'password' ? '密码' : '密钥'}
                </span>
              </div>
              <div className="entity-actions">
                <button className="btn-mini" disabled={testingId === host.id} onClick={() => void test(host)}>
                  {testingId === host.id ? '测试中…' : '测试'}
                </button>
                <button className="btn-mini" onClick={() => setForm(toForm(host))}>编辑</button>
                <button className="btn-mini" onClick={() => void toggleEnabled(host)}>
                  {host.enabled ? '禁用' : '启用'}
                </button>
                <button className="btn-mini danger" onClick={() => remove(host)}>删除</button>
              </div>
              {result && (
                <div className={`ssh-test-result ${'error' in result ? 'fail' : 'ok'}`}>
                  {'error' in result
                    ? `✗ ${result.error}`
                    : `✓ 握手成功 · ${result.banner || '未知远端版本'} · ${result.latencyMs}ms`}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!form && (
        <div className="index-row">
          <button className="btn-secondary" onClick={() => setForm({ ...EMPTY_FORM })}>新增主机</button>
        </div>
      )}

      {form && (
        <div className="entity-form">
          <label className="field">
            <span>名称</span>
            <input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="生产服务器" />
          </label>
          <label className="field">
            <span>主机地址</span>
            <input value={form.host} onChange={(e) => update({ host: e.target.value })} placeholder="192.168.1.10" />
          </label>
          <label className="field">
            <span>端口</span>
            <input value={form.port} onChange={(e) => update({ port: e.target.value })} placeholder="22" />
          </label>
          <label className="field">
            <span>用户名</span>
            <input value={form.user} onChange={(e) => update({ user: e.target.value })} placeholder="root" />
          </label>
          <div className="field">
            <span>认证方式</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${form.authType === 'password' ? 'active' : ''}`}
                onClick={() => update({ authType: 'password' })}
              >
                密码
              </button>
              <button
                className={`seg-btn ${form.authType === 'key' ? 'active' : ''}`}
                onClick={() => update({ authType: 'key' })}
              >
                私钥
              </button>
            </div>
          </div>
          {form.authType === 'password' ? (
            <label className="field">
              <span>密码</span>
              <div className="key-row">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => update({ password: e.target.value })}
                  placeholder="登录密码"
                />
                <button className="btn-mini" onClick={() => setShowPassword((v) => !v)}>
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </div>
            </label>
          ) : (
            <>
              <label className="field">
                <span>私钥路径（支持 ~）</span>
                <input
                  value={form.privateKeyPath}
                  onChange={(e) => update({ privateKeyPath: e.target.value })}
                  placeholder="~/.ssh/id_ed25519"
                />
              </label>
              <label className="field">
                <span>私钥口令（可选）</span>
                <input
                  type="password"
                  value={form.passphrase}
                  onChange={(e) => update({ passphrase: e.target.value })}
                  placeholder="无则留空"
                />
              </label>
            </>
          )}
          <label className="field">
            <span>连接超时（毫秒，1000-60000）</span>
            <input value={form.timeoutMs} onChange={(e) => update({ timeoutMs: e.target.value })} />
          </label>
          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setForm(null)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <span>远程执行命令</span>
        <select value={execHostId} onChange={(e) => { setExecHostId(e.target.value); setExecResult(null); setExecError(''); }}>
          <option value="">选择已启用的主机…</option>
          {enabledHosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}（{h.user}@{h.host}）
            </option>
          ))}
        </select>
      </div>
      {execHost && (
        <>
          <label className="field">
            <span>命令（在远端默认 shell 中执行）</span>
            <textarea
              rows={2}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="例如：uname -a && df -h"
            />
          </label>
          <div className="index-row">
            <button
              className="btn-primary"
              disabled={executing || !command.trim()}
              onClick={() => void runCommand()}
            >
              {executing ? '执行中…' : '执行'}
            </button>
            <span className="field-hint">命令将真实作用于远程主机，请自行确认风险</span>
          </div>
          {execError && <div className="ssh-test-result fail">✗ {execError}</div>}
          {execResult && (
            <div className="ssh-output">
              <div className={`ssh-exit ${execResult.ok ? 'ok' : 'fail'}`}>
                退出码 {execResult.code ?? 'null'}
                {execResult.signal ? `（信号 ${execResult.signal}）` : ''} · {execResult.durationMs}ms
                {execResult.truncated ? ' · 输出已截断' : ''}
              </div>
              {execResult.stdout && <pre>{execResult.stdout}</pre>}
              {execResult.stderr && <pre className="ssh-stderr">{execResult.stderr}</pre>}
              {!execResult.stdout && !execResult.stderr && <pre>（无输出）</pre>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
