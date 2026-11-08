import React from 'react';
import { formatNumberIN } from '../paper.js';

// THE CLOSER — the desk's final-decision module for the selected symbol:
// action, confidence, entry / target / stop, plus next-best watchlist signals.
export default function CloserPanel({ signal, ltp, others, onSelect }) {
  if (!signal) return <div className="panel closer-panel"><div className="panel-title">The Closer</div><div className="empty-state">Awaiting first scan…</div></div>;
  const isBuy = signal.action === 'BUY';
  const isSell = signal.action === 'SELL';
  const actionable = signal.action !== 'NEUTRAL';
  const risk = Math.abs(ltp - signal.stop);
  const reward = Math.abs(signal.target - ltp);
  const rr = risk > 0 ? (reward / risk).toFixed(1) : '—';

  return (
    <div className="panel closer-panel">
      <div className="panel-title">The Closer <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· final decision</span><span className="spacer" /><span className="chip">{signal.crossed}</span></div>
      <div className="closer-body">
        <div className="closer-main">
          <div className={`closer-action ${isBuy ? 'buy' : isSell ? 'sell' : 'flat'}`}>{signal.action}</div>
          <div className="closer-conf">
            <div className="closer-conf-head"><span>CONFIDENCE</span><b className="num">{signal.confidence}%</b></div>
            <div className="big-conf"><div className={isSell ? 'fill sell' : 'fill'} style={{ width: `${signal.confidence}%` }} /></div>
            <div className="closer-rr">R:R <b className="num">1 : {rr}</b> · EMA9/21 <b className="num">{signal.emaDiffPct >= 0 ? '+' : ''}{signal.emaDiffPct}%</b> · RSI <b className="num">{signal.rsi}</b></div>
          </div>
        </div>
        <div className="level-rows">
          <div className="level-row"><span>ENTRY</span><b className="num">₹{formatNumberIN(ltp)}</b><i /></div>
          <div className="level-row tgt"><span>TARGET</span><b className="num pos">₹{formatNumberIN(signal.target)}</b><i>+{(((signal.target - ltp) / ltp) * 100).toFixed(2)}%</i></div>
          <div className="level-row stp"><span>STOP-LOSS</span><b className="num neg">₹{formatNumberIN(signal.stop)}</b><i>{(((signal.stop - ltp) / ltp) * 100).toFixed(2)}%</i></div>
        </div>
        {others.length > 0 && (
          <div className="also-watching">
            <div className="also-label">ALSO WATCHING</div>
            {others.map(s => (
              <button key={s.symbol} className="also-row" onClick={() => onSelect(s.symbol)}>
                <span className={`signal-badge ${s.action.toLowerCase()}`}>{s.action}</span>
                <span className="also-sym">{s.symbol}</span>
                <span className="also-bar"><div style={{ width: `${s.confidence}%` }} /></span>
                <span className="also-pct num">{s.confidence}%</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
