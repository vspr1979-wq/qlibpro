import React from 'react';

// THE SPECTROGRAM — instruments × timeframes AI-confidence heatmap.
// Click any cell to chart that symbol on that timeframe.
export default function Heatmap({ matrix, selectedSymbol, onPick }) {
  return (
    <div className="spec-wrap" role="grid" aria-label="Signal confidence heatmap">
      <div className="spec-grid">
        <div className="spec-corner">SYM ↓ · TF →</div>
        {matrix[0]?.cells.map(c => <div key={c.tf} className="spec-tf">{c.tf}</div>)}
        {matrix.map(row => (
          <React.Fragment key={row.symbol}>
            <button
              className={`spec-sym${row.symbol === selectedSymbol ? ' selected' : ''}`}
              onClick={() => onPick(row.symbol, null)}
              title={`Chart ${row.symbol}`}
            >
              {row.symbol}
            </button>
            {row.cells.map(cell => {
              const t = Math.min(1, Math.max(0, (cell.confidence - 35) / 62));
              const hue = t * 125; // 0 red → 125 green
              const isSel = row.symbol === selectedSymbol;
              return (
                <button
                  key={cell.tf}
                  role="gridcell"
                  className={`spec-cell${isSel ? ' selected' : ''}`}
                  style={{ background: `hsl(${hue} 62% 38%)` }}
                  title={`${row.symbol} ${cell.tf} · ${cell.action} · ${cell.confidence}% conf`}
                  onClick={() => onPick(row.symbol, cell.tf)}
                >
                  {cell.confidence}
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
