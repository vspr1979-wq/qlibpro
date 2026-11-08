import { useEffect, useRef } from 'react';

// Session P&L "equalizer" bars — each bar is the equity delta between samples.
export default function PnlBars({ equity }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const deltas = [];
    for (let i = 1; i < equity.length; i++) deltas.push(equity[i] - equity[i - 1]);
    const maxAbs = Math.max(1, ...deltas.map(Math.abs));
    const zero = h / 2;

    // zero line
    ctx.strokeStyle = 'rgba(29,36,51,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, zero); ctx.lineTo(w, zero); ctx.stroke();

    if (deltas.length === 0) {
      ctx.fillStyle = '#8b8577';
      ctx.font = '9px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('bars appear as paper equity moves', w / 2, zero - 6);
      return;
    }
    const step = w / deltas.length;
    const barW = Math.max(1.5, step * 0.72);
    for (let i = 0; i < deltas.length; i++) {
      const d = deltas[i];
      const bh = (Math.abs(d) / maxAbs) * (h / 2 - 3);
      ctx.fillStyle = d >= 0 ? '#15803d' : '#dc2626';
      const x = i * step + (step - barW) / 2;
      if (d >= 0) ctx.fillRect(x, zero - bh, barW, bh);
      else ctx.fillRect(x, zero, barW, bh);
    }
  });

  return <canvas ref={ref} className="pnl-bars" aria-hidden="true" />;
}
