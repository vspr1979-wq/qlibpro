import React, { useState } from 'react';

// Groww connection settings — three auth methods, all kept in server memory only.
//   1. TOTP flow (recommended): Groww → Trading APIs → Generate TOTP token.
//      Server holds your Base32 secret and mints/refreshes the daily token itself.
//   2. API Key + Secret ("approval"): SHA-256 checksum auth; Groww may require a daily tap.
//   3. Access Token (manual): paste the daily token — expires 06:00 IST.
export default function SettingsModal({ open, onClose, mode, connectedAt, tokenSource, authMode, autoRefresh, tokenAgeMin, lastAuthError, envKeys, onConnect, onConnectKeys, onDisconnect, paper = false, onPaperChange }) {
  const [tab, setTab] = useState('totp'); // 'totp' | 'approval' | 'token'
  const [token, setToken] = useState('');
  const [totpKey, setTotpKey] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {tone, text}
  const [testOut, setTestOut] = useState(null);

  if (!open) return null;

  const clearSecrets = () => { setTotpKey(''); setTotpSecret(''); setTotpCode(''); setApiKey(''); setApiSecret(''); setToken(''); };

  const connectToken = async () => {
    setBusy(true); setMsg(null); setTestOut(null);
    const res = await onConnect(token.trim());
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'ok', text: `Connected to Groww${res.validatedVia ? ` (validated via ${res.validatedVia})` : ''}. Token kept in server memory only.` });
      clearSecrets();
    } else {
      setMsg({ tone: 'err', text: res.reason || 'Connection failed.' });
    }
  };

  const connectKeys = async (payload) => {
    setBusy(true); setMsg(null); setTestOut(null);
    const res = await onConnectKeys(payload);
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'ok', text: `Connected via ${payload.mode === 'totp' ? 'TOTP (auto)' : 'API Key + Secret'}${res.validatedVia ? ` — validated via ${res.validatedVia}` : ''}${res.autoRefresh ? ' · silent daily re-auth armed' : ''}.` });
      clearSecrets();
    } else {
      setMsg({ tone: 'err', text: res.reason || 'Connection failed.' });
    }
  };

  const connectEnv = async (envMode) => {
    // credentials already live in server env — just mint a token, no typing needed
    await connectKeys({ mode: envMode });
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

  const disconnect = async () => { await onDisconnect(); setMsg({ tone: 'ok', text: 'Disconnected. Auto-refresh stopped for this session.' }); setTestOut(null); };

  const canConnect = tab === 'totp'
    ? (totpKey.trim().length > 10 && (totpSecret.trim().length >= 16 || /^\d{6}$/.test(totpCode.trim()))) || Boolean(envKeys?.totp)
    : tab === 'approval'
      ? (apiKey.trim().length > 10 && apiSecret.trim().length >= 8) || Boolean(envKeys?.approval)
      : token.trim().length >= 20;

  const primaryAction = tab === 'totp'
    ? () => (envKeys?.totp && !totpKey.trim() ? connectEnv('totp') : connectKeys({ mode: 'totp', totpKey: totpKey.trim(), totpSecret: totpSecret.trim() || undefined, totp: totpSecret.trim() ? undefined : totpCode.trim() || undefined }))
    : tab === 'approval'
      ? () => (envKeys?.approval && !apiKey.trim() ? connectEnv('approval') : connectKeys({ mode: 'approval', apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }))
      : connectToken;

  const authLine = (() => {
    if (mode !== 'live') {
      return paper
        ? '○ PAPER SIMULATION — synthetic feed. Not the market.'
        : '○ NO FEED — Groww not connected and paper simulation is OFF. Prices show dashes; orders are disabled until you connect or re-enable paper.';
    }
    const src = authMode === 'totp' ? 'TOTP · auto' : authMode === 'approval' ? 'API Key + Secret' : authMode === 'env-token' ? 'env token (manual)' : authMode === 'manual-token' ? 'manual token' : 'token';
    const refresh = autoRefresh ? ' · silent daily re-auth on' : ' · expires 06:00 IST';
    const age = tokenAgeMin != null ? ` · token age ${tokenAgeMin >= 60 ? `${Math.floor(tokenAgeMin / 60)}h ${tokenAgeMin % 60}m` : `${tokenAgeMin}m`}` : '';
    return `● LIVE — connected via ${src}${refresh}${age}${connectedAt && tokenSource ? ` · since ${new Date(connectedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}`;
  })();

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Groww connection settings">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          Groww API Connection
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          <div className={`status-line ${mode === 'live' ? 'ok' : ''}`}>{authLine}</div>
          {lastAuthError && mode !== 'live' && <div className="status-line err">Last auth error: {lastAuthError}</div>}

          <label className="toggle-row" htmlFor="paper-sim">
            <input id="paper-sim" type="checkbox" checked={paper} onChange={e => onPaperChange?.(e.target.checked)} />
            <span className="toggle-text">
              <b>PAPER SIMULATION</b> (synthetic feed)
              <small>Off by default. When off and Groww is disconnected the desk shows dashes — never fabricated prices. Turn on to trade a simulated ₹10L with generated ticks.</small>
            </span>
          </label>

          <div className="auth-tabs" role="tablist" aria-label="Auth method">
            {[['totp', 'TOTP · Auto', 'recommended'], ['approval', 'API Key + Secret', 'daily tap'], ['token', 'Access Token', 'manual']].map(([id, label, hint]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`auth-tab${tab === id ? ' active' : ''}`} onClick={() => { setTab(id); setMsg(null); setTestOut(null); }}>
                <b>{label}</b><small>{hint}</small>
              </button>
            ))}
          </div>

          {tab === 'totp' && (
            <div className="auth-pane" role="tabpanel">
              <div className="auth-steps">Groww → <b>Settings</b> → <b>Trading APIs</b> → <b>Generate API key ▾</b> → <b>Generate TOTP token</b>. Copy the long <b>TOTP token</b> (JWT) and the Base32 <b>TOTP secret</b>.</div>
              <div className="field">
                <label htmlFor="totp-key">TOTP Key (long token)</label>
                <input id="totp-key" type="password" autoComplete="off" spellCheck="false" placeholder="eyJraWQiOi…" value={totpKey} onChange={e => setTotpKey(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="totp-secret">TOTP Secret (Base32) — enables silent daily re-auth</label>
                <input id="totp-secret" type="password" autoComplete="off" spellCheck="false" placeholder="UG3XTATB22XLH5SG… (kept in server memory only)" value={totpSecret} onChange={e => setTotpSecret(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="totp-code">…or current 6-digit code (one-shot, no auto re-auth)</label>
                <input id="totp-code" type="text" inputMode="numeric" autoComplete="one-time-code" spellCheck="false" maxLength={6} placeholder="123456" value={totpCode} onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              </div>
              {envKeys?.totp && <div className="env-chip">Server env has <b>GROWW_TOTP_KEY</b> + <b>GROWW_TOTP_SECRET</b> — you can connect without typing.</div>}
            </div>
          )}

          {tab === 'approval' && (
            <div className="auth-pane" role="tabpanel">
              <div className="auth-steps">Groww → <b>Settings</b> → <b>Trading APIs</b> → <b>Generate API key</b>. Copy the <b>API Key</b> and <b>API Secret</b>. The server computes <code>SHA-256(secret + timestamp)</code> and swaps it for the daily token. <b>Note:</b> Groww may require tapping “Approve” on that page each day.</div>
              <div className="field">
                <label htmlFor="api-key">API Key</label>
                <input id="api-key" type="password" autoComplete="off" spellCheck="false" placeholder="eyJraWQiOi…" value={apiKey} onChange={e => setApiKey(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="api-secret">API Secret</label>
                <input id="api-secret" type="password" autoComplete="off" spellCheck="false" placeholder="… (kept in server memory only)" value={apiSecret} onChange={e => setApiSecret(e.target.value)} />
              </div>
              {envKeys?.approval && <div className="env-chip">Server env has <b>GROWW_API_KEY</b> + <b>GROWW_API_SECRET</b> — you can connect without typing.</div>}
            </div>
          )}

          {tab === 'token' && (
            <div className="auth-pane" role="tabpanel">
              <div className="auth-steps">Groww → <b>Settings</b> → <b>Trading APIs</b> → <b>Generate API keys</b> → <b>Access Token</b>. Expires <b>06:00 IST daily</b> — expect to re-paste each morning.</div>
              <div className="field">
                <label htmlFor="groww-token">Access Token</label>
                <input id="groww-token" type="password" autoComplete="off" spellCheck="false" placeholder="eyJhbGciOi… (never leaves this server)" value={token} onChange={e => setToken(e.target.value)} />
              </div>
            </div>
          )}

          {msg && <div className={`status-line ${msg.tone === 'ok' ? 'ok' : 'err'}`}>{msg.text}</div>}
          {testOut && <pre className="status-line" style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{testOut}</pre>}
          <div className="dim" style={{ fontSize: 9.5 }}>
            Secrets and tokens are sent only to this local server, held in <b>memory</b>, never logged, never written to disk, and lost on restart. Nothing is persisted in the browser (localStorage stores nothing secret).
          </div>
        </div>
        <div className="modal-foot">
          {mode === 'live'
            ? <button className="ghost-btn" onClick={disconnect}>Disconnect</button>
            : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            {mode === 'live' && <button className="ghost-btn" onClick={testProxy}>Test: holdings</button>}
            <button className="ghost-btn" onClick={onClose}>Close</button>
            <button className="primary-btn" disabled={busy || !canConnect} onClick={primaryAction}>
              {busy ? 'Validating…' : tab === 'token' ? 'Connect' : 'Generate & Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
