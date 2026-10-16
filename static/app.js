(() => {
  "use strict";

  const POLL_MS = 15000;

  const state = {
    activePhaseTitle: null,
    filterText: "",
    countTeams: [],
    timeline: null,
  };

  const $ = (id) => document.getElementById(id);

  // ---------------- fetch + poll ----------------

  async function loadDashboard() {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      render(data);
    } catch (err) {
      setSyncStatus({ error: String(err), stale: true });
    }
  }

  function render(data) {
    state.timeline = data.timeline || null;
    renderSyncStatus(data.source, data.timeline);
    renderTimeline(data.timeline);
    renderTeams(data.countTeams);
    renderBins(data.bins);
  }

  function renderSyncStatus(source, timeline) {
    $("event-date").textContent = timeline && timeline.date
      ? timeline.date
      : "No date set yet";
    setSyncStatus(source || {});
  }

  // ---------------- header clock ----------------

  function formatClock(date) {
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${hours}:${minutes} ${ampm}`;
  }

  function tickClock() {
    $("header-clock").textContent = formatClock(new Date());
  }

  function setSyncStatus(source) {
    const el = $("sync-status");
    const dot = $("sync-dot");
    const label = $("sync-label");
    const banner = $("stale-banner");
    el.classList.remove("ok", "stale", "error");

    if (source.error && source.stale) {
      el.classList.add("error");
      label.textContent = "Can't reach the sheet";
      banner.hidden = false;
    } else if (source.stale) {
      el.classList.add("stale");
      label.textContent = "Data may be stale";
      banner.hidden = false;
    } else {
      el.classList.add("ok");
      label.textContent = source.lastSuccessAt
        ? `Synced ${timeAgo(source.lastSuccessAt)}`
        : "Connecting…";
      banner.hidden = true;
    }
  }

  function timeAgo(isoString) {
    const then = new Date(isoString).getTime();
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 5) return "just now";
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    return `${mins}m ago`;
  }

  // ---------------- timeline ----------------

  function renderTimeline(timeline) {
    const track = $("timeline-track");
    const entries = (timeline && timeline.entries) || [];
    if (entries.length === 0) {
      track.innerHTML = '<p class="empty-state">No timeline entries yet.</p>';
      return;
    }

    // Only treat an entry as "happening now" / "already passed" on the
    // actual event day -- otherwise every day would show some entry as
    // current just because its clock time matches, which is misleading
    // before/after the real count day.
    const eventDate = parseEventDate(timeline && timeline.date);
    const isEventDay = eventDate ? isSameCalendarDay(eventDate, new Date()) : false;
    const nowIdx = isEventDay ? closestPastEntryIndex(entries) : -1;

    track.innerHTML = entries
      .map((e, i) => {
        const isNow = i === nowIdx;
        const isPast = nowIdx !== -1 && i < nowIdx && parseClockTime(e.time) != null;
        const cls = ["timeline-item", isBreakEntry(e) && "break", isNow && "now", isPast && "past"]
          .filter(Boolean).join(" ");
        return `
          <div class="${cls}">
            <div class="t-time">${escapeHtml(e.time || "")}</div>
            <div class="t-event">${escapeHtml(e.event || "")}</div>
            ${e.notes ? `<div class="t-notes">${escapeHtml(e.notes)}</div>` : ""}
          </div>`;
      })
      .join("");

    // keep the current event in view (centred) without a visible scrollbar;
    // before/after the event day, start from the first entry
    const nowEl = track.querySelector(".timeline-item.now");
    const target = nowEl
      ? Math.max(0, nowEl.offsetLeft - (track.clientWidth - nowEl.offsetWidth) / 2)
      : 0;
    if (Math.abs(track.scrollLeft - target) > 2) {
      track.scrollTo({ left: target, behavior: "smooth" });
    }
  }

  // Lunch / dinner / any "break" row in the sheet is shown in red so it's
  // obvious on the TV when everyone is off the floor.
  const BREAK_RE = /\b(lunch|dinner|break)\b/i;
  function isBreakEntry(e) {
    return BREAK_RE.test(`${e.event || ""} ${e.notes || ""}`);
  }

  // When official counts start on the event day: the Timeline entry that
  // mentions "official count" (12:30 PM in the sheet), else 12:30 PM.
  const DEFAULT_OFFICIAL_START = 12 * 60 + 30;
  function officialCountStart(timeline) {
    const eventDate = parseEventDate(timeline && timeline.date);
    if (!eventDate) return null;
    const entry = ((timeline && timeline.entries) || []).find((e) =>
      /official\s*count/i.test(`${e.event || ""} ${e.notes || ""}`) && parseClockTime(e.time) != null);
    const mins = entry ? parseClockTime(entry.time) : DEFAULT_OFFICIAL_START;
    const start = new Date(eventDate);
    start.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return start;
  }

  function precountsOver() {
    const start = officialCountStart(state.timeline);
    return start != null && Date.now() >= start.getTime();
  }

  function closestPastEntryIndex(entries) {
    const now = new Date();
    let bestIdx = -1;
    let bestDiff = Infinity;
    entries.forEach((e, i) => {
      const t = parseClockTime(e.time);
      if (t == null) return;
      const diff = now.getHours() * 60 + now.getMinutes() - t;
      if (diff >= 0 && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    return bestIdx;
  }

  function parseClockTime(text) {
    if (!text) return null;
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(text.trim());
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const ampm = (m[3] || "").toUpperCase();
    if (ampm === "PM" && hours !== 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  const MONTH_NAMES = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];

  function parseEventDate(text) {
    if (!text) return null;
    const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
    if (!m) return null;
    const monthIdx = MONTH_NAMES.indexOf(m[1].toLowerCase());
    if (monthIdx === -1) return null;
    return new Date(parseInt(m[3], 10), monthIdx, parseInt(m[2], 10));
  }

  function isSameCalendarDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  // ---------------- count teams ----------------

  function renderTeams(phases) {
    state.countTeams = phases || [];
    const tabsEl = $("phase-tabs");

    if (state.countTeams.length === 0) {
      tabsEl.innerHTML = "";
      $("teams-scroll").innerHTML = '<p class="empty-state">No teams set up yet.</p>';
      return;
    }

    if (!state.activePhaseTitle || !state.countTeams.some((p) => p.title === state.activePhaseTitle)) {
      state.activePhaseTitle = state.countTeams[0].title;
    }

    tabsEl.innerHTML = state.countTeams
      .map(
        (p) => `<button class="phase-tab${p.title === state.activePhaseTitle ? " active" : ""}" data-title="${escapeAttr(p.title)}">${escapeHtml(p.title.replace(/^For /i, ""))}</button>`
      )
      .join("");

    tabsEl.querySelectorAll(".phase-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activePhaseTitle = btn.dataset.title;
        tabsEl.querySelectorAll(".phase-tab").forEach((b) => {
          b.classList.toggle("active", b.dataset.title === state.activePhaseTitle);
        });
        renderTeamCards();
      });
    });

    renderTeamCards();
  }

  function renderTeamCards() {
    const container = $("teams-scroll");
    const phase = state.countTeams.find((p) => p.title === state.activePhaseTitle);
    if (!phase || phase.teams.length === 0) {
      container.innerHTML = '<p class="empty-state">No teams in this phase yet.</p>';
      return;
    }

    const filter = state.filterText.trim().toLowerCase();

    const zonesLeftEl = $("zones-left");
    const zonesLeft = phase.zonesLeft || [];
    if (zonesLeft.length) {
      zonesLeftEl.hidden = false;
      zonesLeftEl.innerHTML = `<span class="zones-left-label">Zones left (${zonesLeft.length}):</span> ${zonesLeft
        .map((z) => `<span class="zone-chip">${escapeHtml(z)}</span>`)
        .join("")}`;
    } else {
      zonesLeftEl.hidden = true;
      zonesLeftEl.innerHTML = "";
    }

    // The PRECOUNTS helpers (e.g. "David from Ironridge") only matter until
    // official counts start, so drop them from every round after that.
    const teams = precountsOver() ? phase.teams.filter((t) => !t.helper) : phase.teams;

    const cards = teams.map((t) => {
      const haystack = [
        t.teamId,
        ...(t.members || []),
        t.section,
        t.zone,
        t.notes,
        t.zonesLeft,
        t.countTeam,
        ...(t.mfr || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matches = !filter || haystack.includes(filter);

      const notAssigned = !t.helper && !t.section && !t.zone;
      const fields = [
        t.section && ["Section", t.section],
        t.zone && ["Zone", t.zone],
        t.countTeam && ["Hands off to", t.countTeam],
        t.notes && ["Notes", t.notes],
        t.mfr && t.mfr.length ? ["MFR", t.mfr.join(", ")] : null,
      ].filter(Boolean);

      if (t.helper) {
        // full-width, single line: "PRECOUNTS  David from Ironridge · Yohan from Pegasus · Grace"
        return `
        <div class="team-card helper${matches ? "" : " dimmed"}">
          <div class="team-id">${escapeHtml(t.teamId)}</div>
          <div class="team-members">${escapeHtml((t.members || []).join(" · "))}</div>
        </div>`;
      }

      return `
        <div class="team-card${matches ? "" : " dimmed"}">
          <div class="team-id">${escapeHtml(t.teamId)}</div>
          <div class="team-members">${escapeHtml((t.members || []).join(" & ") || "Unassigned")}</div>
          ${fields.map(([label, val]) => `<div class="team-field"><b>${escapeHtml(label)}:</b> ${escapeHtml(val)}</div>`).join("")}
          ${notAssigned ? '<div class="team-field unassigned">Not assigned yet</div>' : ""}
        </div>`;
    });

    container.innerHTML = `<div class="team-grid">${cards.join("")}</div>`;
    setupAutoScroll(container);
  }

  $("team-filter").addEventListener("input", (e) => {
    state.filterText = e.target.value;
    renderTeamCards();
  });

  // ---------------- bins ----------------

  const RING_CIRCUMFERENCE = 327; // 2 * pi * 52

  function renderBins(bins) {
    const summary = (bins && bins.summary) || {
      totalGroups: 0,
      counted: 0,
      inProgress: 0,
      notStarted: 0,
      percentComplete: 0,
      byWarehouse: [],
      remainingGroups: [],
    };

    $("percent-complete").textContent = `${summary.percentComplete}%`;
    const offset = RING_CIRCUMFERENCE * (1 - summary.percentComplete / 100);
    $("ring-value").style.strokeDashoffset = String(offset);

    $("bins-stats").innerHTML = `
      <div class="stat-counted"><div class="stat-value">${summary.counted}</div><div class="stat-label">Complete</div></div>
      <div class="stat-progress"><div class="stat-value">${summary.inProgress}</div><div class="stat-label">Assigned</div></div>
      <div class="stat-remaining"><div class="stat-value">${summary.notStarted}</div><div class="stat-label">Not started</div></div>
      <div class="stat-total"><div class="stat-value">${summary.totalGroups}</div><div class="stat-label">Total zones</div></div>
    `;

    const roundBadge = $("current-round");
    if (summary.currentRound) {
      roundBadge.hidden = false;
      roundBadge.textContent = `Round: ${summary.currentRound}`;
    } else {
      roundBadge.hidden = true;
    }

    const total = summary.totalGroups || 0;
    $("bins-rounds").innerHTML = (summary.byRound || [])
      .map(
        (r) => `
        <div class="round-chip${r.round === summary.currentRound ? " active" : ""}${r.zones === 0 ? " idle" : ""}">
          <span class="round-name">${escapeHtml(r.round)}</span>
          <span class="round-count">${r.zones}/${total} zones</span>
        </div>`
      )
      .join("");

    $("bins-by-warehouse").innerHTML = (summary.byWarehouse || [])
      .map(
        (w) => `
        <div class="wh-row">
          <div class="wh-row-head"><span>${escapeHtml(w.warehouse)}</span><span>${w.counted}/${w.total} (${w.percentComplete}%)</span></div>
          <div class="wh-bar"><div class="wh-bar-fill" style="width:${w.percentComplete}%"></div></div>
        </div>`
      )
      .join("");

    const remaining = summary.remainingGroups || [];
    const remainingEl = $("remaining-scroll");
    if (remaining.length === 0) {
      remainingEl.innerHTML = '<p class="empty-state">Every zone is complete 🎉</p>';
    } else {
      remainingEl.innerHTML = `<div class="remaining-list">${remaining
        .map(
          (g) => `
          <div class="remaining-row">
            <span class="remaining-zone">${escapeHtml(g.group)}${
              g.team ? ` <span class="remaining-meta">${escapeHtml(g.round || "")} · ${escapeHtml(g.team)}</span>` : ""
            }</span>
            <span class="status-pill ${g.status}">${statusLabel(g.status)}</span>
          </div>`
        )
        .join("")}</div>`;
    }
    setupAutoScroll(remainingEl);
  }

  function statusLabel(status) {
    switch (status) {
      case "counted": return "Complete";
      case "in_progress": return "Assigned";
      default: return "Not started";
    }
  }

  // ---------------- TV auto-scroll for overflowing panels ----------------

  const autoScrollTimers = new WeakMap();

  function setupAutoScroll(el) {
    const existing = autoScrollTimers.get(el);
    if (existing) clearInterval(existing);
    if (window.innerWidth < 1100) return; // only on big/TV-ish screens
    if (el.scrollHeight <= el.clientHeight + 20) return;

    let direction = 1;
    let paused = 0;
    const timer = setInterval(() => {
      if (paused > 0) { paused -= 1; return; }
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop += direction * 1.2;
      if (el.scrollTop >= max - 1 || el.scrollTop <= 1) {
        direction *= -1;
        paused = 12; // pause ~3s at each end (250ms tick)
      }
    }, 250);
    autoScrollTimers.set(el, timer);
  }

  // ---------------- utils ----------------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }

  // ---------------- boot ----------------

  tickClock();
  setInterval(tickClock, 1000);

  loadDashboard();
  setInterval(loadDashboard, POLL_MS);
})();
