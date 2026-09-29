/* OptionSignal front-end — polls the backend for real data only. */
const $ = (id) => document.getElementById(id);
const esc = (v) => (v === null || v === undefined ? "—" : String(v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
const num = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? "—"
  : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const inr = (v, d = 0) => (v === null || v === undefined || isNaN(v)) ? "—"
  : "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

/* ---------------------------------------------------------- status bar ---- */
async function pollStatus() {
  try {
    const s = await api("/api/status");
    $("stUpstox").textContent = "Upstox: " + (s.connected ? "CONNECTED" : "OFFLINE");
    $("stUpstoxDot").className = "dot " + (s.connected ? "g" : "r");
    $("stMarket").textContent = "Market: " + (s.market || "UNKNOWN");
    $("stMarketDot").className = "dot " + (/OPEN/i.test(s.market || "") ? "g" : "a");
    const fresh = (s.data || []).every(d => d.fresh);
    const any = (s.data || []).length > 0;
    $("stData").textContent = "Data: " +
      (!any ? "none" : (fresh ? "LIVE" : "STALE")) + (s.last_cycle ? "" : "");
    $("stDataDot").className = "dot " + (!any ? "a" : (fresh ? "g" : "r"));
    const qs = s.qlib || {};
    $("stQlib").textContent = "QLib: " + (qs.ready ? "READY" : (qs.status || "IDLE"));
    $("stQlibDot").className = "dot " + (qs.ready ? "g" : "a");
    $("stSymbols").textContent = (s.symbols || 0) + " symbols";
    window.__status = s;
  } catch (e) { /* keep last known state */ }
}

/* ========================================================== DASHBOARD ===== */
let boardSignals = {};   // symbol -> signal dict
let boardRows = [];

function renderSignalCard(sym) {
  const s = boardSignals[sym] || {};
  const card = $("signalCard");
  const sig = s.signal || "NO TRADE";
  card.className = "signal-card " + (sig === "NO TRADE" ? "no" : (s.option_type === "PE" ? "pe" : ""));
  $("sigBig").textContent = sig === "NO TRADE" ? "NO TRADE" : sig;
  $("sigOption").textContent = s.strike && s.option_type
    ? `${esc(s.trading_symbol || sym)} ${s.strike} ${s.option_type} · ${inr(s.premium)}`
    : "no selected contract";
  const strat = s.strategy && s.strategy !== "" ? s.strategy : "—";
  const conf = (s.confidence !== null && s.confidence !== undefined)
    ? Number(s.confidence).toFixed(2) : "—";
  $("sigBadges").innerHTML =
    `<span class="badge ${strat === "—" ? "b-gray" : "b-strat"}">${esc(strat)}</span> ` +
    `<span class="badge ${sig === "NO TRADE" ? "b-amber" : "b-green"}">QLib: ${esc(s.qlib_direction || "—")} ${conf}</span> ` +
    `<span class="badge ${sig === "NO TRADE" ? "b-amber" : "b-green"}">${sig === "NO TRADE" ? "WAIT" : "ACTIVE"}</span>`;
  $("sigReason").innerHTML = esc(s.reason || "Waiting for the automatic pipeline (collect → Qlib → strategies → risk).") +
    " · Signal only — no automatic orders.";

  const row = boardRows.find(r => r.symbol === sym) || {};
  $("mktConn").innerHTML = window.__status
    ? `<span class="badge ${window.__status.connected ? "b-green" : "b-red"}">${window.__status.connected ? "CONNECTED" : "OFFLINE"}</span> ` +
      `<span class="badge ${/OPEN/i.test(window.__status.market || "") ? "b-green" : "b-gray"}">${esc(window.__status.market || "UNKNOWN")}</span>`
    : "—";
  $("mktWatchlist").textContent = boardRows.length + " enabled — auto-analysed every cycle";
  $("mktSpot").innerHTML = row.spot != null
    ? `${esc(sym)} <b>${num(row.spot)}</b> <span class="${row.change_pct >= 0 ? "up" : "down"}">${row.change_pct >= 0 ? "+" : ""}${num(row.change_pct)}%</span>`
    : "—";
  $("mktOption").textContent = s.strike && s.expiry
    ? `${esc(s.trading_symbol || sym)} ${s.strike} ${s.option_type} · ${esc(s.expiry)}` : "—";
  $("mktType").innerHTML = s.option_type
    ? `<span class="badge ${s.option_type === "CE" ? "b-green" : "b-pe"}">${s.option_type} (${s.option_type === "CE" ? "Call" : "Put"})</span>`
    : "—";
  $("mktStrat").textContent = s.strategy || "—";
  $("mktQLib").textContent = (s.qlib_direction || "—") +
    (s.confidence != null ? ` · conf ${conf}` : "") +
    (window.__status && window.__status.qlib.oos_ic != null
      ? ` · OOS IC ${window.__status.qlib.oos_ic}` : "");
  $("mktStatus").innerHTML = sig === "NO TRADE"
    ? `<span class="badge b-amber">NO TRADE</span>`
    : `<span class="badge b-green">ACTIVE — ${esc(sig)}</span>`;
}

function renderBoard() {
  const tb = $("boardBody");
  if (!boardRows.length) {
    tb.innerHTML = `<tr><td colspan="10" class="empty">No enabled watchlist symbols — add symbols on page 2 (or connect Upstox).</td></tr>`;
    return;
  }
  tb.innerHTML = boardRows.map(r => {
    const cls = r.signal === "NO TRADE" ? "b-amber" : (r.signal === "BUY PE" ? "b-pe" : "b-green");
    const viewCls = /Bull/i.test(r.qlib_view) ? "b-green" : (/Bear/i.test(r.qlib_view) ? "b-red" : "b-amber");
    return `<tr>
      <td class="symcell">${esc(r.symbol)}</td>
      <td>${num(r.spot)}</td>
      <td class="${r.change_pct >= 0 ? "up" : "down"}">${r.change_pct == null ? "—" : (r.change_pct >= 0 ? "+" : "") + num(r.change_pct) + "%"}</td>
      <td><span class="badge ${viewCls}">${esc(r.qlib_view)}</span></td>
      <td>${r.confidence != null ? Number(r.confidence).toFixed(2) : "—"}</td>
      <td style="text-align:left"><span class="badge ${cls}">${esc(r.signal)}</span></td>
      <td style="text-align:left">${r.strategy === "—" ? "—" : `<span class="badge ${/SMALL/i.test(r.strategy) ? "b-strat" : "b-blue"}">${esc(r.strategy)}</span>`}</td>
      <td>${esc(r.option)}</td>
      <td><span class="badge ${r.status === "ACTIVE" ? "b-green" : "b-gray"}">${esc(r.status)}</span></td>
      <td class="mono">${esc(r.time)}</td>
    </tr>`;
  }).join("");
}

function renderPlan() {
  const tb = $("planBody");
  if (!boardRows.length) {
    tb.innerHTML = `<tr><td colspan="16" class="empty">Waiting for watchlist…</td></tr>`;
    return;
  }
  tb.innerHTML = boardRows.map(r => {
    const s = boardSignals[r.symbol] || {};
    const active = s.signal && s.signal !== "NO TRADE";
    const strat = active
      ? `<span class="badge ${/SMALL/i.test(s.strategy || "") ? "b-strat" : "b-blue"}">${esc(s.strategy)}</span>`
      : "— (NO TRADE)";
    const entry = active ? `${inr(s.entry_min, 0)}–${inr(s.entry_max, 0)}` : "—";
    const qty = active ? `${num(s.quantity, 0)} (${s.lots}×${s.lot_size})` : "—";
    return `<tr>
      <td class="symcell">${esc(r.symbol)}</td>
      <td style="text-align:left">${strat}</td>
      <td>${entry}</td>
      <td>${active ? inr(s.t1) : "—"}</td>
      <td>${active ? inr(s.t2) : "—"}</td>
      <td>${active ? inr(s.t3) : "—"}</td>
      <td style="color:var(--red)">${active ? inr(s.sl) : "—"}</td>
      <td>${qty}</td>
      <td>${active ? num(s.lot_size, 0) : (r.lot || "—")}</td>
      <td>${active ? inr(s.capital) : "—"}</td>
      <td style="color:var(--red)">${active ? inr(s.max_risk) : "—"}</td>
      <td style="color:var(--green)">${active ? inr(s.gross) : "—"}</td>
      <td>${active ? inr(s.charges) : "—"}</td>
      <td style="color:var(--green)">${active ? "<b>" + inr(s.net) + "</b>" : "—"}</td>
      <td>${active ? num(s.rr, 2) : "—"}</td>
      <td>${active ? `<span class="badge b-green">OK</span>` : `<span class="badge b-amber">WAIT</span>`}</td>
    </tr>`;
  }).join("");
}

async function refreshDashboard() {
  try {
    const d = await api("/api/dashboard");
    boardRows = d.board || [];
    boardSignals = d.signals || {};
    const sel = $("planSymbol");
    const prev = sel.value;
    sel.innerHTML = boardRows.map(r => `<option>${esc(r.symbol)}</option>`).join("");
    if (prev && boardRows.some(r => r.symbol === prev)) sel.value = prev;
    renderBoard();
    renderPlan();
    renderSignalCard(sel.value);
  } catch (e) { /* page not dashboard */ }
}

/* ========================================================== WATCHLIST ===== */
async function refreshWatchlist() {
  const d = await api("/api/watchlist");
  const box = $("wlRows");
  if (!d.items.length) {
    box.innerHTML = `<div class="empty" style="padding:10px;color:var(--muted)">Watchlist empty — search and add symbols.</div>`;
  } else {
    box.innerHTML = d.items.map(w => `
      <div class="wl-row">
        <input type="checkbox" data-sym="${esc(w.symbol)}" class="wlEnable" ${w.enabled ? "checked" : ""}>
        <span class="sym">${esc(w.symbol)}</span>
        <span class="muted">spot</span><span class="price">${num(w.last_price)}</span>
        <span class="badge ${w.enabled ? "b-green" : "b-gray"}">${w.enabled ? "Enabled" : "Disabled — not analysed"}</span>
        <span class="acts"><button class="action danger wlRemove" data-sym="${esc(w.symbol)}">Remove</button></span>
      </div>`).join("");
    box.querySelectorAll(".wlEnable").forEach(el => el.addEventListener("change", async () => {
      await api("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", symbol: el.dataset.sym, enabled: el.checked }) });
      refreshWatchlist(); refreshChainOptions();
    }));
    box.querySelectorAll(".wlRemove").forEach(el => el.addEventListener("click", async () => {
      await api("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", symbol: el.dataset.sym }) });
      refreshWatchlist(); refreshChainOptions();
    }));
  }
  // lot sizes from instruments master (real values, never hardcoded)
  const lotBody = $("lotBody");
  if (lotBody) {
    const lots = d.lots || [];
    if (!lots.length) {
      lotBody.innerHTML = `<tr><td colspan="3" class="empty">No watchlist symbols yet.</td></tr>`;
    } else {
      lotBody.innerHTML = lots.map(l => `<tr>
        <td class="symcell" style="text-align:left">${esc(l.symbol)}</td>
        <td>${l.lot ? "<b>" + l.lot + "</b>" : "download instruments"}</td>
        <td>${l.step != null ? num(l.step, 0) : "—"}</td></tr>`).join("");
    }
  }
}

async function searchUnderlyings() {
  const q = $("wlSearch").value.trim();
  if (!q) { $("wlResults").innerHTML = ""; return; }
  const d = await api("/api/watchlist?q=" + encodeURIComponent(q));
  $("wlResults").innerHTML = (d.results || []).map(r => `
    <div class="wl-row"><span class="sym">${esc(r.symbol)}</span>
    <span class="muted">lot ${r.lot || "—"}</span>
    <span class="acts"><button class="action wlAdd" data-sym="${esc(r.symbol)}">Add</button></span></div>`).join("")
    || `<div class="muted" style="padding:4px 0">No match — download instruments (Settings) first.</div>`;
  $("wlResults").querySelectorAll(".wlAdd").forEach(el => el.addEventListener("click", async () => {
    await api("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", symbol: el.dataset.sym }) });
    $("wlResults").innerHTML = "";
    $("wlSearch").value = "";
    refreshWatchlist(); refreshChainOptions();
  }));
}

async function refreshChainOptions() {
  const d = await api("/api/watchlist");
  const enabled = d.items.filter(w => w.enabled).map(w => w.symbol);
  const sel = $("chainSymbol");
  const prev = sel.value;
  sel.innerHTML = enabled.map(s => `<option>${esc(s)}</option>`).join("") || `<option disabled>No enabled symbols</option>`;
  if (prev && enabled.includes(prev)) sel.value = prev;
  if (enabled.length) loadChain();
}

function cell(v, d = 2) { return `<td>${num(v, d)}</td>`; }

async function loadChain() {
  const sym = $("chainSymbol").value;
  if (!sym) return;
  try {
    const c = await api("/api/chain?symbol=" + encodeURIComponent(sym));
    $("chSpot").textContent = num(c.spot);
    $("chATM").textContent = c.atm != null ? Number(c.atm).toLocaleString("en-IN") : "—";
    $("chExpiry").textContent = c.expiry || "—";
    $("chLot").textContent = c.lot_size || "—";
    $("chRange").textContent = `ATM ±${c.range} strikes`;
    $("chFresh").textContent = c.fresh ? "● LIVE" : (c.ts ? "STALE" : "—");
    $("chFresh").className = "badge " + (c.fresh ? "b-green" : "b-amber");
    const tb = $("chainBody");
    if (!c.rows.length) {
      tb.innerHTML = `<tr><td colspan="27" class="empty">${esc(c.message || "No rows")}</td></tr>`;
      return;
    }
    tb.innerHTML = c.rows.map(r => {
      const ce = r.ce || {}, pe = r.pe || {};
      const atm = r.strike === c.atm ? ' class="atm"' : "";
      const f = (v, d = 2) => (v == null ? "—" : num(v, d));
      return `<tr${atm}><td>${Number(r.strike).toLocaleString("en-IN")}</td>
        <td><b>${f(ce.premium)}</b></td>${cell(ce.bid)}${cell(ce.ask)}${cell(ce.spread)}
        <td>${f(ce.oi, 0)}</td><td>${f(ce.chg_oi, 0)}</td><td>${f(ce.volume, 0)}</td>
        <td>${f(ce.iv, 2)}</td>${cell(ce.delta)}${cell(ce.gamma, 4)}${cell(ce.theta)}${cell(ce.vega)}<td>${f(ce.ltq, 0)}</td>
        <td><b>${f(pe.premium)}</b></td>${cell(pe.bid)}${cell(pe.ask)}${cell(pe.spread)}
        <td>${f(pe.oi, 0)}</td><td>${f(pe.chg_oi, 0)}</td><td>${f(pe.volume, 0)}</td>
        <td>${f(pe.iv, 2)}</td>${cell(pe.delta)}${cell(pe.gamma, 4)}${cell(pe.theta)}${cell(pe.vega)}<td>${f(pe.ltq, 0)}</td></tr>`;
    }).join("");
  } catch (e) {
    $("chainBody").innerHTML = `<tr><td colspan="27" class="empty">${esc(e.message || e)}</td></tr>`;
  }
}

/* ========================================================== QLIB PAGE ===== */
async function refreshQLibModel() {
  try {
    const d = await api("/api/qlib/model");
    const m = d.metrics || {}, st = d.state || {}, row = d.row || {};
    $("mdStatus").innerHTML = `<span class="badge ${st.ready ? "b-green" : "b-amber"}">${esc(st.status || "IDLE")}</span>`;
    $("mdTrained").textContent = (row.ts ? new Date(row.ts).toLocaleString() : "—") +
      (m.rows_total ? ` · ${m.rows_total} rows · ${m.instruments} contracts` : "");
    $("mdFeed").innerHTML = `<span class="badge b-green">ON</span> all watchlist symbols pushed every cycle`;
    $("mdMetrics").innerHTML = (m.oos_ic != null)
      ? `IC ${m.oos_ic} · acc ${m.oos_dir_acc} (baseline ${m.random_baseline}) · rows ${m.oos_rows}`
      : "— (model not trained yet)";
    $("mdBacktest").innerHTML = (m.oos_win_rate != null)
      ? `win-rate ${m.oos_win_rate} · avg R ${m.oos_avg_r} · ` +
        `<span class="badge ${m.passed ? "b-green" : "b-red"}">${m.passed ? "PASSED" : "NOT PASSED"}</span>`
      : "—";
    $("mdRetrain").textContent = "Daily 16:00 + on new data · below gate → NO TRADE";
    $("mdMessage").textContent = st.message || "—";
  } catch (e) { /* ignore */ }
}

async function refreshQLibRows() {
  try {
    const sym = $("qlibFilter").value || "ALL";
    const d = await api("/api/qlib/rows?symbol=" + encodeURIComponent(sym));
    const tb = $("qlibBody");
    if (!d.rows.length) {
      tb.innerHTML = `<tr><td colspan="16" class="empty">No analysis yet — automatic Qlib analysis runs once live data is collected and the model is validated.</td></tr>`;
      return;
    }
    tb.innerHTML = d.rows.map(r => {
      const st = r.status || "";
      const cls = /^SELECTED/.test(st) ? "b-green" : (/^CANDIDATE/.test(st) ? "b-blue" : "b-gray");
      const dirCls = /Bull/.test(r.direction || "") ? "b-green" : (/Bear/.test(r.direction || "") ? "b-red" : "b-gray");
      const conf = r.confidence != null ? Number(r.confidence).toFixed(2) : "—";
      const strat = r.strategy_type
        ? (/SMALL/i.test(r.strategy_type) ? `<span class="badge b-strat">SMALL-PREMIUM QUICK-MOVE</span>`
          : `<span class="badge b-blue">NORMAL OPTION BUY</span>`) : "—";
      return `<tr data-sym="${esc(r.symbol)}">
        <td class="symcell">${esc(r.symbol)}</td>
        <td>${r.strike != null ? Number(r.strike).toLocaleString("en-IN") : "—"}</td>
        <td><b>${esc(r.option_type)}</b></td>
        <td>${r.premium != null ? inr(r.premium) : "—"}</td>
        <td><span class="badge ${dirCls}">${esc(r.direction || "—")} ${conf}</span></td>
        <td>${esc(r.momentum || "—")}</td>
        <td>${esc(r.volume_state || "—")}</td>
        <td>${esc(r.oi_state || "—")}</td>
        <td>${r.iv != null ? num(r.iv, 2) : "—"}</td>
        <td>${r.delta != null ? num(r.delta, 2) : "—"}</td>
        <td>${esc(r.liquidity || "—")}</td>
        <td>${esc(r.activity || "—")}</td>
        <td>${r.expected_move != null ? inr(r.expected_move) : "—"}</td>
        <td>${r.risk_reward != null ? "1 : " + num(r.risk_reward, 2) : "—"}</td>
        <td>${strat}</td>
        <td><span class="badge ${cls}" title="${esc(r.reason || "")}">${esc(st)}</span></td>
      </tr>`;
    }).join("");
  } catch (e) { /* ignore */ }
}

async function fillQLibFilter() {
  const d = await api("/api/watchlist");
  const sel = $("qlibFilter");
  const prev = sel.value;
  sel.innerHTML = `<option value="ALL">ALL SYMBOLS (table view)</option>` +
    d.items.filter(w => w.enabled).map(w => `<option>${esc(w.symbol)}</option>`).join("");
  if (prev) sel.value = prev;
}

/* ========================================================== SETTINGS ====== */
async function loadSettings() {
  const d = await api("/api/settings");
  const s = d.settings, b = d.broker;
  // Don't clobber fields the user is currently typing into (10s poller).
  const typing = document.activeElement && document.activeElement.tagName === "INPUT";
  if (!typing) {
    $("apiKey").value = b.api_key || "";
    $("apiSecret").value = b.api_secret || "";
    $("redirectUrl").value = b.redirect_url || "";
    $("setAtmRange").value = s.atm_range;
    $("setPremMin").value = s.small_premium_min;
    $("setPremMax").value = s.small_premium_max;
    $("setMaxRisk").value = s.max_risk;
    $("setMaxCapital").value = s.max_capital;
    $("setMinRr").value = s.min_rr;
    $("setMaxLots").value = s.max_lots;
  }
  $("brokerStatus").innerHTML = b.connected
    ? `<span class="badge b-green">CONNECTED</span> token until ${esc(b.token_expiry || "?")}`
    : `<span class="badge b-red">NOT CONNECTED</span>`;
  const st = window.__status;
  $("brokerInstruments").textContent = (st && st.instruments)
    ? `${st.instruments.toLocaleString("en-IN")} rows in SQLite`
    : "not downloaded yet";
}

async function refreshLogs() {
  try {
    const d = await api("/api/logs?limit=50");
    const cls = l => l === "error" ? "err" : (l === "warn" ? "warn" : "ok");
    const html = d.logs.map(l =>
      `<div><span class="t">${new Date(l.ts).toLocaleTimeString()}</span> ` +
      `<span class="${cls(l.level)}">${esc((l.source || "").toUpperCase())}</span> ${esc(l.message)}</div>`
    ).join("") || `<div class="muted">No log entries yet.</div>`;
    $("logsBox").innerHTML = html;
    const ol = $("oauthLog");
    if (ol) ol.innerHTML = d.logs.filter(l => ["oauth", "instr", "ws", "api"].includes((l.source || "").toLowerCase()))
      .slice(-8).map(l =>
        `<div><span class="t">${new Date(l.ts).toLocaleTimeString()}</span> ` +
        `<span class="${cls(l.level)}">${esc((l.source || "").toUpperCase())}</span> ${esc(l.message)}</div>`
      ).join("") || `<div class="muted">Auth log empty.</div>`;
  } catch (e) { /* ignore */ }
}

function wireSettings() {
  $("btnSaveSettings").addEventListener("click", async () => {
    const settings = {
      atm_range: $("setAtmRange").value, small_premium_min: $("setPremMin").value,
      small_premium_max: $("setPremMax").value, max_risk: $("setMaxRisk").value,
      max_capital: $("setMaxCapital").value, min_rr: $("setMinRr").value,
      max_lots: $("setMaxLots").value,
    };
    await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }) });
    $("settingsMsg").textContent = "Saved ✔";
    setTimeout(() => $("settingsMsg").textContent = "", 2500);
  });

  const saveCreds = async () => {
    const body = {
      api_key: $("apiKey").value.trim(),
      api_secret: $("apiSecret").value.trim(),
      redirect_url: $("redirectUrl").value.trim(),
    };
    await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    return body;
  };

  $("btnSaveCreds").addEventListener("click", async () => {
    try {
      await saveCreds();
      $("credsMsg").textContent = "Saved ✔";
      setTimeout(() => $("credsMsg").textContent = "", 2500);
      refreshLogs();
    } catch (e) { alert("Save failed: " + e.message); }
  });

  $("btnConnect").addEventListener("click", async () => {
    try {
      await saveCreds();
      const d = await api("/api/connect", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      if (d.auth_url) window.location.href = d.auth_url;
    } catch (e) { alert("CONNECT failed: " + e.message); }
  });
  $("btnDisconnect").addEventListener("click", async () => {
    await api("/api/disconnect", { method: "POST" });
    loadSettings(); refreshLogs();
  });
  $("btnInstruments").addEventListener("click", async () => {
    try {
      await saveCreds();
      const d = await api("/api/instruments/refresh", { method: "POST" });
      $("settingsMsg").textContent = d.message || "started";
    } catch (e) { alert(e.message); }
  });
}

/* ============================================================ bootstrap === */
document.addEventListener("DOMContentLoaded", () => {
  pollStatus();
  setInterval(pollStatus, 6000);
  const page = document.body.dataset.page;

  if (page === "dashboard") {
    $("planSymbol").addEventListener("change", () => renderSignalCard($("planSymbol").value));
    refreshDashboard();
    setInterval(refreshDashboard, 6000);
  }

  if (page === "watchlist") {
    refreshWatchlist();
    refreshChainOptions();
    $("wlSearchBtn").addEventListener("click", searchUnderlyings);
    $("wlAddBtn").addEventListener("click", searchUnderlyings);
    $("wlSearch").addEventListener("keydown", e => { if (e.key === "Enter") searchUnderlyings(); });
    $("chainSymbol").addEventListener("change", loadChain);
    setInterval(loadChain, 8000);
  }

  if (page === "qlib") {
    fillQLibFilter();
    refreshQLibModel();
    refreshQLibRows();
    $("qlibFilter").addEventListener("change", refreshQLibRows);
    $("qlibRunBtn").addEventListener("click", async () => {
      const d = await api("/api/qlib/run", { method: "POST" });
      $("qlibRunStatus").textContent = (d.message || "queued") +
        " (automatic cycle already keeps this data current.)";
      setTimeout(refreshQLibModel, 4000);
    });
    $("qlibRetrainBtn").addEventListener("click", async () => {
      const d = await api("/api/qlib/run", { method: "POST" });
      $("qlibRunStatus").textContent = d.message || "queued";
      setTimeout(refreshQLibModel, 4000);
    });
    setInterval(() => { refreshQLibModel(); refreshQLibRows(); }, 10000);
  }

  if (page === "settings") {
    loadSettings();
    refreshLogs();
    wireSettings();
    setInterval(() => { refreshLogs(); }, 8000);
    setInterval(loadSettings, 10000);
  }
});
