import { useEffect, useState } from 'react';
import type { SafetyRequest } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';

const TIMEOUT_MS = 120000;

export function SafetyDialog({ request }: { request: SafetyRequest }) {
  const setPendingSafety = useAppStore((s) => s.setPendingSafety);
  const [remain, setRemain] = useState(Math.max(0, Math.round((request.createdAt + TIMEOUT_MS - Date.now()) / 1000)));

  useEffect(() => {
    const t = setInterval(() => {
      const left = Math.max(0, Math.round((request.createdAt + TIMEOUT_MS - Date.now()) / 1000));
      setRemain(left);
      if (left === 0) setPendingSafety(null);
    }, 1000);
    return () => clearInterval(t);
  }, [request, setPendingSafety]);

  function respond(approved: boolean) {
    void api.safetyRespond(request.id, approved);
    setPendingSafety(null);
  }

  return (
    <div className="modal-overlay">
      <div className={`modal safety-modal risk-${request.riskLevel}`}>
        <div className="modal-head">
          <span className="warn-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
              <path d="M12 3 22 20H2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M12 9.5v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="12" cy="16.8" r="1.1" fill="currentColor" />
            </svg>
          </span>
          <h3>需要你的确认</h3>
          <span className={`risk-badge risk-${request.riskLevel}`}>
            {request.riskLevel === 'high' ? '高风险' : '中风险'}
          </span>
        </div>
        <p className="safety-summary">{request.actionSummary}</p>
        <div className="safety-plan">
          <p className="plan-title">执行计划</p>
          <ol>
            {request.plan.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </div>
        <p className="countdown">{remain}s 后自动拒绝</p>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={() => respond(false)}>
            拒绝
          </button>
          <button
            className={request.riskLevel === 'high' ? 'btn-danger' : 'btn-primary'}
            onClick={() => respond(true)}
          >
            同意执行
          </button>
        </div>
      </div>
    </div>
  );
}
