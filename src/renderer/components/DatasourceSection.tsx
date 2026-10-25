import { useEffect, useState } from 'react';
import type { DbTestResult, DatasourceConfig } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { useEntityForm } from '../lib/useEntityForm';

type FormState = {
  id: string;
  name: string;
  type: 'mysql' | 'postgresql';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  enabled: boolean;
  timeoutMs: number;
};

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  type: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: '',
  ssl: false,
  enabled: true,
  timeoutMs: 10000
};

function toForm(ds: DatasourceConfig): FormState {
  return {
    id: ds.id,
    name: ds.name,
    type: ds.type,
    host: ds.host,
    port: ds.port,
    user: ds.user,
    password: '',
    database: ds.database ?? '',
    ssl: ds.ssl ?? false,
    enabled: ds.enabled,
    timeoutMs: ds.timeoutMs ?? 10000
  };
}

const DEFAULT_PORT: Record<FormState['type'], number> = { mysql: 3306, postgresql: 5432 };

export function DatasourceSection() {
  const [list, setList] = useState<DatasourceConfig[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DbTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const { form, setForm, update } = useEntityForm<FormState>(null);
  const setNotice = useAppStore((s) => s.setNotice);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const openDbWorkbench = useAppStore((s) => s.openDbWorkbench);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    setList(await api.dbList().catch(() => []));
  }

  function toConfig(form: FormState): DatasourceConfig {
    return {
      id: form.id,
      name: form.name.trim(),
      type: form.type,
      host: form.host.trim(),
      port: Number(form.port),
      user: form.user.trim(),
      password: form.password,
      database: form.database.trim() || undefined,
      ssl: form.ssl,
      enabled: form.enabled,
      timeoutMs: Number(form.timeoutMs) || undefined
    };
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await api.dbSave(toConfig(form));
      await refresh();
      setForm(null);
      setTestResult(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!form) return;
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await api.dbSave(toConfig(form));
      setForm(toForm(saved));
      setTestResult(await api.dbTest(saved.id));
    } catch (err) {
      setTestResult({
        ok: false,
        version: '',
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setTesting(false);
    }
  }

  function remove(ds: DatasourceConfig): void {
    requestConfirm({
      message: `删除数据源「${ds.name}」（${ds.host}:${ds.port}）？`,
      danger: true,
      onConfirm: () => {
        void doRemove(ds);
      }
    });
  }

  async function doRemove(ds: DatasourceConfig) {
    try {
      await api.dbDelete(ds.id);
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h4>数据源</h4>
      <p className="field-hint">
        配置 MySQL / PostgreSQL 连接后，数据库 Agent 可执行只读诊断与（经确认的）管理操作
      </p>

      <div className="entity-list">
        {list.length === 0 && <div className="field-hint">尚未配置数据源，点击下方按钮新增。</div>}
        {list.map((ds) => (
          <div key={ds.id} className="entity-item">
            <div className="entity-main">
              <span className={`entity-dot ${ds.enabled ? 'on' : ''}`} />
              <span className="entity-name">{ds.name}</span>
              <span className="entity-meta">
                {ds.type} · {ds.host}:{ds.port}
                {ds.database ? ` · ${ds.database}` : ''} · {ds.user}
              </span>
            </div>
            <div className="entity-actions">
              <button className="btn-mini" onClick={() => openDbWorkbench(ds.id)}>
                工作台
              </button>
              <button className="btn-mini" onClick={() => setForm(toForm(ds))}>
                编辑
              </button>
              <button className="btn-mini danger" onClick={() => remove(ds)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {!form && (
        <div className="index-row">
          <button className="btn-secondary" onClick={() => setForm({ ...EMPTY_FORM })}>
            新增数据源
          </button>
          <button className="btn-secondary" onClick={() => openDbWorkbench()}>
            打开数据库工作台
          </button>
        </div>
      )}

      {form && (
        <div className="entity-form">
          <label className="field">
            <span>名称</span>
            <input
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="生产库"
            />
          </label>
          <div className="field">
            <span>类型</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${form.type === 'mysql' ? 'active' : ''}`}
                onClick={() => update({ type: 'mysql', port: DEFAULT_PORT.mysql })}
              >
                MySQL
              </button>
              <button
                className={`seg-btn ${form.type === 'postgresql' ? 'active' : ''}`}
                onClick={() => update({ type: 'postgresql', port: DEFAULT_PORT.postgresql })}
              >
                PostgreSQL
              </button>
            </div>
          </div>
          <div className="field-row">
            <label className="field">
              <span>主机</span>
              <input value={form.host} onChange={(e) => update({ host: e.target.value })} />
            </label>
            <label className="field">
              <span>端口</span>
              <input
                type="number"
                value={form.port}
                onChange={(e) => update({ port: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>用户名</span>
              <input value={form.user} onChange={(e) => update({ user: e.target.value })} />
            </label>
            <label className="field">
              <span>密码（编辑时留空表示不修改）</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => update({ password: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>数据库（可选）</span>
            <input
              value={form.database}
              onChange={(e) => update({ database: e.target.value })}
            />
          </label>
          <div className="field">
            <span>连接选项</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${form.ssl ? 'active' : ''}`}
                onClick={() => update({ ssl: !form.ssl })}
              >
                SSL {form.ssl ? '开' : '关'}
              </button>
              <button
                className={`seg-btn ${form.enabled ? 'active' : ''}`}
                onClick={() => update({ enabled: !form.enabled })}
              >
                {form.enabled ? '启用' : '停用'}
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setForm(null)}>
              取消
            </button>
            <button className="btn-secondary" disabled={testing} onClick={() => void test()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button className="btn-primary" disabled={saving || !form.name.trim()} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>

          {testResult && (
            <div className={`ssh-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok
                ? `✓ 连接成功 · ${testResult.version} · ${testResult.latencyMs}ms`
                : `✗ ${testResult.error ?? '连接失败'}`}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
