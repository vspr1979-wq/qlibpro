import { useEffect, useRef } from 'react';

// Rotating "market structure" sphere — fibonacci-sphere dots, orbital arcs,
// satellite index markers. Drag to spin; auto-rotates when idle.
// Pure canvas, devicePixelRatio-aware, respects prefers-reduced-motion.
export default function OrbitGlobe() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // deterministic pseudo-random
    let seed = 987643211;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    // fibonacci sphere
    const N = 320;
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r });
    }
    const arcPairs = [];
    for (let i = 0; i < 13; i++) arcPairs.push([Math.floor(rnd() * N), Math.floor(rnd() * N)]);

    const sats = [
      { label: 'NIFTY',     phase: 0.0, incl: 0.42,  r: 1.38, speed: 0.34, color: '#f0b90b' },
      { label: 'SENSEX',    phase: 2.2, incl: -0.30, r: 1.52, speed: 0.26, color: '#22d3ee' },
      { label: 'BANKNIFTY', phase: 4.1, incl: 0.16,  r: 1.28, speed: 0.43, color: '#f472b6' },
      { label: 'VIX',       phase: 5.4, incl: -0.52, r: 1.62, speed: 0.21, color: '#a3e635' },
    ];

    let raf;
    let rotY = 0.7;
    let vel = 0;
    let t = 0;
    let dragging = false;
    let lastX = 0;
    const TILT = 0.32;
    const cosT = Math.cos(TILT), sinT = Math.sin(TILT);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const onDown = (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing'; };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      rotY += dx * 0.009;
      vel = dx * 0.00038;
    };
    const onUp = (e) => { dragging = false; canvas.style.cursor = 'grab'; canvas.releasePointerCapture?.(e.pointerId); };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      t += 0.016;
      if (!dragging) { rotY += (reduced ? 0 : 0.0032) + vel; vel *= 0.95; }

      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);

      const minDim = Math.min(w, h);
      const R = minDim * 0.30;
      const cx = w * 0.52, cy = h * 0.55;
      const cosR = Math.cos(rotY), sinR = Math.sin(rotY);

      const proj = (p) => {
        const x1 = p.x * cosR + p.z * sinR;
        const z1 = -p.x * sinR + p.z * cosR;
        const y2 = p.y * cosT - z1 * sinT;
        const z2 = p.y * sinT + z1 * cosT;
        const f = 3.1;
        const s = f / (f - z2);
        return { x: cx + x1 * R * s, y: cy + y2 * R * s, z: z2, s };
      };
      const P = pts.map(proj);

      // sphere body
      const g = ctx.createRadialGradient(cx - R * 0.38, cy - R * 0.4, R * 0.08, cx, cy, R);
      g.addColorStop(0, '#41294e');
      g.addColorStop(0.5, '#2b1f3a');
      g.addColorStop(1, '#150f22');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(240,185,11,0.75)';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = 'rgba(240,185,11,0.55)'; ctx.shadowBlur = 14;
      ctx.stroke(); ctx.shadowBlur = 0;

      // dashed orbit rings
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(240,185,11,0.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.04, R * 0.35, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = 'rgba(244,114,182,0.5)';
      ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.24, R * 0.44, -0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);

      // dots back → front
      const ordered = [...P].sort((a, b) => a.z - b.z);
      for (const p of ordered) {
        const front = p.z > 0;
        const tw = 0.55 + 0.45 * Math.sin(t * 2.1 + p.x * 41 + p.y * 29);
        ctx.fillStyle = front
          ? `rgba(244,114,182,${0.45 + 0.55 * tw})`
          : 'rgba(158,128,168,0.30)';
        ctx.beginPath(); ctx.arc(p.x, p.y, front ? 1.15 + p.s * 1.25 : 1.0, 0, Math.PI * 2); ctx.fill();
      }

      // connecting arcs (front-facing only)
      for (const [ia, ib] of arcPairs) {
        const A = P[ia], B = P[ib];
        if (A.z < -0.15 || B.z < -0.15) continue;
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        const dx = B.x - A.x, dy = B.y - A.y;
        ctx.strokeStyle = 'rgba(240,185,11,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.quadraticCurveTo(mx - dy * 0.32, my + dx * 0.32 - R * 0.2, B.x, B.y);
        ctx.stroke();
      }

      // expanding pulse
      const pt = (t % 3.4) / 3.4;
      ctx.strokeStyle = `rgba(240,185,11,${0.4 * (1 - pt)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, R + pt * R * 1.15, 0, Math.PI * 2); ctx.stroke();

      // orbiting index satellites with labels
      ctx.font = "700 8.5px ui-monospace, Menlo, Consolas, monospace";
      for (const s of sats) {
        const ang = t * s.speed + s.phase;
        const ex = Math.cos(ang) * R * s.r;
        const ey = Math.sin(ang) * R * s.r * 0.40;
        const X = cx + ex * Math.cos(s.incl) - ey * Math.sin(s.incl);
        const Y = cy + ex * Math.sin(s.incl) + ey * Math.cos(s.incl);
        const behind = Math.sin(ang) < 0;
        ctx.globalAlpha = behind ? 0.4 : 1;
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(X, Y, 3.1, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(20,27,45,0.45)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(X, Y, 5.4, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#f5f2ea';
        ctx.fillText(s.label, X + 8, Y + 3);
        ctx.globalAlpha = 1;
      }
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="orbit-canvas"
      style={{ cursor: 'grab', touchAction: 'none' }}
      aria-label="Interactive market-structure globe — drag to spin"
    />
  );
}
