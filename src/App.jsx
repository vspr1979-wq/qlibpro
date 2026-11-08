import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine, nseOpenNow, INSTRUMENTS, INDICES } from './marketSim.js';
import { scanWatchlist, scanSymbol } from './strategy.js';
import {
  INITIAL_CAPITAL, DAILY_LOSS_LIMIT, estimateCharges, formatINR, formatSignedINR, formatNumberIN,
  store, applyFillToPositions,
} from './paper.js';
import Watchlist from './components/Watchlist.jsx';
import CandleChart from './components/CandleChart.jsx';
import EquitySpark from './components/EquitySpark.jsx';
import PnlBars from './components/PnlBars.jsx';
import OrbitGlobe from './components/OrbitGlobe.jsx';
import CloserPanel from './components/CloserPanel.jsx';
import DistributionChart from './components/DistributionChart.jsx';
import Heatmap from './components/Heatmap.jsx';
import DepthBook from './components/DepthBook.jsx';
import PositionsPanel from './components/PositionsPanel.jsx';
import OrderTicket from './components/OrderTicket.jsx';
import TapeFeed from './components/TapeFeed.jsx';
import Toasts from './components/Toasts.jsx';
import SettingsModal from './components/SettingsModal.jsx';

const istDateStr = () => new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
const istTimeStr = () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const istDateLong = () => new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const TF_LIST = ['1m', '5m', '15m', '1H', '1D'];

export default function App() {
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState('NIFTY50');
  const [tf, setTf] = useState('5m');
  const [tab, setTab] = useState('tape');
  const [positions, setPositions] = useState(() => store.loadPositions());
  const [orders, setOrders] = useState(() => store.loadOrders());
  const [equity, setEquity] = useState(() => store.loadEquity());
  const [events, setEvents] = useState([
    { id: 'ev-boot', ts: Date.now(), text: 'QLIBPRO DESK online · PAPER mode · simulated feed', tone: 'dim' },
  ]);
  const [toasts, setToasts] = useState([]);
  const [halted, setHalted] = useState(() => {
    try { return localStorage.getItem('qlibpro.halted') === '1'; } catch { return false; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState('paper');
  const [growwStatus, setGrowwStatus] = useState(null);
  const autoHaltRef = useRef(false);
  const welcomedRef = useRef(false);
  const eventIdRef = useRef(1);
  const prevActionsRef = useRef({});

  // ── live tick loop (simulated feed) ─────────────────────────────
  useEffect(() => {
    const id = setInterval(() => { engine.tick(); setTick(t => t + 1); }, 900);
    return () => clearInterval(id);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/groww/status');
      const j = await r.json();
      setGrowwStatus(j);
      setMode(j?.mode === 'live' ? 'live' : 'paper');
    } catch { setGrowwStatus(null); setMode('paper'); }
  }, []);
  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => { store.savePositions(positions); }, [positions]);
  useEffect(() => { store.saveOrders(orders); }, [orders]);

  const addEvent = useCallback((text, tone = 'dim') => {
    eventIdRef.current += 1;
    const id = `ev-${Date.now()}-${eventIdRef.current}`;
    setEvents(p => [{ id, ts: Date.now(), text, tone }, ...p].slice(0, 48));
  }, []);

  const pushToast = useCallback((tone, title, detail) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts(prev => [...prev.slice(-2), { id, tone, title, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    if (welcomedRef.current) return;
    welcomedRef.current = true;
    pushToast('warn', 'PAPER MODE · SIMULATED FEED', 'Paper capital ₹10L loaded. Connect Groww via the gear for live routing.');
    addEvent('Watchlist scan armed: 20 instruments × 5 timeframes', 'dim');
  }, [pushToast, addEvent]);

  // ── derived market data ─────────────────────────────────────────
  const stockList = useMemo(() => INSTRUMENTS.map(s => engine.get(s.symbol)), []);
  const indexList = useMemo(() => INDICES.map(s => engine.get(s.symbol)), []);
  const withLtp = (list) => list.map(s => ({ ...s, ltp: engine.get(s.symbol).ltp }));
  const stocks = withLtp(stockList);
  const indices = withLtp(indexList);

  const candleBucket = Math.floor(tick / 6); // anchored series refresh ~every 5.4s
  const candles = useMemo(() => engine.candles(selected, tf, 160), [selected, tf, candleBucket]);

  const signals = useMemo(() => {
    const bySymbol = {};
    for (const s of INSTRUMENTS) bySymbol[s.symbol] = engine.candles(s.symbol, '5m', 120);
    return scanWatchlist(bySymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleBucket]);
  const selectedSignal = signals.find(s => s.symbol === selected)
    ?? scanSymbol(selected, engine.candles(selected, '5m', 120));
  const actionable = signals.filter(s => s.action !== 'NEUTRAL');
  const alsoWatching = actionable.filter(s => s.symbol !== selected).slice(0, 3);
  const confValues = signals.map(s => s.confidence);

  const handleHeatmapPick = useCallback((sym, pickedTf) => {
    setSelected(sym);
    if (pickedTf) setTf(pickedTf);
  }, []);

  const heatmap = useMemo(() => {
    return [...INSTRUMENTS, ...INDICES].map(s => ({
      symbol: s.symbol,
      cells: TF_LIST.map(tfKey => {
        const c = engine.candles(s.symbol, tfKey, 120);
        const sc = scanSymbol(s.symbol, c);
        return { tf: tfKey, confidence: sc.confidence, action: sc.action };
      }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleBucket]);

  const inst = engine.get(selected);
  const instType = inst?.type ?? 'stock';
  const isIndex = instType !== 'stock';
  const ltp = inst?.ltp ?? 0;
  const chgInfo = engine.change(selected);
  const dayUp = chgInfo.chg >= 0;

  const breadth = engine.breadth;
  const advTotal = breadth.advancing + breadth.declining;
  const advPct = (breadth.advancing / advTotal) * 100;
  const regime = breadth.advancing >= breadth.declining ? { label: 'BULLISH', cls: 'bull' } : { label: 'BEARISH', cls: 'bear' };
  const rsiVal = selectedSignal?.rsi ?? 50;
  const rsiZone = rsiVal >= 70 ? 'OVERBOUGHT' : rsiVal <= 30 ? 'OVERSOLD' : 'NEUTRAL';
  const atrVal = selectedSignal?.atr ?? 0;
  const emaDiff = selectedSignal?.emaDiffPct ?? 0;
  const trendUp = emaDiff >= 0;
  const vixVal = engine.get('INDIAVIX')?.ltp ?? 0;

  // volume gauge: relative volume of last anchored candle vs prior 20
  const relVol = useMemo(() => {
    if (candles.length < 25) return 1;
    const last = candles[candles.length - 1].volume;
    const avg = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    return avg > 0 ? last / avg : 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleBucket, candles]);

  const gauges = [
    { label: 'TREND', value: `${trendUp ? '▲' : '▼'} ${Math.abs(emaDiff).toFixed(2)}%`, pct: Math.min(100, (Math.abs(emaDiff) / 1.2) * 100), color: trendUp ? '#15803d' : '#dc2626' },
    { label: 'MOMENTUM', value: `RSI ${rsiVal.toFixed(0)}`, pct: Math.min(100, (Math.abs(rsiVal - 50) / 35) * 100 + 18), color: '#d97706' },
    { label: 'VOLUME', value: `${relVol.toFixed(2)}× avg`, pct: Math.min(100, relVol * 45), color: '#2563eb' },
    { label: 'BREADTH', value: `${advPct.toFixed(0)}% adv`, pct: advPct, color: '#0f766e' },
    { label: 'FUT PCR', value: breadth.pcr.toFixed(2), pct: Math.min(100, (breadth.pcr / 1.6) * 100), color: breadth.pcr >= 1 ? '#15803d' : '#d97706' },
  ];

  // signal-flip → tape events
  useEffect(() => {
    const prev = prevActionsRef.current;
    const next = {};
    const flipped = [];
    for (const s of signals) {
      next[s.symbol] = s.action;
      if (prev[s.symbol] && prev[s.symbol] !== s.action && s.action !== 'NEUTRAL' && s.confidence >= 60) {
        flipped.push({ symbol: s.symbol, action: s.action, confidence: s.confidence });
      }
    }
    prevActionsRef.current = next;
    flipped.forEach(f => addEvent(`SIG ${f.symbol} → ${f.action} @ ${f.confidence}% conf`, f.action === 'BUY' ? 'up' : 'down'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleBucket]);

  // heartbeat in the tape
  useEffect(() => {
    if (tick > 0 && tick % 25 === 10) {
      addEvent(`SCAN 20 instruments · ${actionable.length} actionable · breadth ${breadth.advancing}↑/${breadth.declining}↓`, 'dim');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

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
  const equityNow = INITIAL_CAPITAL + sessionPnl;
  const sessionPct = (sessionPnl / INITIAL_CAPITAL) * 100;
  const ordersToday = orders.filter(o => new Date(o.ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) === istDateStr()).length;

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

  useEffect(() => {
    if (!autoHaltRef.current && sessionPnl <= -DAILY_LOSS_LIMIT) {
      autoHaltRef.current = true;
      setHalted(true);
      pushToast('error', 'DAILY LOSS LIMIT BREACHED', `Session P&L ${formatSignedINR(sessionPnl)} — HALT engaged automatically.`);
      addEvent(`AUTO-HALT · session P&L ${formatSignedINR(sessionPnl)} breached ₹${DAILY_LOSS_LIMIT.toLocaleString('en-IN')} limit`, 'down');
    }
  }, [sessionPnl, pushToast, addEvent]);

  // ── order placement ─────────────────────────────────────────────
  const placeOrder = useCallback(async ({ side, symbol, qty, orderType, product, price, clientPrice }) => {
    if (halted) return { ok: false, reason: 'Trading is halted (kill-switch).' };
    const symInst = engine.get(symbol);
    if (symInst && symInst.type !== 'stock' && mode === 'live') {
      const reason = 'Indices / VIX are not directly orderable on Groww — use Nifty/BankNifty/Sensex F&O. Switch to PAPER to simulate.';
      pushToast('error', 'LIVE ORDER BLOCKED', reason);
      addEvent(`BLOCKED live ${side} ${symbol} — index orders need F&O`, 'down');
      return { ok: false, reason };
    }
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
      addEvent(`REJECT ${side} ${qty} ${symbol} — ${res.reason || 'unknown'}`, 'down');
      return res;
    }
    const fillPrice = res.mode === 'paper'
      ? res.paperFill.price
      : Number(res?.groww?.average_fill_price ?? res?.groww?.price) || clientPrice;
    const charges = estimateCharges(side, qty, fillPrice, product);
    const fill = applyFillToPositions(positions, { symbol, side, qty, price: fillPrice, product });
    setPositions(fill.positions);
    setOrders(prev => [...prev, {
      id: res.orderRef, ts: Date.now(), type: fill.closed ? 'close' : 'open',
      symbol, side, qty, price: fillPrice, product, orderType,
      charges: charges.total, pnl: fill.realized, mode: res.mode,
    }]);
    const modeTag = res.mode === 'paper' ? 'PAPER' : 'GROWW';
    const indexTag = symInst && symInst.type !== 'stock' ? ' (index · simulated)' : '';
    addEvent(`${modeTag} ${side} ${qty} × ${symbol} @ ₹${Number(fillPrice).toFixed(2)}${indexTag} · ${res.orderRef}`, side === 'BUY' ? 'up' : 'down');
    if (fill.closed && fill.realized !== 0) {
      addEvent(`CLOSED ${symbol} · realized ${formatSignedINR(fill.realized)}`, fill.realized >= 0 ? 'up' : 'down');
    }
    pushToast('ok', `${modeTag} ${side} · ${qty} × ${symbol}`, `Fill @ ₹${Number(fillPrice).toFixed(2)} · ref ${res.orderRef}`);
    return res;
  }, [halted, mode, positions, pushToast, addEvent]);

  const exitPosition = useCallback((pos) => {
    const side = pos.side === 'BUY' ? 'SELL' : 'BUY';
    placeOrder({ side, symbol: pos.symbol, qty: pos.qty, orderType: 'MARKET', product: pos.product, clientPrice: engine.get(pos.symbol)?.ltp });
  }, [placeOrder]);

  // sync HALT across Classic UI and the adapted GrokDesk terminal (F1)
  useEffect(() => {
    const onStorage = (e) => { if (e.key === 'qlibpro.halted') setHalted(e.newValue === '1'); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleHalt = () => {
    setHalted(h => {
      const next = !h;
      try { localStorage.setItem('qlibpro.halted', next ? '1' : '0'); } catch { /* ignore */ }
      pushToast(next ? 'error' : 'ok', next ? 'KILL SWITCH ENGAGED' : 'TRADING RESUMED', next ? 'All order placement disabled.' : 'Order placement enabled.');
      addEvent(next ? 'HALT engaged manually — order flow disabled' : 'HALT released — order flow re-enabled', next ? 'down' : 'up');
      return next;
    });
  };

  const resetPaper = () => {
    store.clearAll();
    setPositions([]); setOrders([]); setEquity([INITIAL_CAPITAL]);
    autoHaltRef.current = false; setHalted(false);
    setEvents([{ id: `ev-${Date.now()}`, ts: Date.now(), text: 'Paper ledger reset · equity back to ₹10,00,000', tone: 'dim' }]);
    pushToast('ok', 'PAPER LEDGER RESET', 'Positions, orders, equity curve and realized P&L cleared.');
  };

  const connectGroww = useCallback(async (token) => {
    if (!token || token.length < 20) return { ok: false, reason: 'Paste the full access token (min 20 characters).' };
    try {
      const r = await fetch('/api/groww/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const j = await r.json();
      await fetchStatus();
      if (j.ok) { pushToast('ok', 'GROWW CONNECTED', 'Live routing enabled. Feed stays simulated until P1.'); addEvent('GROWW connected — live order routing armed', 'up'); }
      else addEvent(`GROWW connect failed — ${j.reason || 'unknown'}`, 'down');
      return j;
    } catch (e) { return { ok: false, reason: `Request failed: ${e.message}` }; }
  }, [fetchStatus, pushToast, addEvent]);

  const disconnectGroww = useCallback(async () => {
    try { await fetch('/api/groww/disconnect', { method: 'POST' }); } catch { /* ignore */ }
    await fetchStatus();
    addEvent('GROWW disconnected — back to PAPER routing', 'dim');
  }, [fetchStatus, addEvent]);

  const flashPanel = useCallback((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('panel-flash');
    void el.offsetWidth;
    el.classList.add('panel-flash');
    setTimeout(() => el.classList.remove('panel-flash'), 1500);
  }, []);

  // ── render ──────────────────────────────────────────────────────
  const isOpen = nseOpenNow();
  const latency = Math.round(9 + Math.abs(Math.sin(tick / 3)) * 7);
  const action = selectedSignal?.action ?? 'NEUTRAL';
  const confidence = selectedSignal?.confidence ?? 50;
  const signalCls = action === 'BUY' ? 'bull' : action === 'SELL' ? 'bear' : 'flat';
  const money = (n) => formatNumberIN(n);

  const factorCards = [
    { label: 'REGIME', value: regime.label, cls: regime.cls, sub: 'breadth led' },
    { label: 'SIGNAL', value: action, cls: signalCls, hot: action !== 'NEUTRAL', sub: instType === 'stock' ? 'watchlist scan' : 'index scan' },
    { label: 'CONFIDENCE', value: `${confidence}%`, cls: 'amber', bar: confidence, sub: 'EMA+RSI+ATR' },
    { label: 'EMA TREND', value: trendUp ? '9 > 21' : '9 < 21', cls: trendUp ? 'bull' : 'bear', sub: `${trendUp ? '+' : ''}${emaDiff.toFixed(2)}% spread` },
    { label: 'RSI 14', value: rsiVal.toFixed(1), cls: 'flat', sub: rsiZone },
    { label: 'ATR 14', value: `₹${atrVal.toFixed(2)}`, cls: 'flat', sub: 'true range' },
    { label: 'INDIA VIX', value: vixVal.toFixed(2), cls: vixVal > 15 ? 'bear' : 'flat', sub: 'volatility' },
  ];

  return (
    <div className={`app${halted ? ' halted' : ''}`}>
      {/* ── TOP BAR ─────────────────────────────────────────── */}
      <header className="topbar">
        <button className="back-btn" aria-label="Back" onClick={() => flashPanel('panel-grid')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div className="brand2">
          <div className="brand-badge2" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
              <path d="M4 22 L13 13 L18 17 L28 6" stroke="#f0b90b" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="28" cy="6" r="2.6" fill="#2ebd85" />
            </svg>
          </div>
          <div>
            <div className="brand2-name">QLIB<b>PRO</b> <span className="brand2-desk">DESK</span></div>
            <div className="brand2-sub">Indian Algo Terminal · NSE/BSE · Groww</div>
          </div>
        </div>
        <nav className="nav-links" aria-label="Jump to panel">
          {[['GRID', 'panel-grid'], ['LEDGER', 'panel-pnl'], ['ORBIT', 'panel-orbit'], ['CLOSER', 'panel-closer'], ['TAPE', 'panel-tape'], ['SPECTRO', 'panel-spectro']].map(([label, id]) => (
            <button key={id} className="navlink" onClick={() => flashPanel(id)}>{label}</button>
          ))}
        </nav>
        <div className="header-spacer" />
        <div className="ist-block">
          <b className="num">{istTimeStr()}</b>
          <small>IST · {istDateLong()} · <i className={isOpen ? 'pos' : 'neg'} style={{ fontStyle: 'normal' }}>NSE {isOpen ? 'OPEN' : 'CLOSED'}</i></small>
        </div>
        <div className={`mode-badge ${mode === 'live' ? 'live' : 'paper'}`} title={growwStatus?.tokenExpiryNote || ''}>
          <span className="mode-dot" />
          {mode === 'live' ? 'GROWW LIVE' : 'PAPER'}
        </div>
        <a className="icon-btn desk-link" href="/desk.html" title="Open QlibPro Desk — the GrokDesk-adapted terminal (Indian markets)" aria-label="Open QlibPro Desk terminal">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 8.5 12 15 22 8.5" /><polyline points="2 13.5 12 20 22 13.5" /></svg>
        </a>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Groww API settings" aria-label="Groww settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1" />
          </svg>
        </button>
        <button className={`halt-btn${halted ? ' halted' : ''}`} onClick={toggleHalt} title="Kill switch — disable/enable all order placement">
          {halted ? 'HALTED' : 'HALT'}
        </button>
      </header>

      {halted && <div className="halted-strip">KILL SWITCH ENGAGED — ORDER PLACEMENT DISABLED</div>}

      {/* ── STATS STRIP ─────────────────────────────────────── */}
      <div className="statsbar">
        <span className="stat"><label>LAST</label><b className="num">₹{money(ltp)}<i className={dayUp ? 'pos' : 'neg'}> ({dayUp ? '+' : ''}{chgInfo.pct.toFixed(2)}%)</i></b></span>
        <span className="stat-sep">·</span>
        <span className="stat"><label>FEED</label><b>{mode === 'live' ? 'GROWW+SIM' : 'SIMULATED'}</b></span>
        <span className="stat-sep">·</span>
        <span className="stat"><label>ORDERS</label><b className="num">{ordersToday}</b></span>
        <span className="stat-sep">·</span>
        <span className="stat"><label>MAX DD</label><b className="num">0.0%</b></span>
        <span className="stat-sep">·</span>
        <span className="stat"><label>SESS P&amp;L</label><b className={`num ${sessionPnl >= 0 ? 'pos' : 'neg'}`}>{formatSignedINR(sessionPnl)}</b></span>
        <span className="stat-sep">·</span>
        <span className="stat"><label>GROWW</label><b>{mode === 'live' ? 'CONNECTED' : 'PAPER ONLY'}</b></span>
        <span className="spacer" />
        <span className="stat dim">MONO·0.9 · <b>NOT FINANCIAL ADVICE</b></span>
      </div>

      {/* ── INDEX STRIP ─────────────────────────────────────── */}
      <div className="indexstrip" role="tablist" aria-label="Benchmarks">
        {indices.map(ix => {
          const { chg, pct } = engine.change(ix.symbol);
          const up = chg >= 0;
          const active = selected === ix.symbol;
          return (
            <button key={ix.symbol} role="tab" aria-selected={active} className={`idx-chip${active ? ' active' : ''}`} onClick={() => setSelected(ix.symbol)}>
              <span className="idx-name">{ix.name.toUpperCase()}</span>
              <span className="idx-val num">{formatNumberIN(ix.ltp, 2)}</span>
              <span className={`idx-chg num ${up ? 'pos' : 'neg'}`}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%</span>
            </button>
          );
        })}
      </div>

      {/* ── FACTOR CARDS ────────────────────────────────────── */}
      <div className="factor-row">
        {factorCards.map((c, i) => (
          <div key={i} className={`factor-card ${c.cls ?? ''}${c.hot ? ' hot' : ''}`}>
            <div className="factor-label">{c.label}</div>
            <div className="factor-value num">{c.value}</div>
            {c.bar !== undefined
              ? <div className="factor-bar"><div style={{ width: `${c.bar}%` }} /></div>
              : <div className="factor-sub">{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── MAIN GRID ───────────────────────────────────────── */}
      <main className="main">
        {/* left column */}
        <section className="col col-left">
          <div className="panel grid-panel" id="panel-grid">
            <div className="panel-title">The Grid <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· paper equity</span><span className="spacer" /><span className="chip">₹10L START</span></div>
            <div className="grid-body">
              <div className="grid-nums">
                <div className="equity-big num">{formatINR(equityNow, { decimals: 0 })}</div>
                <div className="grid-sub">session 09:15–15:30 IST · {positions.length} open</div>
                <div className="grid-mini">
                  <div className="mini-stat"><label>Realized</label><b className={`num ${realized >= 0 ? 'pos' : 'neg'}`}>{formatSignedINR(realized)}</b></div>
                  <div className="mini-stat"><label>Unrealized</label><b className={`num ${unrealized >= 0 ? 'pos' : 'neg'}`}>{formatSignedINR(unrealized)}</b></div>
                </div>
              </div>
              <div className="grid-spark"><EquitySpark equity={equity} /></div>
            </div>
          </div>

          <div className="panel pnl-panel" id="panel-pnl">
            <div className="panel-title">The Ledger <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· session P&amp;L</span><span className="spacer" /><span className="chip">TARGET +2.5%</span></div>
            <div className="pnl-body">
              <div className="pnl-row">
                <div className={`pnl-big num ${sessionPnl >= 0 ? 'pos' : 'neg'}`}>{formatSignedINR(sessionPnl)}</div>
                <div className={`pnl-badge num ${sessionPnl >= 0 ? 'pos' : 'neg'}`}>{sessionPnl >= 0 ? '▲' : '▼'} {Math.abs(sessionPct).toFixed(2)}%</div>
              </div>
              <PnlBars equity={equity} />
              <div className="pnl-foot">TARGET <b className="num">{formatINR(INITIAL_CAPITAL * 1.025, { decimals: 0 })}</b> · STOP <b className="num">{formatINR(INITIAL_CAPITAL * 0.975, { decimals: 0 })}</b> · WIN RATE <b>{winRate === null ? '—' : `${winRate}%`}</b> · CHARGES <b className="num">≈{formatINR(totalCharges, { decimals: 0 })}</b></div>
            </div>
          </div>

          <div className="panel tape-panel" id="panel-tape">
            <div className="mini-tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'tape'} className={`mini-tab${tab === 'tape' ? ' active' : ''}`} onClick={() => setTab('tape')}>The Tape</button>
              <button role="tab" aria-selected={tab === 'positions'} className={`mini-tab${tab === 'positions' ? ' active' : ''}`} onClick={() => setTab('positions')}>Positions{positions.length ? ` (${positions.length})` : ''}</button>
            </div>
            {tab === 'tape' ? <TapeFeed events={events} /> : <PositionsPanel positions={positions} onExit={exitPosition} />}
          </div>
        </section>

        {/* center column — the orbit */}
        <section className="col col-center">
          <div className="panel orbit-panel" id="panel-orbit">
            <div className="panel-title">The Orbit <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· market structure</span><span className="spacer" /><span className="chip">DRAG TO SPIN</span></div>
            <div className="orbit-body">
              <OrbitGlobe />
              <div className="orbit-tl">
                <div className="orbit-exchange">{inst?.exchange} · {instType === 'stock' ? 'EQ' : instType === 'vix' ? 'VOL' : 'INDEX'}</div>
                <div className="orbit-symbol">{selected}</div>
                <div className="orbit-ltp num">₹{money(ltp)}</div>
                <div className={`orbit-chg num ${dayUp ? 'pos' : 'neg'}`}>{dayUp ? '▲' : '▼'} {Math.abs(chgInfo.pct).toFixed(2)}% vs prev close</div>
              </div>
              <div className="orbit-signal">
                <div className="orbit-signal-label">THE CLOSER</div>
                <div className={`orbit-signal-action ${signalCls}`}>{action}</div>
                <div className="orbit-signal-conf num">{confidence}% conf</div>
              </div>
              <div className="gauges">
                {gauges.map(g => (
                  <div key={g.label} className="gauge">
                    <div className="gauge-head"><span>{g.label}</span><b className="num">{g.value}</b></div>
                    <div className="gauge-bar"><div className="gauge-fill" style={{ width: `${g.pct}%`, background: g.color }} /></div>
                  </div>
                ))}
              </div>
              <div className="orbit-hint">auto-rotates · drag horizontally to spin</div>
            </div>
          </div>
        </section>

        {/* right column */}
        <section className="col col-right">
          <CloserPanel signal={selectedSignal} ltp={ltp} others={alsoWatching} onSelect={setSelected} />
          <div className="panel pricer-panel" id="panel-pricer">
            <div className="panel-title">The Pricer <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· confidence bell</span><span className="spacer" /><span className="chip">SCAN ×{confValues.length}</span></div>
            <DistributionChart values={confValues} selectedValue={confidence} selectedAction={action} />
          </div>
          <div className="panel spectro-panel" id="panel-spectro">
            <div className="panel-title">The Spectrogram <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· confidence by TF</span><span className="spacer" /><span className="chip">CLICK CELL</span></div>
            <Heatmap matrix={heatmap} selectedSymbol={selected} onPick={handleHeatmapPick} />
          </div>
        </section>
      </main>

      {/* ── BOTTOM ROW: chart + ladder + ticket ─────────────── */}
      <div className="bottomrow">
        <CandleChart
          symbol={selected}
          symbolName={inst?.name}
          candles={candles}
          tf={tf}
          onTfChange={setTf}
          tick={tick}
          signal={selectedSignal}
          panelId="panel-chart"
        />
        <div className="panel ladder-panel">
          <div className="panel-title">Depth <span className="spacer" /><span className="chip">{inst?.exchange} · SIM</span></div>
          <DepthBook symbol={selected} levels={7} />
        </div>
        <OrderTicket symbol={selected} symbolType={instType} mode={mode} halted={halted} onPlace={placeOrder} />
      </div>

      {/* ── STATUS BAR ─────────────────────────────────────── */}
      <footer className="statusbar">
        <span className="status-dot" />
        <span>QLIB PRO <b>ONLINE</b></span>
        <span>FEED <b>{mode === 'live' ? 'GROWW+SIM' : 'SIMULATED'}</b></span>
        <span>LATENCY <b>~{latency}ms</b></span>
        <span>ORDERS TODAY <b>{ordersToday}</b></span>
        <span>GROWW <b>{mode === 'live' ? 'CONNECTED' : 'PAPER'}</b></span>
        <span className="spacer" />
        <button className="ghost-btn reset-btn" onClick={resetPaper} title="Clear paper positions, orders and equity curve">RESET PAPER</button>
        <span>NSE/BSE data nominal · <b>NOT FINANCIAL ADVICE</b> · F&amp;O involves risk</span>
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
