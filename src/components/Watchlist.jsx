import React, { useEffect, useRef } from 'react';
import { engine } from '../marketSim.js';
import { formatNumberIN } from '../paper.js';

function Sparkline({ symbol, positive }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 78, h = 26;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const data = engine.sparkline(symbol, 30);
    const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = positive ? '#2ebd85' : '#f6465d';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    // last point dot
    const lastX = w - 1, lastY = h - 2 - ((data[data.length - 1] - min) / range) * (h - 4);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.arc(lastX - 1, lastY, 1.6, 0, Math.PI * 2); ctx.fill();
  }); // redraw every render (tick)
  return <canvas ref={ref} style={{ width: 78, height: 26 }} />;
}

export default function Watchlist({ symbols, selected, onSelect, tick }) {
  return (
    <div className="panel watchlist">
      <div className="panel-title">
        Watchlist <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· NSE F&O</span>
        <span className="spacer" />
        <span className="chip">SIM FEED</span>
      </div>
      <div className="wl-list">
        {symbols.map((s) => {
          const { chg, pct } = engine.change(s.symbol);
          const up = chg >= 0;
          return (
            <button
              key={s.symbol}
              className={`wl-row${selected === s.symbol ? ' selected' : ''}`}
              onClick={() => onSelect(s.symbol)}
              title={`${s.name} · NSE`}
            >
              <span>
                <span className="wl-sym">{s.symbol}</span>
                <span className="wl-name" style={{ display: 'block' }}>{s.name}</span>
              </span>
              <span className="wl-spark"><Sparkline symbol={s.symbol} positive={up} /></span>
              <span>
                <span className="wl-ltp">{formatNumberIN(s.ltp)}</span>
                <span className={`wl-chg ${up ? 'pos' : 'neg'}`} style={{ display: 'block' }}>
                  {up ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
