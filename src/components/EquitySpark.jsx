import { useEffect, useRef } from 'react';
import { INITIAL_CAPITAL } from '../paper.js';

// Compact equity sparkline for THE GRID panel (area line + dashed ₹10L baseline).
export default function EquitySpark({ equity }) {
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

    const data = equity.length > 1 ? equity : [INITIAL_CAPITAL, INITIAL_CAPITAL];
    let min = Math.min(...data, INITIAL_CAPITAL);
    let max = Math.max(...data, INITIAL_CAPITAL);
    const pad = (max - min || 500) * 0.15;
    min -= pad; max += pad;
    const up = data[data.length - 1] >= INITIAL_CAPITAL;
    const line = up ? '#15803d' : '#dc2626';

    const X = (i) => (i / (data.length - 1)) * (w - 4) + 2;
    const Y = (v) => h - 3 - ((v - min) / (max - min)) * (h - 8);

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(29,36,51,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(INITIAL_CAPITAL)); ctx.lineTo(w, Y(INITIAL_CAPITAL)); ctx.stroke();
    ctx.setLineDash([]);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? 'rgba(21,128,61,0.35)' : 'rgba(220,38,38,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    data.forEach((v, i) => { i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)); });
    ctx.lineTo(X(data.length - 1), h); ctx.lineTo(X(0), h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    data.forEach((v, i) => { i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)); });
    ctx.strokeStyle = line; ctx.lineWidth = 1.5; ctx.stroke();
  });

  return <canvas ref={ref} className="equity-spark" aria-hidden="true" />;
}
