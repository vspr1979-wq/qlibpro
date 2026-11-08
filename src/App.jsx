import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine, nseOpenNow } from './marketSim.js';
import { scanWatchlist } from './strategy.js';
import {
  INITIAL_CAPITAL, DAILY_LOSS_LIMIT, estimateCharges, formatINR, formatSignedINR,
  store, applyFillToPositions,
} from './paper.js';
import TickerTape from './components/TickerTape.jsx';
import Watchlist from './components/Watchlist.jsx';
import CandleChart from './components/CandleChart.jsx';
import EquityCurve from './components/EquityCurve.jsx';
import SignalPanel from './components/SignalPanel.jsx';
import DepthBook from './components/DepthBook.jsx';
import PositionsPanel from './components/PositionsPanel.jsx';
import OrderTicket from './components/OrderTicket.jsx';
import Toasts from './components/Toasts.jsx';
import SettingsModal from './components/SettingsModal.jsx';

const istDateStr = () => new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
const istTimeStr = () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function App() {
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState('RELIANCE');
  const [tf, setTf] = useState('5m');
  const [tab, setTab] = useState('depth');
  const [positions, setPositions] = useState(() => store.loadPositions());
  const [orders, setOrders] = useState(() => store.loadOrders());
  const [equity, setEquity] = useState(() => store.loadEquity());
  const [toasts, setToasts] = useState([]);
  const [halted, setHalted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState('paper');
  const [growwStatus, setGrowwStatus] = useState(null);
  const autoHaltRef = useRef(false);
  const welcomedRef = useRef(false);

  // ── live tick loop (simulated feed) ─────────────────────────────
  useEffect(() => {
    const id = setInterval(() => { engine.tick(); setTick(t => t + 1); }, 900);
    return () => clearInterval(id);
  }, []);

  // ── Groww status polling ────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/groww/status');
      const j = await r.json();
      setGrowwStatus(j);
      setMode(j?.mode === 'live' ? 'live' : 'paper');
    } catch {
      setGrowwStatus(null); setMode('paper');
    }
  }, []);
  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // ── persistence ─────────────────────────────────────────────────
  useEffect(() => { store.savePositions(positions); }, [positions]);
  useEffect(() => { store.saveOrders(orders); }, [orders]);

  const pushToast = useCallback((tone, title, detail) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts(prev => [...prev.slice(-2), { id, tone, title, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    if (welcomedRef.current) return;
    welcomedRef.current = true;
    pushToast('warn', 'PAPER MODE · SIMULATED FEED', 'Explore the desk freely — place paper orders. Connect Groww in Settings for live NSE order routing.');
  }, [pushToast]);

  // ── derived market data ─────────────────────────────────────────
  const listRef = useRef(null);
  if (!listRef.current) listRef.current = engine.list();
  const watchlist = listRef.current.map(s => ({ ...s, ltp: engine.get(s.symbol).ltp })); // fresh LTPs each render
  const candleBucket = Math.floor(tick / 6); // refresh anchored candles every ~5.4s
  const candles = useMemo(() => engine.candles(selected, tf, 160), [selected, tf, candleBucket]);
  const signals = useMemo(() => {
    const bySymbol = {};
    for (const s of listRef.current) bySymbol[s.symbol] = engine.candles(s.symbol, '5m', 120);
    return scanWatchlist(bySymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleBucket]);
  const selectedSignal = signals.find(s => s.symbol === selected) || null;
  const tapeItems = useMemo(() => engine.tape(), [tick]);
  const breadth = engine.breadth;
  const vix = tapeItems.find(t => t.symbol === 'INDIA VIX');
  const advTotal = breadth.advancing + breadth.declining;
  const advPct = (breadth.advancing / advTotal) * 100;

  // ── paper ledger math ───────────────────────────────────────────
  const ltpOf = useCallback((sym) => engine.get(sym)?.ltp ?? 0, []);
  const unrealized = positions.reduce((sum, p) => {
    const dir = p.side === 'BUY' ? 1 : -1;
    return sum + (ltpOf(p.symbol) - p.avg) * p.qty * dir;
  }, 0);
  const closedOrders = orders.filter(o => o.type === 'close');
  const realized = closedOrders.reduce((s, o) => s + (o.pnl || 0), 0);
  const totalCharges = orders.reduce((s, o) => s + (o.charges || 0), 0);
  const wins = closedOrders.filter(o => (o.pnl || 0) >= 0).length;
  const winRate = closedOrders.length ? Math.round((wins / closedOrders.length) * 100) : null;
  const sessionPnl = realized + unrealized;
  const ordersToday = orders.filter(o => new Date(o.ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) === istDateStr()).length;

  // paper equity curve (session)
  useEffect(() => {
    const total = INITIAL_CAPITAL + sessionPnl;
    setEquity(prev => {
      const lastVal = prev[prev.length - 1];
      if (lastVal !== undefined && Math.abs(lastVal - total) < 0.5) return prev;
      return [...prev, total].slice(-240);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.round(sessionPnl), tick]);
  useEffect(() => { store.saveEquity(equity); }, [equity]);

  // daily-loss kill switch
  useEffect(() => {
    if (!autoHaltRef.current && sessionPnl <= -DAILY_LOSS_LIMIT) {
      autoHaltRef.current = true;
      setHalted(true);
      pushToast('error', 'DAILY LOSS LIMIT BREACHED', `Session P&L ${formatSignedINR(sessionPnl)} — HALT engaged automatically. Review positions.`);
    }
  }, [sessionPnl, pushToast]);

  // ── order placement ─────────────────────────────────────────────
  const placeOrder = useCallback(async ({ side, symbol, qty, orderType, product, price, clientPrice }) => {
    if (halted) return { ok: false, reason: 'Trading is halted (kill-switch).' };
    let res;
    try {
      const r = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, symbol, qty, orderType, product, price, clientPrice }),
      });
      res = await r.json();
    } catch (e) {
      res = { ok: false, reason: `Server unreachable: ${e.message}` };
    }
    if (!res.ok) {
      pushToast('error', 'ORDER REJECTED', res.reason || 'Unknown error');
      return res;
    }
    const fillPrice = res.mode === 'paper'
      ? res.paperFill.price
      : Number(res?.groww?.average_fill_price ?? res?.groww?.price) || clientPrice;
    const charges = estimateCharges(side, qty, fillPrice, product);
    const fill = applyFillToPositions(positions, { symbol, side, qty, price: fillPrice, product });
    setPositions(fill.positions);
    setOrders(prev => [...prev, {
      id: res.orderRef, ts: Date.now(), type: fill.realized !== 0 || fill.closed ? 'close' : 'open',
      symbol, side, qty, price: fillPrice, product, orderType,
      charges: charges.total, pnl: fill.realized, mode: res.mode,
    }]);
    pushToast(
      res.mode === 'paper' ? 'ok' : 'ok',
      `${res.mode === 'paper' ? 'PAPER' : 'GROWW LIVE'} ${side} · ${qty} × ${symbol}`,
      `Fill @ ₹${Number(fillPrice).toFixed(2)} · ref ${res.orderRef} · charges ≈${formatINR(charges.total)}`,
    );
    return res;
  }, [halted, positions, pushToast]);

  const exitPosition = useCallback((pos) => {
    const side = pos.side === 'BUY' ? 'SELL' : 'BUY';
    placeOrder({ side, symbol: pos.symbol, qty: pos.qty, orderType: 'MARKET', product: pos.product, clientPrice: engine.get(pos.symbol)?.ltp });
  }, [placeOrder]);

  const toggleHalt = () => {
    setHalted(h => {
      const next = !h;
      pushToast(next ? 'error' : 'ok', next ? 'KILL SWITCH ENGAGED' : 'TRADING RESUMED', next ? 'All order placement disabled. Click again to resume.' : 'Order placement enabled.');
      return next;
    });
  };

  const resetPaper = () => {
    store.clearAll();
    setPositions([]); setOrders([]); setEquity([INITIAL_CAPITAL]);
    autoHaltRef.current = false; setHalted(false);
    pushToast('ok', 'PAPER LEDGER RESET', 'Positions, orders, equity curve and realized P&L cleared.');
  };

  const connectGroww = useCallback(async (token) => {
    if (!token || token.length < 20) return { ok: false, reason: 'Paste the full access token (min 20 characters).' };
    try {
      const r = await fetch('/api/groww/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const j = await r.json();
      await fetchStatus();
      if (j.ok) pushToast('ok', 'GROWW CONNECTED', 'Live routing enabled. Data feed remains simulated until P1.');
      return j;
    } catch (e) {
      return { ok: false, reason: `Request failed: ${e.message}` };
    }
  }, [fetchStatus, pushToast]);

  const disconnectGroww = useCallback(async () => {
    try { await fetch('/api/groww/disconnect', { method: 'POST' }); } catch { /* ignore */ }
    await fetchStatus();
  }, [fetchStatus]);

  // ── render ──────────────────────────────────────────────────────
  const isOpen = nseOpenNow();
  const latency = Math.round(9 + Math.abs(Math.sin(tick / 3)) * 7);
  const vixItem = vix;

  return (
    <div className={`app${halted ? ' halted' : ''}`}>
      {/* ── HEADER ─────────────────────────────────────────── */}
      <header className="header">
        <div className="brand">
          <div className="brand-badge" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 32 32" fill="none">
              <path d="M4 22 L13 13 L18 17 L28 6" stroke="#f0b90b" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="28" cy="6" r="2.6" fill="#2ebd85" />
            </svg>
          </div>
          <div>
            <div className="brand-name">QLIB<b>PRO</b></div>
            <div className="brand-sub">Indian Algo Desk</div>
          </div>
        </div>

        <div className="session-chip" title="NSE session (IST 09:15–15:30, Mon–Fri). Feed is simulated regardless of session state.">
          <span className={`session-dot ${isOpen ? 'open' : 'closed'}`} />
          NSE {isOpen ? 'OPEN' : 'CLOSED'}
        </div>

        <div className={`mode-badge ${mode === 'live' ? 'live' : 'paper'}`} title={growwStatus?.tokenExpiryNote || ''}>
          <span className="mode-dot" />
          {mode === 'live' ? 'GROWW LIVE' : 'PAPER TRADING'}
        </div>

        <div className="header-spacer" />

        <div className="ist-clock num">{istTimeStr()}<small>IST · {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}</small></div>

        <button className={`halt-btn${halted ? ' halted' : ''}`} onClick={toggleHalt} title="Kill switch — disable/enable all order placement">
          {halted ? 'HALTED' : 'HALT'}
        </button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Groww API settings" aria-label="Settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.65a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.24.6.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
          </svg>
        </button>
      </header>

      {halted && <div className="halted-strip">KILL SWITCH ENGAGED — ORDER PLACEMENT DISABLED</div>}

      {/* ── TICKER TAPE ────────────────────────────────────── */}
      <TickerTape items={tapeItems} />

      {/* ── MAIN GRID ──────────────────────────────────────── */}
      <main className="main">
        {/* left rail */}
        <section className="col">
          <Watchlist symbols={watchlist} selected={selected} onSelect={setSelected} tick={tick} />
          <div className="panel breadth">
            <div className="panel-title" style={{ padding: '0 0 6px', borderBottom: 'none' }}>Market Breadth <span className="spacer" /><span className="chip">NSE</span></div>
            <div className="breadth-bar" role="img" aria-label={`Advancing ${breadth.advancing}, declining ${breadth.declining}`}>
              <div className="breadth-adv" style={{ width: `${advPct}%` }} />
              <div className="breadth-dec" style={{ width: `${100 - advPct}%` }} />
            </div>
            <div className="breadth-meta">
              <span className="pos">▲ {breadth.advancing.toLocaleString('en-IN')} advancing</span>
              <span className="neg">▼ {breadth.declining.toLocaleString('en-IN')} declining</span>
            </div>
            <div className="breadth-grid">
              <div className="mini-stat"><label>India VIX</label><b className={vixItem && vixItem.chg <= 0 ? 'pos' : 'neg'}>{vixItem ? vixItem.value.toFixed(2) : '—'}</b></div>
              <div className="mini-stat"><label>PCR (OI)</label><b style={{ color: breadth.pcr >= 1 ? 'var(--green)' : 'var(--amber)' }}>{breadth.pcr.toFixed(2)}</b></div>
              <div className="mini-stat"><label>Unchanged</label><b>{breadth.unchanged.toLocaleString('en-IN')}</b></div>
            </div>
          </div>
        </section>

        {/* center */}
        <section className="col">
          <CandleChart
            symbol={selected}
            symbolName={engine.get(selected)?.name}
            candles={candles}
            tf={tf}
            onTfChange={setTf}
            tick={tick}
            signal={selectedSignal}
          />
          <div className="panel equity-strip">
            <EquityCurve equity={equity} signal={selectedSignal} selected={selected} />
            <div className="equity-stats">
              <div className="eq-stat">
                <label>Realized P&amp;L</label>
                <b className={realized >= 0 ? 'pos' : 'neg'}>{formatSignedINR(realized)}</b>
                <small>{closedOrders.length} closed trade{closedOrders.length === 1 ? '' : 's'}</small>
              </div>
              <div className="eq-stat">
                <label>Unrealized P&amp;L</label>
                <b className={unrealized >= 0 ? 'pos' : 'neg'}>{formatSignedINR(unrealized)}</b>
                <small>{positions.length} open position{positions.length === 1 ? '' : 's'}</small>
              </div>
              <div className="eq-stat">
                <label>Win Rate</label>
                <b>{winRate === null ? '—' : `${winRate}%`}</b>
                <small>{wins}/{closedOrders.length || 0} wins · session</small>
              </div>
              <div className="eq-stat">
                <label>Est. Charges</label>
                <b>{formatINR(totalCharges)}</b>
                <small>brokerage + STT + txn + GST + stamp</small>
              </div>
            </div>
          </div>
        </section>

        {/* right rail */}
        <section className="col">
          <SignalPanel signals={signals} selected={selected} onSelect={setSelected} />
          <div className="panel rail-tabs">
            <div className="tab-bar" role="tablist">
              <button role="tab" aria-selected={tab === 'depth'} className={`tab-btn${tab === 'depth' ? ' active' : ''}`} onClick={() => setTab('depth')}>Depth</button>
              <button role="tab" aria-selected={tab === 'positions'} className={`tab-btn${tab === 'positions' ? ' active' : ''}`} onClick={() => setTab('positions')}>Positions{positions.length ? ` (${positions.length})` : ''}</button>
            </div>
            {tab === 'depth'
              ? <DepthBook symbol={selected} tick={tick} />
              : <PositionsPanel positions={positions} onExit={exitPosition} />}
          </div>
          <OrderTicket symbol={selected} mode={mode} halted={halted} onPlace={placeOrder} />
        </section>
      </main>

      {/* ── STATUS BAR ─────────────────────────────────────── */}
      <footer className="statusbar">
        <span>QLIBPRO <b>v0.1-draft</b></span>
        <span>FEED <b>{mode === 'live' ? 'GROWW ORDERS · SIM DATA' : 'SIMULATED'}</b></span>
        <span>ORDERS TODAY <b>{ordersToday}</b></span>
        <span>LATENCY <b>~{latency}ms</b></span>
        <span>GROWW <b>{mode === 'live' ? 'CONNECTED' : 'PAPER ONLY'}</b></span>
        <span className="spacer" />
        <button className="ghost-btn" style={{ padding: '2px 10px', fontSize: 8.5, letterSpacing: '.1em' }} onClick={resetPaper} title="Clear paper positions, orders and equity curve">RESET PAPER</button>
        <span>Not investment advice · F&amp;O involves risk</span>
      </footer>

      <Toasts toasts={toasts} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mode={mode}
        connectedAt={growwStatus?.connectedAt}
        tokenSource={growwStatus?.tokenSource}
        onConnect={connectGroww}
        onDisconnect={disconnectGroww}
      />
    </div>
  );
}
