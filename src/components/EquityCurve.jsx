import React, { useEffect, useRef } from 'react';
import { INITIAL_CAPITAL, formatINR } from '../paper.js';

export default function EquityCurve({ equity, signal, selected }) {
  const canvasRef = useRef(null);
  const current = equity[equity.length - 1] ?? INITIAL_CAPITAL;
  const pnl = current - INITIAL_CAPITAL;
  const up = pnl >= 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const h = canvas.clientHeight || 90;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const data = equity.length > 1 ? equity : [INITIAL_CAPITAL, INITIAL_CAPITAL];
    let min = Math.min(...data, INITIAL_CAPITAL);
    let max = Math.max(...data, INITIAL_CAPITAL);
    const pad = (max - min || 1000) * 0.12;
    min -= pad; max += pad;
    const x = i => (i / (data.length - 1)) * (w - 8) + 4;
    const y = v => h - 6 - ((v - min) / (max - min)) * (h - 26);

    // gridlines
    ctx.strokeStyle = 'rgba(28,38,60,0.55)';
    ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const gy = (h / 4) * g;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }
    // baseline (initial capital)
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(139,149,167,0.6)';
    ctx.beginPath(); ctx.moveTo(0, y(INITIAL_CAPITAL)); ctx.lineTo(w, y(INITIAL_CAPITAL)); ctx.stroke();
    ctx.setLineDash([]);

    // area
    const line = up ? '#2ebd85' : '#f6465d';
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? 'rgba(46,189,133,0.35)' : 'rgba(246,70,93,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    data.forEach((v, i) => { i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)); });
    ctx.lineTo(x(data.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    // stroke line
    ctx.beginPath();
    data.forEach((v, i) => { i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)); });
    ctx.strokeStyle = line; ctx.lineWidth = 1.6; ctx.stroke();
  }); // every render

  return (
    <>
      <div className="equity-canvas-wrap">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
          <label style={{ fontSize: 8, color: 'var(--dimmer)', letterSpacing: '.14em', textTransform: 'uppercase' }}>Paper Equity</label>
          <span className={`num ${up ? 'pos' : 'neg'}`} style={{ fontSize: 12, fontWeight: 800 }}>
            {formatINR(current, { decimals: 0 })} <small style={{ fontSize: 9 }}>({up ? '+' : ''}{((pnl / INITIAL_CAPITAL) * 100).toFixed(2)}%)</small>
          </span>
        </div>
        <canvas ref={canvasRef} style={{ flex: 1, minHeight: 0, width: '100%' }} />
        {signal && (
          <div className="num" style={{ fontSize: 8, color: 'var(--dim)', paddingTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <b style={{ color: 'var(--amber)' }}>{selected}</b> · {signal.crossed} · EMA9/21 {signal.emaDiffPct >= 0 ? '+' : ''}{signal.emaDiffPct}% · RSI {signal.rsi} · {signal.action} {signal.confidence}%
          </div>
        )}
      </div>
    </>
  );
}
