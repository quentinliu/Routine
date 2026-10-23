import { useAppStore } from '../store';

export function NoticeDialogs() {
  const notice = useAppStore((s) => s.notice);
  const setNotice = useAppStore((s) => s.setNotice);
  const confirmRequest = useAppStore((s) => s.confirmRequest);
  const resolveConfirm = useAppStore((s) => s.resolveConfirm);

  if (confirmRequest) {
    return (
      <div className="modal-overlay">
        <div className="modal confirm-modal">
          <div className="modal-head">
            <h3>确认操作</h3>
          </div>
          <p className="confirm-message">{confirmRequest.message}</p>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => resolveConfirm(false)}>
              取消
            </button>
            <button
              className={confirmRequest.danger ? 'btn-danger' : 'btn-primary'}
              onClick={() => resolveConfirm(true)}
            >
              确认
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (notice) {
    return (
      <div className="modal-overlay">
        <div className="modal notice-modal">
          <div className="modal-head">
            <h3>提示</h3>
            <button className="modal-close" onClick={() => setNotice(null)}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <p className="confirm-message">{notice}</p>
          <div className="modal-actions">
            <button className="btn-primary" onClick={() => setNotice(null)}>
              确定
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
