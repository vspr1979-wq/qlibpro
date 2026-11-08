import React from 'react';
import { formatNumberIN } from '../paper.js';

// AI watchlist scan — ranked by confidence. Click a row to chart that symbol.
export default function SignalPanel({ signals, selected, onSelect }) {
  const actionable = signals.filter((s) => s.action !== 'NEUTRAL').slice(0, 6);
  return (
    <div className="panel signal-panel">
      <div className="panel-title">
        AI Signal Scan <span className="spacer" /><span className="chip">EMA 9/21 · RSI 14</span>
      </div>
      <div className="signal-list">
        {actionable.length === 0 && <div className="dim" style={{ padding: '10px 8px', fontSize: 10 }}>No high-conviction signals on the watchlist right now.</div>}
        {actionable.map((s) => (
          <button
            key={s.symbol}
            className="signal-row"
            style={{ cursor: 'pointer', width: '100%', color: 'inherit', textAlign: 'left', border: s.symbol === selected ? '1px solid var(--amber)' : undefined }}
            onClick={() => onSelect(s.symbol)}
            title={`${s.action} ${s.symbol} · EMA diff ${s.emaDiffPct}% · RSI ${s.rsi} · Target ${formatNumberIN(s.target)} · SL ${formatNumberIN(s.stop)}`}
          >
            <span className={`signal-badge ${s.action.toLowerCase()}`}>{s.action}</span>
            <span className="signal-sym">{s.symbol}</span>
            <span className="signal-conf"><div style={{ width: `${s.confidence}%` }} /></span>
            <span className="signal-pct">{s.confidence}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}
