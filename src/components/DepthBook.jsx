import React from 'react';
import { engine } from '../liveFeed.js';
import { formatNumberIN } from '../paper.js';

export default function DepthBook({ symbol, levels = 7 }) {
  const d = engine.depth(symbol, levels);
  if (!d) {
    return <div className="empty-state" style={{ padding: 16 }}>Depth unavailable — connect Groww (or enable paper mode).</div>;
  }
  const { bids, asks, spread } = d;
  const maxCum = Math.max(
    bids.length ? bids[bids.length - 1].cum : 1,
    asks.length ? asks[asks.length - 1].cum : 1,
  );
  const Row = ({ level, side }) => (
    <div className={`depth-row ${side}`}>
      <div className="depth-bar" style={{ width: `${(level.cum / maxCum) * 100}%` }} />
      <span className="depth-price" style={{ color: side === 'ask' ? 'var(--red)' : 'var(--green)' }}>
        {formatNumberIN(level.price)}
      </span>
      <span className="depth-qty">{level.qty.toLocaleString('en-IN')}</span>
      <span className="depth-cum">{level.cum.toLocaleString('en-IN')}</span>
    </div>
  );
  return (
    <div className="depth">
      <div className="depth-row depth-head">
        <span>PRICE</span><span style={{ textAlign: 'right' }}>QTY</span><span style={{ textAlign: 'right' }}>CUM</span>
      </div>
      {asks.map((l, i) => <Row key={`a${i}`} level={l} side="ask" />)}
      <div className="depth-spread"><span>SPREAD</span><span>₹{formatNumberIN(spread)}</span></div>
      {bids.map((l, i) => <Row key={`b${i}`} level={l} side="bid" />)}
    </div>
  );
}
