import { useEffect, useState } from 'react';
import type { DatasourceConfig, SkillInfo } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { customPrompt, diagnoseActions, toUserError } from '../lib/dbWorkbench';

interface Props {
  ds: DatasourceConfig;
  onClose: () => void;
}

export function DbWorkbenchDiagnose({ ds, onClose }: Props) {
  const [skills, setSkills] = useState<Map<string, SkillInfo> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefillComposer = useAppStore((s) => s.prefillComposer);
  const setNotice = useAppStore((s) => s.setNotice);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const closeWorkbench = useAppStore((s) => s.closeDbWorkbench);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await api.skillList();
        if (!alive) return;
        setSkills(new Map(list.map((s) => [s.name, s])));
      } catch (err) {
        if (alive) setError(toUserError(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const ctx = { name: ds.name, id: ds.id, database: ds.database };
  const actions = diagnoseActions(ds.type);

  function start(prompt: string) {
    prefillComposer(prompt);
    setNotice('诊断请求已写入对话草稿，确认后发送');
    onClose();
  }

  function describe(skillName: string): { enabled: boolean; reason: string } {
    if (!skills) return { enabled: false, reason: '读取技能中…' };
    const skill = skills.get(skillName);
    if (!skill) return { enabled: false, reason: '未安装' };
    if (!skill.enabled) return { enabled: false, reason: '已停用' };
    return { enabled: true, reason: '' };
  }

  return (
    <div className="wbk-stack">
      <div className="wbk-row wbk-row-between">
        <span className="wbk-kicker">
          AI 诊断 <span className="wbk-dim">按场景交给内置技能，请求只写入草稿</span>
        </span>
        <button
          className="btn-secondary btn-mini"
          onClick={() => {
            closeWorkbench();
            setSettingsOpen(true);
          }}
        >
          技能设置
        </button>
      </div>

      {error && (
        <div className="wbk-banner error">
          {error}
          <button className="btn-mini" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="wbk-actions-grid">
        {actions.map((action) => {
          const state = describe(action.skill);
          return (
            <button
              key={action.id}
              type="button"
              className={`wbk-action ${state.enabled ? '' : 'disabled'}`}
              disabled={!state.enabled}
              onClick={() => start(action.buildPrompt(ctx))}
              title={state.enabled ? action.description : `${state.reason}：${action.skill}`}
            >
              <span className="wbk-action-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path
                    d="M4 7h16M4 12h10M4 17h13"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span className="wbk-action-main">
                <span className="wbk-action-title">{action.title}</span>
                <span className="wbk-action-desc">{action.description}</span>
                <span className="wbk-action-skill">
                  {action.skill}
                  {!state.enabled && <i className="wbk-badge warn">{state.reason}</i>}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="wbk-row wbk-row-between wbk-custom">
        <p className="wbk-footnote">
          以上入口会先激活对应技能再采集证据；自定义诊断会自行选择技能与查询。
        </p>
        <button className="btn-secondary btn-mini" onClick={() => start(customPrompt(ctx))}>
          自定义诊断…
        </button>
      </div>
    </div>
  );
}
