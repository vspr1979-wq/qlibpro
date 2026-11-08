import React, { useEffect, useMemo, useState } from 'react';
import { engine } from '../marketSim.js';
import { estimateCharges, formatINR, MAX_ORDER_NOTIONAL, MAX_QTY } from '../paper.js';

export default function OrderTicket({ symbol, symbolType = 'stock', mode, halted, onPlace }) {
  const [side, setSide] = useState('BUY');
  const [qty, setQty] = useState(25);
  const [orderType, setOrderType] = useState('MARKET');
  const [product, setProduct] = useState('CNC');
  const [limitPrice, setLimitPrice] = useState('');
  const [error, setError] = useState('');
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    const ltp = engine.get(symbol)?.ltp ?? 0;
    setLimitPrice(ltp ? ltp.toFixed(2) : '');
    setError('');
  }, [symbol]);

  const s = engine.get(symbol);
  const ltp = s?.ltp ?? 0;
  const execPrice = orderType === 'LIMIT' && Number(limitPrice) > 0 ? Number(limitPrice) : ltp;
  const estValue = execPrice * qty;
  const charges = useMemo(() => estimateCharges(side, qty || 0, execPrice || 0, product), [side, qty, execPrice, product]);

  const isLive = mode === 'live';
  const isIndex = symbolType !== 'stock';
  const indexLiveBlocked = isLive && isIndex;
  const notionalOk = estValue <= MAX_ORDER_NOTIONAL;
  const qtyOk = Number.isFinite(qty) && qty >= 1 && qty <= MAX_QTY;
  const canPlace = !halted && !placing && qtyOk && notionalOk && execPrice > 0 && !indexLiveBlocked;

  const submit = async () => {
    setError('');
    if (!qtyOk) { setError(`Quantity must be between 1 and ${MAX_QTY.toLocaleString('en-IN')}.`); return; }
    if (!notionalOk) { setError(`Order value exceeds the ₹${MAX_ORDER_NOTIONAL.toLocaleString('en-IN')} per-order guard.`); return; }
    if (orderType === 'LIMIT' && !(Number(limitPrice) > 0)) { setError('Enter a valid limit price.'); return; }
    setPlacing(true);
    const res = await onPlace({ side, symbol, qty: Math.floor(qty), orderType, product, price: orderType === 'LIMIT' ? Number(limitPrice) : undefined, clientPrice: execPrice });
    setPlacing(false);
    if (res && res.ok === false) setError(res.reason || 'Order rejected.');
  };

  return (
    <div className="panel ticket">
      <div className="panel-title">
        Order Ticket <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {symbol}</span>
        <span className="spacer" />
        <span className="chip" style={{ color: isLive ? 'var(--green)' : 'var(--amber)', borderColor: isLive ? 'rgba(21,128,61,.4)' : 'rgba(217,119,6,.4)' }}>
          {isLive ? 'LIVE · GROWW' : 'PAPER'}
        </span>
      </div>

      {halted && <div className="halt-banner" style={{ margin: '6px 8px 0' }}>TRADING HALTED — kill-switch engaged</div>}
      {isIndex && (
        <div className="index-note" style={{ margin: '6px 8px 0' }}>
          {symbolType === 'vix' ? 'INDIA VIX' : 'INDEX'} — paper fills are simulated; it is <b>not directly orderable</b> on Groww. Live execution needs {symbol === 'SENSEX' ? 'Sensex' : 'Nifty / BankNifty'} F&amp;O.
        </div>
      )}

      <div className="side-toggle">
        <button className={`side-btn buy${side === 'BUY' ? ' active' : ''}`} onClick={() => setSide('BUY')}>BUY</button>
        <button className={`side-btn sell${side === 'SELL' ? ' active' : ''}`} onClick={() => setSide('SELL')}>SELL</button>
      </div>

      <div className="ticket-body">
        <div className="ticket-row">
          <div className="field">
            <label htmlFor="qty">Qty</label>
            <div className="qty-stepper">
              <button onClick={() => setQty(q => Math.max(1, (Number(q) || 1) - 1))} aria-label="decrease qty">−</button>
              <input id="qty" type="number" min="1" value={qty} onChange={e => setQty(Number(e.target.value))} />
              <button onClick={() => setQty(q => (Number(q) || 0) + 1)} aria-label="increase qty">+</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="orderType">Type</label>
            <select id="orderType" value={orderType} onChange={e => setOrderType(e.target.value)}>
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="product">Product</label>
            <select id="product" value={product} onChange={e => setProduct(e.target.value)}>
              <option value="CNC">CNC · Delivery</option>
              <option value="MIS">MIS · Intraday</option>
            </select>
          </div>
        </div>

        {orderType === 'LIMIT' && (
          <div className="field">
            <label htmlFor="price">Limit Price (₹)</label>
            <input id="price" type="number" min="0" step="0.05" value={limitPrice} onChange={e => setLimitPrice(e.target.value)} />
          </div>
        )}

        <div className="ticket-meta">
          <span>LTP <b className="num" style={{ color: 'var(--text)' }}>₹{ltp.toFixed(2)}</b></span>
          <span>Value <b className="num" style={{ color: 'var(--text)' }}>{formatINR(estValue, { decimals: 0 })}</b></span>
          <span>Charges <b className="num" style={{ color: 'var(--text)' }}>≈{formatINR(charges.total)}</b></span>
        </div>

        {error && <div className="status-line err">{error}</div>}

        <button className={`place-btn ${side.toLowerCase()}`} disabled={!canPlace} onClick={submit}>
          {placing ? 'PLACING…' : `${side} ${symbol}`}
        </button>
        <div style={{ fontSize: 7.5, color: 'var(--dimmer)', textAlign: 'center', lineHeight: 1.5 }}>
          {indexLiveBlocked
            ? 'Blocked in LIVE — indices trade via F&O, not via direct equity order.'
            : isLive
              ? 'LIVE — routed to Groww (NSE, CASH). Double-check qty.'
              : 'Paper fill at simulated LTP ± slippage. No real order.'}
        </div>
      </div>
    </div>
  );
}
