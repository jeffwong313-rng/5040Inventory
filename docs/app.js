// Count Team Companion: pick your team -> see your assignment for each round
// -> open the map with your zones lit up. Reads the inventory Google Sheet
// directly (it is shared "anyone with the link can view"), so it needs no
// server of its own and runs fine on GitHub Pages.
import {
  parseCountTeams, parseTeamSpecific, teamList, findTeam, fullName,
  parseAssignment, resolveSpecs, resolveMfrs, assignmentText,
} from "./zones.js";
import { MapView } from "./map.js";
import { initQuestion, openQuestion } from "./question.js";

const CONFIG = {
  sheetId: "1eSonYt5Fyxyune85dnnntaunvOupIzBN6eMEhFrHnU8",
  gidCountTeams: "208058828",
  gidTeamSpecific: "293732955",
  refreshMs: 30000,
  roundMs: 10000, // how often to check which round the manager has everyone on
  // The Render server relays "Question" calls to the manager page.
  apiBase: "https://warehouse-inventory-dashboard.onrender.com",
  managerName: "Jeff",
};
const csvUrl = (gid) =>
  `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/export?format=csv&gid=${gid}`;

const state = {
  phases: [],
  specific: {},
  teams: [],
  map: null,
  phaseIdx: 0,
  lastSync: 0,
  error: null,
  mapView: null,
  mapKey: null,
  whKey: null,
  round: null, // manager's "everyone is on this round": { phase, label, setAt }
};

const $app = document.getElementById("app");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/* ------------------------------------------------------------ data */

async function fetchText(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function loadSheet() {
  try {
    const [ct, ts] = await Promise.all([
      fetchText(csvUrl(CONFIG.gidCountTeams)),
      fetchText(csvUrl(CONFIG.gidTeamSpecific)).catch(() => ""),
    ]);
    state.phases = parseCountTeams(ct);
    state.specific = ts ? parseTeamSpecific(ts) : {};
    state.teams = teamList(state.phases, state.specific);
    state.lastSync = Date.now();
    state.error = null;
  } catch (e) {
    state.error = e;
  }
}

async function loadMap() {
  if (state.map) return state.map;
  try {
    state.map = await fetch("data/map.json").then((r) => r.json());
  } catch {
    state.map = { tabs: [] };
  }
  return state.map;
}

/* ---------------------------------------------------- manager's round */

// The manager page has a switch that moves everyone to a round at once
// (PreCounts -> First Count -> Variance ...). The server holds it; this
// phone follows it, and warns before showing a different round.
const ROUND_MAX_AGE_S = 18 * 3600;

function roundKey(name) {
  let k = String(name || "").replace(/^\s*for\s+/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (k === "precount") k = "precounts";
  return k;
}

function liveIdx() {
  if (!state.round) return -1;
  return state.phases.findIndex((p) => roundKey(p.name) === state.round.phase);
}

function loadCachedRound() {
  try {
    const r = JSON.parse(store.get("round") || "null");
    if (r && r.phase && Date.now() / 1000 - r.setAt < ROUND_MAX_AGE_S) return r;
  } catch { /* ignore */ }
  return null;
}

async function fetchRound() {
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/round`, { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    // a server that just restarted reports nothing until the manager page
    // re-sends it; keep the last known round meanwhile
    if (data && data.phase) {
      state.round = data;
      store.set("round", JSON.stringify(data));
    }
  } catch { /* offline or server waking up: keep the last known round */ }
}

/** Jump to the manager's round. `force` = always (page load); otherwise only on a new switch. */
function followRound(force) {
  const i = liveIdx();
  if (i < 0) return false;
  const seen = store.get("roundSeen");
  const fresh = String(state.round.setAt) !== seen;
  if (!force && !fresh) return false;
  store.set("roundSeen", String(state.round.setAt));
  const moved = state.phaseIdx !== i;
  state.phaseIdx = i;
  store.set("phase", String(i));
  if (!force) roundToast(`${CONFIG.managerName} moved everyone to ${phaseLabel(state.phases[i])}`);
  return moved;
}

async function roundTick() {
  if (document.hidden) return;
  await fetchRound();
  if (followRound(false)) render();
  else refreshSeg();
}

function roundToast(text) {
  let el = document.getElementById("round-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "round-toast";
    el.className = "round-toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = `📣 ${text}`;
  el.classList.add("show");
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  clearTimeout(roundToast.t);
  roundToast.t = setTimeout(() => el.classList.remove("show"), 6000);
}

function confirmOffRound(wantedIdx, onYes) {
  const live = phaseLabel(state.phases[liveIdx()]);
  const wanted = phaseLabel(state.phases[wantedIdx]);
  let root = document.getElementById("round-root");
  if (!root) { root = document.createElement("div"); root.id = "round-root"; document.body.appendChild(root); }
  root.innerHTML = `
    <div class="q-overlay" id="rw-overlay">
      <div class="q-sheet round-warn" role="alertdialog" aria-modal="true" aria-labelledby="rw-title">
        <h2 id="rw-title">⚠️ Everyone is on ${esc(live)}</h2>
        <p class="q-sub">${esc(CONFIG.managerName)} moved everyone to <b>${esc(live)}</b>. Are you sure you want to look at ${esc(wanted)} instead?</p>
        <div class="q-actions">
          <button type="button" class="q-cancel" id="rw-go">Switch anyway</button>
          <button type="button" class="q-send rw-stay" id="rw-stay">Stay on ${esc(live)}</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ""; };
  document.getElementById("rw-stay").onclick = close;
  document.getElementById("rw-go").onclick = () => { close(); onYes(); };
  document.getElementById("rw-overlay").addEventListener("click", (e) => { if (e.target.id === "rw-overlay") close(); });
}

/* ---------------------------------------------------------- routing */

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return { team: parts[0] || null, view: parts[1] || "home" };
}
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };

function phaseLabel(p) {
  const n = p.name.replace(/^precounts?$/i, "PreCounts");
  return n;
}

/* ---------------------------------------------------------- screens */

function syncBadge() {
  const age = state.lastSync ? Math.round((Date.now() - state.lastSync) / 1000) : null;
  const stale = state.error || age == null || age > 120;
  const label = state.error && !state.lastSync ? "Offline" : age == null ? "…" : age < 10 ? "Live" : `${age < 60 ? age + "s" : Math.round(age / 60) + "m"} ago`;
  return `<span class="sync ${stale ? "stale" : ""}" id="sync"><span class="dot"></span>${label}</span>`;
}

function renderPicker() {
  const cards = state.teams.map((id) => {
    const p0 = state.phases.find((p) => findTeam(p, id));
    const t = p0 && findTeam(p0, id);
    return `<button class="team-pick" data-team="${esc(id)}">
      <span class="id">${esc(id)}</span>
      <span class="who">${esc(t ? t.members.join(", ") : "")}</span>
    </button>`;
  }).join("");
  $app.innerHTML = `
    <header class="bar"><h1>Inventory Count</h1>${syncBadge()}</header>
    <main class="page">
      <div class="hero"><h2>Which team are you on?</h2><p>Tap your team. This phone will remember it.</p></div>
      ${state.teams.length ? `<div class="team-grid">${cards}</div>` : errorOrEmpty()}
    </main>`;
  $app.querySelectorAll("[data-team]").forEach((b) =>
    b.addEventListener("click", () => {
      store.set("team", b.dataset.team);
      go(`#/${encodeURIComponent(b.dataset.team)}`);
    }));
}

function errorOrEmpty() {
  if (state.error) return `<div class="error-box"><b>Can't reach the sheet right now.</b>Check your signal. It will keep retrying.</div>`;
  return `<div class="error-box">No teams found yet.</div>`;
}

function phaseSeg() {
  if (!state.phases.length) return "";
  const live = liveIdx();
  return `<div class="seg" role="group" aria-label="Count round">${state.phases.map((p, i) =>
    `<button data-phase="${i}" aria-pressed="${i === state.phaseIdx}" class="${i === live ? "live" : ""}">${esc(phaseLabel(p))}</button>`).join("")}</div>`;
}

function bindPhaseSeg(after) {
  $app.querySelectorAll("[data-phase]").forEach((b) =>
    b.addEventListener("click", () => {
      const idx = +b.dataset.phase;
      if (idx === state.phaseIdx) return;
      const choose = () => {
        state.phaseIdx = idx;
        store.set("phase", String(state.phaseIdx));
        after();
      };
      const live = liveIdx();
      if (live >= 0 && idx !== live) confirmOffRound(idx, choose);
      else choose();
    }));
}

/** Update just the live-round dot without rebuilding the page. */
function refreshSeg() {
  const live = liveIdx();
  $app.querySelectorAll("[data-phase]").forEach((b) => b.classList.toggle("live", +b.dataset.phase === live));
}

function renderTeam(teamId) {
  const phase = state.phases[state.phaseIdx];
  const t = findTeam(phase, teamId);
  const anyT = state.phases.map((p) => findTeam(p, teamId)).find(Boolean);
  const spec = state.specific[teamId.toLowerCase()] || {};
  const members = (t || anyT)?.members || [];

  const assignment = t ? [t.zone, t.section].filter(Boolean).join(", ") : "";
  const mfrMain = !assignment && t?.mfr?.length;
  const kind = mfrMain ? "Manufacturers" : t?.zone != null ? "Zone" : "Section";
  const fields = [];
  if (t?.notes) fields.push(["Notes", esc(t.notes)]);
  if (t?.countTeam) fields.push(["Hands off to", esc(t.countTeam)]);
  if (t?.mfr?.length && !mfrMain) fields.push(["MFR", `<div class="chips">${t.mfr.map((m) => `<span class="chip">${esc(m)}</span>`).join("")}</div>`]);
  for (const [k, v] of Object.entries(t?.extra || {})) fields.push([esc(k), esc(v)]);
  if (spec.mapSection) fields.push(["Map section", esc(spec.mapSection)]);
  for (const [k, v] of Object.entries(spec.extra || {})) fields.push([esc(k), esc(v)]);

  const rolesCard = renderRolesCard(spec, state.phases.flatMap((p) => findTeam(p, teamId)?.members || []));

  const zl = phase?.zonesLeft || [];
  const mainLine = assignment
    ? `<p class="assign">${esc(assignment)}</p>`
    : t?.mfr?.length
      ? `<p class="assign">${esc(t.mfr.join(", "))}</p>`
      : `<p class="assign none">Nothing assigned for this round yet. Check back. This page updates on its own.</p>`;

  $app.innerHTML = `
    <header class="bar">
      <button class="back" id="switch">← Teams</button>
      <h1>${esc(teamId)}</h1>${syncBadge()}
    </header>
    <main class="page">
      <section class="team-head">
        <h2>${esc(teamId)}</h2>
        <p class="members">${members.length ? esc(members.join(" · ")) : "Members not listed yet"}</p>
      </section>
      ${rolesCard}
      ${phaseSeg()}
      <section class="card">
        <h3>${esc(phase ? phaseLabel(phase) : "Assignment")} · ${kind}</h3>
        ${phase?.description ? `<p class="desc">${esc(phase.description)}</p>` : ""}
        ${mainLine}
        ${fields.map(([k, v]) => `<div class="field"><b>${k}</b><span>${v}</span></div>`).join("")}
      </section>
      <div class="action-row">
        <button class="map-btn" id="open-map">🗺️ Open map</button>
        <button class="q-btn" id="ask">✋ Question</button>
      </div>
      ${zl.length ? `<section class="card"><h3>Zones left this round (${zl.length})</h3><div class="chips">${zl.map((z) => `<span class="chip">${esc(z)}</span>`).join("")}</div></section>` : ""}
      <p class="foot">Updates live from the inventory sheet.</p>
    </main>`;
  document.getElementById("switch").onclick = () => { store.set("team", null); go("#/"); };
  document.getElementById("open-map").onclick = () => go(`#/${encodeURIComponent(teamId)}/map`);
  document.getElementById("ask").onclick = () => askFor(teamId);
  bindPhaseSeg(() => renderTeam(teamId));
}

/** "Who does what" + team login, from the Team Specific tab. */
function renderRolesCard(spec, allMembers) {
  const R = spec.roles || {};
  const person = (key, fallback) => {
    const who = spec[key];
    if (!who) return "";
    const role = R[key] || { label: fallback, desc: "" };
    return `<div class="role-col role-${key}">
      <div class="role-label">${esc(role.label || fallback)}</div>
      <div class="role-name">${esc(fullName(who, allMembers))}</div>
      ${role.desc ? `<div class="role-desc">${esc(role.desc)}</div>` : ""}
    </div>`;
  };
  const cols = [person("counter", "Counter"), person("recorder", "Recorder"), person("third", "3rd Teammate")].filter(Boolean);
  const login = spec.login
    ? `<div class="login">
        <div class="login-head">Team login${spec.recorder ? ` <span>· the Recorder (${esc(fullName(spec.recorder, allMembers))}) signs in for the team</span>` : ""}</div>
        <div class="login-grid">
          <div><b>Username</b><code>${esc(spec.login.username)}</code></div>
          <div><b>Password</b><code>${esc(spec.login.password)}</code></div>
        </div>
      </div>`
    : "";
  if (!cols.length && !login) return "";
  return `<section class="card roles-card">
      <h3>Roles &amp; login</h3>
      ${cols.length ? `<div class="role-cols">${cols.join("")}</div>` : ""}
      ${login}
    </section>`;
}

function resolveFor(teamId) {
  const phase = state.phases[state.phaseIdx];
  const t = findTeam(phase, teamId);
  const spec = state.specific[teamId.toLowerCase()];
  const text = assignmentText(t, spec);
  if (text) return { text, ...resolveSpecs(parseAssignment(text), state.map) };
  if (t?.mfr?.length) return { text: t.mfr.join(", "), ...resolveMfrs(t.mfr, state.map) };
  return { text: "", byTab: {}, exact: {}, whole: new Set(), report: [] };
}

function renderMap(teamId) {
  const map = state.map;
  const res = resolveFor(teamId);
  const litFor = (key) => (res.whole.has(key) ? null : res.byTab[key] || new Set());
  const hasAny = (key) => res.whole.has(key) || (res.byTab[key] && res.byTab[key].size > 0);
  const key = `${teamId}|${state.phaseIdx}|${res.text}`;
  const changed = key !== state.mapKey;
  if (changed || !map.tabs.some((t) => t.key === state.whKey)) {
    state.whKey = (map.tabs.find((t) => hasAny(t.key)) || map.tabs[0] || {}).key;
  }

  const legend = res.report.length
    ? `<div>Your ${res.report.some((r) => r.mfr) ? "manufacturers" : "zones"}:</div><div class="chips">${res.report.map((r) =>
        `<span class="chip ${!r.found ? "miss" : r.approx ? "approx" : ""}" title="${!r.found ? "Not found on the map" : r.approx ? "Shown as the whole colour area" : ""}">${esc(r.label)}${!r.found ? " (not on map)" : r.approx ? " ≈" : ""}</span>`).join("")}</div>`
    : `<div>No zones for this round yet, so the whole map is shown.</div>`;

  $app.innerHTML = `
    <div class="map-page">
      <header class="bar">
        <button class="back" id="back">← ${esc(teamId)}</button>
        <h1>Map</h1>${syncBadge()}
        <button class="q-mini" id="ask" aria-label="Question: call ${esc(CONFIG.managerName)}">✋ Question</button>
      </header>
      <div class="map-controls">
        ${phaseSeg()}
        <div class="wh-tabs" role="group" aria-label="Warehouse">${map.tabs.map((t) =>
          `<button data-wh="${esc(t.key)}" class="${hasAny(t.key) ? "has" : ""}" aria-pressed="${t.key === state.whKey}">${esc(t.name)}</button>`).join("")}</div>
      </div>
      <div class="map-stage" id="stage">
        <div class="zoom-tools">
          <button id="zin" aria-label="Zoom in">+</button>
          <button id="zout" aria-label="Zoom out">−</button>
          <button id="zmine" class="wide" aria-label="Zoom to my zones">Mine</button>
          <button id="zall" class="wide" aria-label="Show whole map">All</button>
        </div>
      </div>
      <div class="map-legend">${legend}</div>
    </div>`;

  document.getElementById("back").onclick = () => go(`#/${encodeURIComponent(teamId)}`);
  document.getElementById("ask").onclick = () => askFor(teamId);
  bindPhaseSeg(() => renderMap(teamId));
  $app.querySelectorAll("[data-wh]").forEach((b) =>
    b.addEventListener("click", () => { state.whKey = b.dataset.wh; state.mapKey = null; renderMap(teamId); state.mapKey = key; }));

  const stage = document.getElementById("stage");
  const tab = map.tabs.find((t) => t.key === state.whKey);
  if (!tab) { stage.insertAdjacentHTML("beforeend", `<div class="map-empty">The map hasn't been generated yet.</div>`); return; }
  const prevView = !changed && state.mapView && state.mapView.tab === tab ? { ...state.mapView.view } : null;
  if (state.mapView) state.mapView.destroy();
  const mv = new MapView(stage);
  stage.insertBefore(mv.svg, stage.firstChild);
  const lit = litFor(tab.key);
  mv.render(tab, lit);
  state.mapView = mv;
  const precise = res.exact && res.exact[tab.key] && res.exact[tab.key].size ? res.exact[tab.key] : lit;
  const box = precise && precise.size ? mv.litBox(precise) : null;
  const fitMine = (animate) => (box ? mv.fit(box, { animate }) : mv.fitWhole(animate));
  requestAnimationFrame(() => {
    if (prevView) { mv.view = prevView; mv._apply(); return; }
    mv.fitWhole(false);
    setTimeout(() => fitMine(true), box ? 350 : 0);
  });
  document.getElementById("zin").onclick = () => mv.zoomBy(1.5);
  document.getElementById("zout").onclick = () => mv.zoomBy(1 / 1.5);
  document.getElementById("zmine").onclick = () => fitMine(true);
  document.getElementById("zall").onclick = () => mv.fitWhole(true);
  if (!hasAny(tab.key) && res.report.length) {
    stage.insertAdjacentHTML("beforeend", `<div class="map-empty">None of your zones are in ${esc(tab.name)}. Look for the green dot on the other tabs.</div>`);
  }
  state.mapKey = key;
}

/* -------------------------------------------------------- question */

function askFor(teamId) {
  const phase = state.phases[state.phaseIdx];
  const t = findTeam(phase, teamId);
  const anyT = state.phases.map((p) => findTeam(p, teamId)).find(Boolean);
  const where = t ? [t.zone, t.section].filter(Boolean).join(", ") || (t.mfr || []).join(", ") : "";
  openQuestion({
    team: teamId,
    members: (t || anyT)?.members || [],
    phase: phase ? phaseLabel(phase) : "",
    assignment: where,
  });
}

/* ------------------------------------------------------------ main */

let lastRendered = "";
function render() {
  const r = route();
  if (!r.team) {
    const saved = store.get("team");
    if (saved && state.teams.includes(saved)) { location.replace(`#/${encodeURIComponent(saved)}`); return; }
    lastRendered = "picker";
    return renderPicker();
  }
  const teamId = state.teams.find((t) => t.toLowerCase() === r.team.toLowerCase()) || r.team;
  if (r.view === "map") {
    loadMap().then(() => { lastRendered = "map"; renderMap(teamId); });
    return;
  }
  lastRendered = "team";
  renderTeam(teamId);
}

function refreshSyncBadge() {
  const el = document.getElementById("sync");
  if (el) el.outerHTML = syncBadge();
}

async function tick() {
  const before = JSON.stringify([state.phases, state.specific]);
  await loadSheet();
  const after = JSON.stringify([state.phases, state.specific]);
  if (before !== after) {
    // don't rebuild the map (and lose the user's zoom) unless their data changed
    if (lastRendered === "map") {
      const r = route();
      const teamId = state.teams.find((t) => t.toLowerCase() === (r.team || "").toLowerCase()) || r.team;
      const res = resolveFor(teamId);
      if (`${teamId}|${state.phaseIdx}|${res.text}` !== state.mapKey) render();
    } else render();
  }
  refreshSyncBadge();
}

async function start() {
  initQuestion({ apiBase: CONFIG.apiBase, managerName: CONFIG.managerName, store, esc });
  const p = parseInt(store.get("phase") || "0", 10);
  state.phaseIdx = isNaN(p) ? 0 : p;
  state.round = loadCachedRound();
  await Promise.all([loadSheet(), fetchRound()]);
  if (state.phaseIdx >= state.phases.length) state.phaseIdx = 0;
  followRound(true); // opening the app always lands on the manager's round
  window.addEventListener("hashchange", render);
  render();
  loadMap();
  setInterval(() => { if (!document.hidden) tick(); }, CONFIG.refreshMs);
  setInterval(refreshSyncBadge, 5000);
  setInterval(roundTick, CONFIG.roundMs);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(); roundTick(); } });
}

start();
