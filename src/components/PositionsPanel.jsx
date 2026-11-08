import React from 'react';
import { engine } from '../liveFeed.js';
import { formatINR, formatSignedINR, formatNumberIN } from '../paper.js';

export default function PositionsPanel({ positions, onExit }) {
  const ltpOf = (sym) => engine.get(sym)?.ltp ?? null;
  const rows = positions.map(p => {
    const ltp = ltpOf(p.symbol);
    const dir = p.side === 'BUY' ? 1 : -1;
    const pnl = ltp == null ? null : (ltp - p.avg) * p.qty * dir;
    const pnlPct = ltp == null || p.avg <= 0 ? null : ((ltp - p.avg) / p.avg) * 100 * dir;
    return { ...p, ltp, pnl, pnlPct };
  });
  const computable = rows.filter(r => r.pnl != null);
  const totalPnl = computable.length === rows.length ? rows.reduce((s, r) => s + r.pnl, 0) : null;

  if (rows.length === 0) {
    return (
      <div className="positions">
        <div className="empty-state">
          No open positions.<br />
          Pick a symbol, hit <b style={{ color: 'var(--green)' }}>BUY</b> or <b style={{ color: 'var(--red)' }}>SELL</b> on the ticket —<br />
          paper mode fills instantly with simulated slippage.
        </div>
      </div>
    );
  }
  return (
    <div className="positions">
      <table className="pos-table">
        <thead>
          <tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>
                <div style={{ fontWeight: 700 }}>{r.symbol}</div>
                <div style={{ fontSize: 7.5, color: r.side === 'BUY' ? 'var(--green)' : 'var(--red)' }}>{r.side} · {r.product}</div>
              </td>
              <td>{r.qty}</td>
              <td>{formatNumberIN(r.avg)}</td>
              <td>{r.ltp == null ? '—' : formatNumberIN(r.ltp)}</td>
              <td>
                {r.pnl == null
                  ? <div className="dim" style={{ fontWeight: 700 }}>—</div>
                  : <>
                      <div className={r.pnl >= 0 ? 'pos' : 'neg'} style={{ fontWeight: 700 }}>{formatSignedINR(r.pnl)}</div>
                      <div style={{ fontSize: 8, color: 'var(--dimmer)' }}>{r.pnlPct >= 0 ? '+' : ''}{r.pnlPct.toFixed(2)}%</div>
                    </>}
              </td>
              <td><button className="exit-btn" onClick={() => onExit(r)}>EXIT</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderTop: '1px solid var(--border-soft)', fontFamily: 'var(--mono)', fontSize: 10 }}>
        <span className="dim">Unrealized P&amp;L</span>
        {totalPnl == null
          ? <b className="dim">awaiting Groww quotes</b>
          : <b className={totalPnl >= 0 ? 'pos' : 'neg'}>{formatSignedINR(totalPnl)}</b>}
      </div>
    </div>
  );
}
