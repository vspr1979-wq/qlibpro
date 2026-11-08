import React from 'react';

export default function Toasts({ toasts }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.tone || 'ok'}`}>
          <b style={{ fontFamily: 'var(--mono)', letterSpacing: '.06em' }}>{t.title}</b>
          {t.detail && <div style={{ marginTop: 3, color: 'var(--dim)' }}>{t.detail}</div>}
        </div>
      ))}
    </div>
  );
}
