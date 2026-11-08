import { useEffect, useRef } from 'react';

// Confidence distribution "bell" across the scanned watchlist (THE PRICER).
// Gaussian-kernel smoothed density over scan confidences + marker for the
// currently selected symbol.
export default function DistributionChart({ values, selectedValue, selectedAction }) {
  const ref = useRef(null);
  const key = values.length ? `${values.length}:${values.map(v => Math.round(v)).join(',')}:${Math.round(selectedValue ?? -1)}:${selectedAction ?? ''}` : 'empty';

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

    if (values.length < 3) {
      ctx.fillStyle = '#8b8577';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough scan data yet', w / 2, h / 2);
      return;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
    const p10 = p(0.1), p50 = p(0.5), p90 = p(0.9);

    const lo = Math.max(20, Math.floor(sorted[0] - 8));
    const hi = Math.min(100, Math.ceil(sorted[sorted.length - 1] + 8));
    const sigma = Math.max(4, (hi - lo) / 9);

    // smoothed density curve
    const SAMPLES = 72;
    const density = [];
    let maxD = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const x = lo + ((hi - lo) * i) / SAMPLES;
      let d = 0;
      for (const v of values) {
        const z = (x - v) / sigma;
        d += Math.exp(-0.5 * z * z);
      }
      density.push({ x, d });
      if (d > maxD) maxD = d;
    }
    const padL = 6, padR = 6, padT = 16, padB = 18;
    const X = (x) => padL + ((x - lo) / (hi - lo)) * (w - padL - padR);
    const Y = (d) => padT + (1 - d / (maxD || 1)) * (h - padT - padB);

    // fill
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, 'rgba(217,119,6,0.55)');
    grad.addColorStop(1, 'rgba(217,119,6,0.04)');
    ctx.beginPath();
    ctx.moveTo(X(lo), Y(density[0].d));
    for (const pt of density) ctx.lineTo(X(pt.x), Y(pt.d));
    ctx.lineTo(X(hi), h - padB);
    ctx.lineTo(X(lo), h - padB);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // stroke
    ctx.beginPath();
    density.forEach((pt, i) => { i === 0 ? ctx.moveTo(X(pt.x), Y(pt.d)) : ctx.lineTo(X(pt.x), Y(pt.d)); });
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // baseline
    ctx.strokeStyle = 'rgba(29,36,51,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();

    // selected marker
    if (selectedValue != null) {
      const sx = X(Math.min(hi, Math.max(lo, selectedValue)));
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = selectedAction === 'SELL' ? '#dc2626' : '#15803d';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(sx, padT - 4); ctx.lineTo(sx, h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(sx, padT - 4); ctx.lineTo(sx - 4, padT - 10); ctx.lineTo(sx + 4, padT - 10); ctx.closePath(); ctx.fill();
    }

    // percentile labels
    ctx.fillStyle = '#6b7280';
    ctx.font = '8px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`P10 ${p10.toFixed(0)}`, padL + 2, h - 6);
    ctx.textAlign = 'center';
    ctx.fillText(`P50 ${p50.toFixed(0)}`, w / 2, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`P90 ${p90.toFixed(0)}`, w - padR - 2, h - 6);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={ref} className="pricer-canvas" aria-hidden="true" />;
}
