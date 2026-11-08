import React, { useState } from 'react';

export default function SettingsModal({ open, onClose, mode, connectedAt, tokenSource, onConnect, onDisconnect, paper = false, onPaperChange }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {tone, text}
  const [testOut, setTestOut] = useState(null);

  if (!open) return null;

  const connect = async () => {
    setBusy(true); setMsg(null); setTestOut(null);
    const res = await onConnect(token.trim());
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'ok', text: `Connected to Groww${res.validatedVia ? ` (validated via ${res.validatedVia})` : ''}. Token kept in server memory only.` });
      setToken('');
    } else {
      setMsg({ tone: 'err', text: res.reason || 'Connection failed.' });
    }
  };

  const testProxy = async () => {
    setTestOut('Calling GET /api/groww/proxy/holdings/user …');
    try {
      const r = await fetch('/api/groww/proxy/holdings/user');
      const j = await r.json();
      setTestOut(JSON.stringify(j, null, 2).slice(0, 1500));
    } catch (e) {
      setTestOut(`Request failed: ${e.message}`);
    }
  };

  const disconnect = async () => { await onDisconnect(); setMsg({ tone: 'ok', text: 'Disconnected. Back to PAPER mode.' }); setTestOut(null); };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Groww connection settings">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          Groww API Connection
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          <div className={`status-line ${mode === 'live' ? 'ok' : ''}`}>
            {mode === 'live'
              ? `● LIVE — token stored in server memory${tokenSource ? ` (source: ${tokenSource})` : ''}${connectedAt ? ` since ${new Date(connectedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}`
              : paper
                ? '○ PAPER SIMULATION — synthetic feed. Not the market.'
                : '○ NO FEED — Groww not connected and paper simulation is OFF. Prices show dashes; orders are disabled until you connect or re-enable paper.'}
          </div>

          <label className="toggle-row" htmlFor="paper-sim">
            <input id="paper-sim" type="checkbox" checked={paper} onChange={e => onPaperChange?.(e.target.checked)} />
            <span className="toggle-text">
              <b>PAPER SIMULATION</b> (synthetic feed)
              <small>Off by default. When off and Groww is disconnected the desk shows dashes — never fabricated prices. Turn on to trade a simulated ₹10L with generated ticks.</small>
            </span>
          </label>

          <div>
            <b>How to get your access token</b>
            <ol>
              <li>Log in to <b>groww.in</b> → Profile → <b>Settings</b> → <b>Trading APIs</b></li>
              <li><b>Generate API keys</b> → <b>Access Token</b> (expires daily 06:00 IST)</li>
              <li>Requires an active <b>Trading API subscription</b> (~₹499/mo + GST)</li>
              <li>Segments: <b>NSE/BSE · CASH + F&O</b> only</li>
            </ol>
          </div>

          <div className="field">
            <label htmlFor="groww-token">Access Token</label>
            <input
              id="groww-token"
              type="password"
              autoComplete="off"
              spellCheck="false"
              placeholder="eyJhbGciOi… (never leaves this server)"
              value={token}
              onChange={e => setToken(e.target.value)}
            />
          </div>
          {msg && <div className={`status-line ${msg.tone === 'ok' ? 'ok' : 'err'}`}>{msg.text}</div>}
          {testOut && <pre className="status-line" style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{testOut}</pre>}
          <div className="dim" style={{ fontSize: 9.5 }}>
            Token is sent only to this local server, held in memory, never logged or returned to the browser, and lost on restart.
            For unattended automation use the <b>TOTP flow</b> (API key + TOTP, no daily expiry) — see docs/PLAN.md §3.
          </div>
        </div>
        <div className="modal-foot">
          {mode === 'live'
            ? <button className="ghost-btn" onClick={disconnect}>Disconnect</button>
            : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            {mode === 'live' && <button className="ghost-btn" onClick={testProxy}>Test: holdings</button>}
            <button className="ghost-btn" onClick={onClose}>Close</button>
            <button className="primary-btn" disabled={busy || token.trim().length < 20} onClick={connect}>
              {busy ? 'Validating…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
