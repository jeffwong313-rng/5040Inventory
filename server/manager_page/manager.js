// Manager page: live "Question" calls from the phone companion + a part
// lookup on the LPF tab. Everything goes through /api/manager/*, which
// needs the manager password (kept on this device after signing in).
(function () {
  "use strict";

  const POLL_MS = 3000;
  const REPEAT_ALERT_MS = 10000; // keep chiming while a call is unanswered
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // The private link is /m/<key>; the key in it is the password, so opening
  // the link signs you straight in. Nothing else links to this page.
  const linkKey = decodeURIComponent((location.pathname.match(/^\/m\/([^/]+)/) || [])[1] || "");
  let key = linkKey || store.get("mgrKey");
  let pollTimer = null;
  let seen = {};            // call id -> timesCalled already alerted
  let lastChime = 0;
  let serverOffset = 0;     // server clock - local clock, for "2m ago"
  let calls = [];
  let audio = null;

  /* ------------------------------------------------------------ api */
  async function api(path, opts = {}) {
    const r = await fetch(path, {
      ...opts,
      headers: { "X-Manager-Key": key || "", ...(opts.headers || {}) },
      cache: "no-store",
    });
    if (r.status === 401) { signOut("Wrong password."); throw new Error("401"); }
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).detail || msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return r.json();
  }

  /* ---------------------------------------------------------- login */
  function showLogin(msg) {
    $("main").hidden = true;
    $("login").hidden = false;
    $("login-error").textContent = msg || "";
    $("password").focus();
  }

  function signOut(msg) {
    key = null;
    store.set("mgrKey", null);
    clearInterval(pollTimer);
    showLogin(msg);
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    key = $("password").value;
    $("login-error").textContent = "Checking… (the server may take ~30s to wake up)";
    try {
      await api("/api/manager/check");
      store.set("mgrKey", key);
      $("password").value = "";
      unlockAudio(); // the sign-in tap counts as permission to play sound
      start();
    } catch (err) {
      if (err.message !== "401") $("login-error").textContent = err.message;
    }
  });
  $("signout").addEventListener("click", () => signOut());

  /* ---------------------------------------------------------- alerts */
  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch { audio = null; }
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(updateSoundBtn);
    }
    setTimeout(updateSoundBtn, 100);
  }

  function alertsReady() { return audio && audio.state === "running"; }

  function updateSoundBtn() {
    const b = $("sound");
    if (alertsReady()) { b.textContent = "🔔 Alerts on"; b.className = "pill on"; }
    else { b.textContent = "🔇 Turn on alerts"; b.className = "pill needs"; }
  }
  $("sound").addEventListener("click", () => { unlockAudio(); if (alertsReady()) chime(); });

  function chime() {
    if (!alertsReady()) return;
    const t0 = audio.currentTime;
    [[880, 0], [1175, 0.18], [880, 0.36], [1175, 0.54]].forEach(([f, dt]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.18);
    });
    lastChime = Date.now();
  }

  function notify(c) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const n = new Notification(`Question: ${c.team}`, {
        body: [c.note, c.assignment].filter(Boolean).join(" · ") || (c.members || []).join(", "),
        tag: c.id, renotify: true, requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }

  function handleAlerts() {
    const open = calls.filter((c) => c.status === "open");
    let fresh = false;
    for (const c of open) {
      if ((seen[c.id] || 0) < c.timesCalled) { fresh = true; notify(c); }
    }
    for (const c of calls) if (c.status === "open") seen[c.id] = c.timesCalled; else if (!(c.id in seen)) seen[c.id] = c.timesCalled;
    if (open.length && (fresh || Date.now() - lastChime > REPEAT_ALERT_MS)) chime();

    const banner = $("alert-banner");
    if (open.length) {
      banner.hidden = false;
      banner.textContent = `✋ ${open.map((c) => c.team).join(", ")} ${open.length === 1 ? "has a question" : "have questions"}`;
      document.title = `(${open.length}) ✋ Question · Manager`;
    } else {
      banner.hidden = true;
      document.title = "Manager · Inventory";
    }
    $("open-count").textContent = open.length || "";
  }

  /* ----------------------------------------------------------- calls */
  function ago(ts) {
    const s = Math.max(0, Math.round(Date.now() / 1000 + serverOffset - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  const STATUS = { open: "Waiting", ack: "On my way", done: "Done", cancelled: "Cancelled" };

  function renderCalls() {
    const el = $("calls");
    if (!calls.length) { el.innerHTML = `<div class="empty">No questions right now. This page will chime when a team taps “Question”.</div>`; return; }
    el.innerHTML = calls.map((c) => {
      const actions = c.status === "open"
        ? `<button class="btn-ack" data-act="ack" data-id="${esc(c.id)}">On my way</button><button class="btn-done" data-act="done" data-id="${esc(c.id)}">Done</button>`
        : c.status === "ack"
          ? `<button class="btn-done" data-act="done" data-id="${esc(c.id)}">Done</button>`
          : `<button class="btn-reopen" data-act="reopen" data-id="${esc(c.id)}">Reopen</button>`;
      return `<article class="call ${esc(c.status)}">
        <div class="call-top">
          <span class="call-team">${esc(c.team)}</span>
          <span class="call-age" title="${new Date(c.createdAt * 1000).toLocaleTimeString()}">${ago(c.createdAt)}${c.timesCalled > 1 ? ` · asked ${c.timesCalled}×` : ""}</span>
        </div>
        <div class="call-status">${STATUS[c.status] || esc(c.status)}</div>
        ${c.members?.length ? `<div class="call-who">${esc(c.members.join(" · "))}</div>` : ""}
        ${c.assignment ? `<div class="call-where"><b>${esc(c.phase || "Assignment")}:</b> ${esc(c.assignment)}</div>` : ""}
        ${c.note ? `<div class="call-note">“${esc(c.note)}”</div>` : ""}
        <div class="call-actions">${actions}</div>
      </article>`;
    }).join("");
  }

  $("calls").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    b.disabled = true;
    try {
      await api(`/api/manager/questions/${encodeURIComponent(b.dataset.id)}/${b.dataset.act}`, { method: "POST" });
    } catch { /* next poll shows the real state */ }
    poll();
  });

  async function poll() {
    pollRound();
    try {
      const data = await api("/api/manager/questions");
      serverOffset = data.now - Date.now() / 1000;
      calls = data.calls;
      $("conn").className = "conn ok";
      $("conn-text").textContent = "Live";
      renderCalls();
      handleAlerts();
    } catch (err) {
      if (err.message === "401") return;
      $("conn").className = "conn";
      $("conn-text").textContent = "Reconnecting…";
    }
  }

  /* ---------------------------------------------------- count round */
  // Everyone starts on the first round (PreCounts). Tapping a round here
  // moves the TV and every team phone to it. The last choice is kept on
  // this device and re-sent if the server restarted and forgot it.
  const FALLBACK_ROUNDS = ["PreCounts", "First Count", "Variance 1"];
  const RESEND_WITHIN_S = 18 * 3600;
  let rounds = FALLBACK_ROUNDS.slice();
  let round = null;        // server's { phase, label, setAt }
  let roundBusy = false;
  let roundErr = "";
  let lastRoundsFetch = 0;

  const roundKey = (name) => {
    let s = String(name || "").replace(/^\s*for\s+/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (s === "precount") s = "precounts";
    return s;
  };
  const prettyRound = (t) => String(t).replace(/^\s*for\s+/i, "").trim();

  async function loadRounds() {
    if (Date.now() - lastRoundsFetch < 30000) return;
    lastRoundsFetch = Date.now();
    try {
      const r = await fetch("/api/count-teams", { cache: "no-store" });
      const phases = await r.json();
      const names = (phases || []).map((p) => prettyRound(p.title)).filter(Boolean);
      if (names.length) rounds = names;
    } catch { /* keep the last list */ }
  }

  function liveIndex() {
    if (!round || !round.phase) return 0; // nobody has switched yet: first round
    const i = rounds.findIndex((n) => roundKey(n) === round.phase);
    return i;
  }

  function renderRound() {
    const live = liveIndex();
    $("round-btns").innerHTML = rounds.map((name, i) => {
      const official = /first|official/i.test(name) ? " <span class=\"rb-step\">official counts</span>" : "";
      const cls = i === live ? "live" : live >= 0 && i < live ? "done" : "";
      const step = i === live ? "● Everyone is here" : live >= 0 && i < live ? "Finished" : `Step ${i + 1}`;
      return `<button class="round-btn ${cls}" data-round="${esc(name)}" ${roundBusy ? "disabled" : ""}>
        <span class="rb-step">${step}</span><span class="rb-name">${esc(name)}</span>${official}</button>`;
    }).join("");
    const now = $("round-now");
    now.className = "round-now" + (roundErr ? " err" : "");
    if (roundErr) now.textContent = roundErr;
    else if (round && round.phase) {
      const at = new Date(round.setAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      now.innerHTML = `Everyone was moved to <b>${esc(round.label)}</b> at ${esc(at)}. Tap another round to move everyone again.`;
    } else {
      now.innerHTML = `Everyone starts on <b>${esc(rounds[0] || "PreCounts")}</b>. When official counts start, tap <b>${esc(rounds[1] || "First Count")}</b>.`;
    }
  }

  async function setRound(label, setAt) {
    const data = await api("/api/manager/round", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setAt ? { label, setAt } : { label }),
    });
    round = data;
    store.set("mgrRound", JSON.stringify({ label: data.label, setAt: data.setAt }));
    return data;
  }

  $("round-btns").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-round]");
    if (!b || roundBusy) return;
    const label = b.dataset.round;
    if (round && round.phase === roundKey(label)) return;
    if (!confirm(`Move everyone to ${label}?\n\nThe TV and every team phone will switch to ${label}.`)) return;
    roundBusy = true; roundErr = ""; renderRound();
    try { await setRound(label); }
    catch (err) { if (err.message !== "401") roundErr = `Couldn't switch: ${err.message}. Try again.`; }
    roundBusy = false; renderRound();
  });

  async function pollRound() {
    loadRounds();
    try {
      const r = await fetch("/api/round", { cache: "no-store" });
      round = await r.json();
      // server restarted and forgot? put back what this page last set
      let saved = null;
      try { saved = JSON.parse(store.get("mgrRound") || "null"); } catch { saved = null; }
      if (!round.phase && saved && saved.label && Date.now() / 1000 - saved.setAt < RESEND_WITHIN_S && !roundBusy) {
        await setRound(saved.label, saved.setAt);
      }
      roundErr = "";
    } catch { /* connection status shows in the top bar */ }
    if (!roundBusy) renderRound();
  }

  /* ---------------------------------------------------------- lookup */
  let lookupSeq = 0;
  let debounce = null;

  function highlight(text, q) {
    const words = q.toUpperCase().split(/\s+/).filter(Boolean);
    let out = esc(text);
    for (const w of words) {
      const i = out.toUpperCase().indexOf(esc(w).toUpperCase());
      if (i >= 0 && w.length > 0) out = out.slice(0, i) + "<mark>" + out.slice(i, i + esc(w).length) + "</mark>" + out.slice(i + esc(w).length);
    }
    return out;
  }

  async function runLookup() {
    const q = $("q").value.trim();
    const seq = ++lookupSeq;
    if (!q) { $("results").innerHTML = ""; $("lookup-meta").textContent = ""; return; }
    $("lookup-meta").textContent = "Searching…";
    try {
      const data = await api(`/api/manager/lookup?q=${encodeURIComponent(q)}`);
      if (seq !== lookupSeq) return;
      renderResults(data, q);
    } catch (err) {
      if (seq === lookupSeq && err.message !== "401") $("lookup-meta").textContent = `Lookup failed: ${err.message}`;
    }
  }

  // B..H = Mfr, Catalog #, Description, LPO Cost, UOM, OH Qty, Qty Avail
  const NUM_COLS = new Set([3, 5, 6]);
  const QTY_COLS = new Set([5, 6]);

  function renderResults(data, q) {
    const { headers, results, total } = data;
    const n = results.length;
    $("lookup-meta").textContent = n
      ? `${n === 50 ? "First 50" : n} match${n === 1 ? "" : "es"} for “${q}” · searched ${total.toLocaleString()} items`
      : `No match for “${q}” in MFR or Catalog # (${total.toLocaleString()} items searched).`;
    if (!n) { $("results").innerHTML = ""; return; }
    const norm = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const qn = norm(q);
    $("results").innerHTML = `<table>
      <thead><tr>${headers.map((h, i) => `<th class="${NUM_COLS.has(i) ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${results.map((r) => {
        const cat = norm(r[1]);
        const exact = cat === qn || norm(r[0]) + cat === qn;
        return `<tr class="${exact ? "exact" : ""}">${r.map((v, i) => {
          const cls = [i === 1 ? "cat" : "", NUM_COLS.has(i) ? "num" : "", QTY_COLS.has(i) && Number(v) === 0 && v !== "" ? "zero" : ""].filter(Boolean).join(" ");
          const shown = i <= 1 ? highlight(v, q) : esc(v);
          return `<td class="${cls}" data-label="${esc(headers[i])}"><span>${shown || "&nbsp;"}</span></td>`;
        }).join("")}</tr>`;
      }).join("")}</tbody></table>`;
  }

  $("lookup-form").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(debounce); runLookup(); });
  $("q").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(runLookup, 300); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("q") && !$("main").hidden) { e.preventDefault(); $("q").focus(); $("q").select(); }
  });

  /* ------------------------------------------------------------ main */
  function start() {
    $("login").hidden = true;
    $("main").hidden = false;
    updateSoundBtn();
    // browsers block sound until the page is clicked once after loading
    document.addEventListener("pointerdown", unlockAudio, { once: true });
    seen = {};
    lastRoundsFetch = 0;
    renderRound();
    poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
    $("q").focus();
  }

  if (key) start(); else showLogin();
})();
