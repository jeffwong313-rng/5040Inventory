// "Question" button: calls the manager over to the team.
//
// Tapping it opens a small sheet (optional note), then POSTs to the Render
// server, which alerts the manager page. The phone keeps a status strip at
// the bottom ("Sent" -> "On the way" -> gone) by polling its own call. The
// call id is remembered, so reloading the page doesn't lose it.

const POLL_MS = 5000;
const WAKE_TIMEOUT_MS = 75000; // free Render instance can take ~30-60s to wake

let cfg = null;
let pending = null; // { id, team, status }
let pollTimer = null;
const QUICK = ["Can't find a bin", "Count doesn't match", "Wrong / missing label", "Need equipment"];

const root = () => document.getElementById("q-root");

async function post(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WAKE_TIMEOUT_MS);
  try {
    const r = await fetch(cfg.apiBase + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

function save() {
  cfg.store.set("question", pending ? JSON.stringify(pending) : null);
}

/* ------------------------------------------------------- compose sheet */

export function openQuestion(info) {
  const { esc, managerName } = cfg;
  const again = pending && pending.team === info.team && (pending.status === "open" || pending.status === "ack");
  root().innerHTML = `
    <div class="q-overlay" id="q-overlay">
      <form class="q-sheet" id="q-form" role="dialog" aria-modal="true" aria-labelledby="q-title">
        <h2 id="q-title">${again ? `Call ${esc(managerName)} again?` : `Call ${esc(managerName)} over?`}</h2>
        <p class="q-sub">${esc(info.team)}${info.assignment ? ` · ${esc(info.assignment)}` : ""}</p>
        <div class="q-quick">${QUICK.map((q) => `<button type="button" class="chip" data-quick="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <textarea id="q-note" rows="2" maxlength="280" placeholder="What's it about? (optional)"></textarea>
        <p class="q-err" id="q-err" role="alert"></p>
        <div class="q-actions">
          <button type="button" class="q-cancel" id="q-close">Never mind</button>
          <button type="submit" class="q-send" id="q-send">✋ Send question</button>
        </div>
      </form>
    </div>`;
  const note = document.getElementById("q-note");
  root().querySelectorAll("[data-quick]").forEach((b) =>
    b.addEventListener("click", () => { note.value = b.dataset.quick; note.focus(); }));
  const close = () => { root().innerHTML = ""; renderStrip(); };
  document.getElementById("q-close").onclick = close;
  document.getElementById("q-overlay").addEventListener("click", (e) => { if (e.target.id === "q-overlay") close(); });
  document.getElementById("q-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const send = document.getElementById("q-send");
    send.disabled = true;
    send.textContent = "Sending…";
    const slow = setTimeout(() => { send.textContent = "Waking up the server… hang on"; }, 4000);
    try {
      const res = await post("/api/question", { ...info, note: note.value.trim() });
      pending = { id: res.id, team: info.team, status: res.status, at: Date.now() };
      save();
      if (navigator.vibrate) navigator.vibrate(60);
      root().innerHTML = "";
      renderStrip();
      startPolling();
    } catch (err) {
      document.getElementById("q-err").textContent =
        "Couldn't send. Check your signal and try again, or find a manager in person.";
      send.disabled = false;
      send.textContent = "✋ Try again";
    } finally {
      clearTimeout(slow);
    }
  });
}

/* --------------------------------------------------------- status strip */

function renderStrip() {
  if (document.getElementById("q-overlay")) return; // sheet is open
  const { esc, managerName } = cfg;
  if (!pending) { root().innerHTML = ""; return; }
  const s = pending.status;
  let text, cls;
  if (s === "ack") { text = `👍 ${esc(managerName)} saw it and is on the way`; cls = "ack"; }
  else if (s === "done") { text = `✅ ${esc(managerName)} marked your question done`; cls = "done"; }
  else { text = `✋ Question sent. ${esc(managerName)} has been alerted. Stay put.`; cls = "open"; }
  root().innerHTML = `
    <div class="q-strip ${cls}" role="status">
      <span>${text}</span>
      ${s === "done" ? `<button id="q-dismiss">OK</button>` : `<button id="q-cancel">Cancel</button>`}
    </div>`;
  const cancel = document.getElementById("q-cancel");
  if (cancel) cancel.onclick = async () => {
    const id = pending.id;
    pending = null; save(); stopPolling(); renderStrip();
    try { await post(`/api/question/${encodeURIComponent(id)}/cancel`); } catch { /* best effort */ }
  };
  const dismiss = document.getElementById("q-dismiss");
  if (dismiss) dismiss.onclick = () => { pending = null; save(); renderStrip(); };
}

async function check() {
  if (!pending || document.hidden) return;
  try {
    const r = await fetch(`${cfg.apiBase}/api/question/${encodeURIComponent(pending.id)}`, { cache: "no-store" });
    if (!r.ok) return;
    const { status } = await r.json();
    if (!pending) return;
    if (status === "cancelled") { pending = null; save(); stopPolling(); renderStrip(); return; }
    if (status !== pending.status) {
      pending.status = status;
      save();
      if (status === "ack" && navigator.vibrate) navigator.vibrate([80, 60, 80]);
      renderStrip();
    }
    if (status === "done") {
      stopPolling();
      setTimeout(() => { if (pending && pending.status === "done") { pending = null; save(); renderStrip(); } }, 15000);
    }
  } catch { /* offline: keep showing the last status */ }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(check, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

export function initQuestion(options) {
  cfg = options;
  try { pending = JSON.parse(cfg.store.get("question") || "null"); } catch { pending = null; }
  // forget calls older than 2 hours (e.g. yesterday's)
  if (pending && Date.now() - (pending.at || 0) > 2 * 3600 * 1000) { pending = null; save(); }
  renderStrip();
  if (pending && pending.status !== "done") { startPolling(); check(); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}
