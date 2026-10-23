import { useEffect, useState } from 'react';
import type { SkillDetail, SkillInfo } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  builtin: '内置',
  user: '用户'
};

export function SkillsSection() {
  const [list, setList] = useState<SkillInfo[]>([]);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const setNotice = useAppStore((s) => s.setNotice);
  const requestConfirm = useAppStore((s) => s.requestConfirm);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    setList(await api.skillList().catch(() => []));
  }

  async function toggle(skill: SkillInfo) {
    setBusy(skill.name);
    try {
      const settings = await api.settingsGet();
      const overrides = { ...(settings.skillOverrides ?? {}) };
      if (skill.enabled) overrides[skill.name] = false;
      else delete overrides[skill.name];
      await api.settingsSet({ ...settings, skillOverrides: overrides });
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function showDetail(skill: SkillInfo) {
    try {
      setDetail(await api.skillRead(skill.name));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function install() {
    setInstalling(true);
    try {
      const dir = await api.skillPickDir();
      if (!dir) return;
      const saved = await api.skillInstall(dir);
      await refresh();
      setNotice(`技能「${saved.name}」安装成功`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  function remove(skill: SkillInfo): void {
    requestConfirm({
      message: `删除用户技能「${skill.name}」？`,
      danger: true,
      onConfirm: () => {
        void doRemove(skill);
      }
    });
  }

  async function doRemove(skill: SkillInfo) {
    setBusy(skill.name);
    try {
      await api.skillRemove(skill.name);
      if (detail?.name === skill.name) setDetail(null);
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h4>Skills</h4>
      <p className="field-hint">
        技能遵循 Agent Skills 开放规范（SKILL.md），激活后为 Agent 提供领域操作手册；
        内置技能随应用升级，用户技能可自行导入维护
      </p>

      <div className="ssh-host-list">
        {list.length === 0 && <div className="field-hint">尚未安装技能。</div>}
        {list.map((skill) => (
          <div key={`${skill.source}-${skill.name}`} className="ssh-host-item">
            <div className="ssh-host-main">
              <span className={`ssh-enabled-dot ${skill.enabled ? 'on' : ''}`} />
              <span className="ssh-host-name">{skill.name}</span>
              <span className="ssh-host-meta">
                {SOURCE_LABEL[skill.source]}
                {skill.version ? ` · v${skill.version}` : ''}
                {skill.engine ? ` · ${skill.engine}` : ''}
                {skill.partial ? ' · 部分兼容（含脚本）' : ''}
                {' · '}
                {skill.enabled ? '已启用' : '已停用'}
              </span>
            </div>
            <div className="ssh-host-actions">
              <button
                className="btn-mini"
                disabled={busy === skill.name}
                onClick={() => void toggle(skill)}
              >
                {busy === skill.name ? '…' : skill.enabled ? '停用' : '启用'}
              </button>
              <button className="btn-mini" onClick={() => void showDetail(skill)}>
                详情
              </button>
              {skill.source === 'user' && (
                <button className="btn-mini danger" onClick={() => remove(skill)}>
                  删除
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="index-row">
        <button className="btn-secondary" disabled={installing} onClick={() => void install()}>
          {installing ? '安装中…' : '从文件夹安装'}
        </button>
      </div>

      {detail && (
        <div className="ssh-form">
          <div className="ssh-host-main">
            <span className="ssh-host-name">
              {detail.name}
              {detail.version ? ` v${detail.version}` : ''}
            </span>
            <span className="ssh-host-meta">{detail.description}</span>
          </div>
          <pre className="skill-detail-body">{detail.body}</pre>
          {detail.files.length > 0 && (
            <div className="field-hint">附加文档：{detail.files.join('、')}</div>
          )}
          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
