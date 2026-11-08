import React from 'react';
import { formatNumberIN } from '../paper.js';

export default function TickerTape({ items }) {
  const doubled = [...items, ...items];
  return (
    <div className="tape" aria-hidden="true">
      <div className="tape-inner">
        {doubled.map((t, i) => (
          <span className="tape-item" key={t.symbol + i}>
            <span className="tape-sym">{t.symbol}</span>
            <span className="tape-val num">{formatNumberIN(t.value, t.kind === 'fx' ? 2 : 2)}</span>
            <span className={`tape-chg num ${t.chg >= 0 ? 'pos' : 'neg'}`}>
              {t.chg >= 0 ? '▲' : '▼'} {Math.abs(t.chg).toFixed(2)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
