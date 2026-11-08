import React, { useEffect, useMemo, useRef } from 'react';
import { createChart } from 'lightweight-charts';
import { ema, rsi } from '../strategy.js';
import { TF_LABEL } from '../marketSim.js';
import { formatNumberIN } from '../paper.js';

const TIMEFRAMES = ['1m', '5m', '15m', '1H', '1D'];
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

export default function CandleChart({ symbol, symbolName, candles, tf, onTfChange, tick, signal }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const volRef = useRef(null);
  const ema9Ref = useRef(null);
  const ema21Ref = useRef(null);
  const tgtLineRef = useRef(null);
  const slLineRef = useRef(null);

  const closes = useMemo(() => candles.map(c => c.close), [candles]);
  const e9 = useMemo(() => ema(closes, 9), [closes]);
  const e21 = useMemo(() => ema(closes, 21), [closes]);
  const r14 = useMemo(() => rsi(closes, 14), [closes]);

  // create chart once per symbol/tf
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      layout: { background: { color: 'transparent' }, textColor: '#8b95a7', fontSize: 10, fontFamily: MONO },
      grid: {
        vertLines: { color: 'rgba(28, 38, 60, 0.4)' },
        horzLines: { color: 'rgba(28, 38, 60, 0.4)' },
      },
      crosshair: { mode: 0, vertLine: { color: '#f0b90b55' }, horzLine: { color: '#f0b90b55' } },
      rightPriceScale: { borderColor: '#1d2940' },
      timeScale: { borderColor: '#1d2940', timeVisible: tf !== '1D', secondsVisible: false, rightOffset: 5, barSpacing: 8 },
      localization: { locale: 'en-IN' },
      width: el.clientWidth,
      height: el.clientHeight,
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#2ebd85', downColor: '#f6465d',
      wickUpColor: '#2ebd85', wickDownColor: '#f6465d',
      borderUpColor: '#2ebd85', borderDownColor: '#f6465d', borderVisible: false,
    });
    const volSeries = chart.addHistogramSeries({
      priceScaleId: 'vol', priceFormat: { type: 'volume' },
      lastValueVisible: false, priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const ema9Series = chart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const ema21Series = chart.addLineSeries({ color: '#22d3ee', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

    chartRef.current = chart; candleRef.current = candleSeries; volRef.current = volSeries;
    ema9Ref.current = ema9Series; ema21Ref.current = ema21Series;

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
      }
    });
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null; tgtLineRef.current = null; slLineRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tf]);

  // push data on every tick (cheap: ~160 points)
  useEffect(() => {
    if (!candleRef.current) return;
    candleRef.current.setData(candles);
    volRef.current.setData(candles.map(c => ({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(46,189,133,0.32)' : 'rgba(246,70,93,0.32)',
    })));
    ema9Ref.current.setData(e9.map((v, i) => ({ time: candles[i].time, value: v })));
    ema21Ref.current.setData(e21.map((v, i) => ({ time: candles[i].time, value: v })));
    // EMA-cross markers
    const markers = [];
    for (let i = 1; i < candles.length; i++) {
      if (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i]) {
        markers.push({ time: candles[i].time, position: 'belowBar', color: '#2ebd85', shape: 'arrowUp', text: 'B' });
      } else if (e9[i - 1] >= e21[i - 1] && e9[i] < e21[i]) {
        markers.push({ time: candles[i].time, position: 'aboveBar', color: '#f6465d', shape: 'arrowDown', text: 'S' });
      }
    }
    candleRef.current.setMarkers(markers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, candles, e9, e21]);

  // target / stop-loss price lines from the live signal
  const sigAction = signal?.action;
  const sigTarget = signal?.target;
  const sigStop = signal?.stop;
  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    if (tgtLineRef.current) { c.removePriceLine(tgtLineRef.current); tgtLineRef.current = null; }
    if (slLineRef.current) { c.removePriceLine(slLineRef.current); slLineRef.current = null; }
    if (sigAction && sigAction !== 'NEUTRAL') {
      tgtLineRef.current = c.createPriceLine({ price: sigTarget, color: '#2ebd85', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TGT' });
      slLineRef.current = c.createPriceLine({ price: sigStop, color: '#f6465d', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' });
    }
  }, [sigAction, sigTarget, sigStop]);

  const last = candles[candles.length - 1];
  const ohlcUp = last && last.close >= last.open;

  return (
    <div className="panel chart-panel">
      <div className="chart-toolbar">
        <span className="chart-symbol">{symbol}</span>
        <span className="dim" style={{ fontSize: 10 }}>{symbolName} · NSE</span>
        {last && (
          <span className="chart-ohlc">
            <span>O <b className="num">{formatNumberIN(last.open)}</b></span>
            <span>H <b className="num pos">{formatNumberIN(last.high)}</b></span>
            <span>L <b className="num neg">{formatNumberIN(last.low)}</b></span>
            <span>C <b className={`num ${ohlcUp ? 'pos' : 'neg'}`}>{formatNumberIN(last.close)}</b></span>
            <span>RSI14 <b className="num" style={{ color: 'var(--cyan)' }}>{r14[r14.length - 1]?.toFixed(1)}</b></span>
          </span>
        )}
        <div className="tf-group">
          {TIMEFRAMES.map(t => (
            <button key={t} className={`tf-btn${tf === t ? ' active' : ''}`} onClick={() => onTfChange(t)}>{TF_LABEL[t]}</button>
          ))}
        </div>
      </div>
      <div className="chart-wrap"><div ref={containerRef} /></div>
    </div>
  );
}
