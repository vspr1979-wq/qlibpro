import React, { useEffect, useRef, useState } from 'react';
import { engine } from '../liveFeed.js';
import { formatNumberIN } from '../paper.js';

function Sparkline({ symbol, positive }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 74, h = 24;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const data = engine.sparkline(symbol, 30);
    if (!data || data.length < 2) { ctx.clearRect(0, 0, w, h); return; }
    const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / range) * (h - 4);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = positive ? '#15803d' : '#dc2626';
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }); // redraw each tick
  return <canvas ref={ref} style={{ width: 74, height: 24 }} />;
}

export default function Watchlist({ stocks, indices, selected, onSelect }) {
  const [tab, setTab] = useState('stocks');
  const [query, setQuery] = useState('');
  const source = tab === 'stocks' ? stocks : indices;
  const q = query.trim().toUpperCase();
  const rows = q
    ? source.filter(s => s.symbol.includes(q) || s.name.toUpperCase().includes(q) || s.sector.toUpperCase().includes(q))
    : source;

  return (
    <div className="panel watchlist">
      <div className="panel-title">
        The Board <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· watchlist</span>
        <span className="spacer" />
        <span className="chip">SIM FEED</span>
      </div>
      <div className="wl-controls">
        <input
          className="wl-search"
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search symbol, name, sector…"
          aria-label="Search instruments"
        />
        <div className="wl-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'stocks'} className={`wl-tab${tab === 'stocks' ? ' active' : ''}`} onClick={() => setTab('stocks')}>STOCKS {stocks.length}</button>
          <button role="tab" aria-selected={tab === 'indices'} className={`wl-tab${tab === 'indices' ? ' active' : ''}`} onClick={() => setTab('indices')}>INDICES {indices.length}</button>
        </div>
      </div>
      <div className="wl-list">
        {rows.length === 0 && <div className="empty-state">No matches for “{query}”.</div>}
        {rows.map((s) => {
          const ch = s.ltp == null ? null : engine.change(s.symbol);
          const up = (ch?.chg ?? 0) >= 0;
          return (
            <button
              key={s.symbol}
              className={`wl-row${selected === s.symbol ? ' selected' : ''}`}
              onClick={() => onSelect(s.symbol)}
              title={`${s.name} · ${s.exchange}`}
            >
              <span>
                <span className="wl-sym">{s.symbol}{s.type !== 'stock' && <em className="wl-idx-tag">{s.type === 'vix' ? 'VOL' : 'IDX'}</em>}</span>
                <span className="wl-name" style={{ display: 'block' }}>{s.name} · {s.exchange}</span>
              </span>
              <span className="wl-spark"><Sparkline symbol={s.symbol} positive={up} /></span>
              <span>
                <span className="wl-ltp">{s.ltp == null ? '—' : formatNumberIN(s.ltp)}</span>
                <span className={`wl-chg ${ch ? (up ? 'pos' : 'neg') : 'dim'}`} style={{ display: 'block' }}>
                  {ch ? `${up ? '▲' : '▼'} ${Math.abs(ch.pct).toFixed(2)}%` : 'awaiting Groww'}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
