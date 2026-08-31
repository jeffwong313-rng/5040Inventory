(() => {
  "use strict";

  const POLL_MS = 15000;

  const state = {
    activePhaseTitle: null,
    filterText: "",
    countTeams: [],
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

    const nowIdx = closestPastEntryIndex(entries);

    track.innerHTML = entries
      .map((e, i) => {
        const isNow = i === nowIdx;
        return `
          <div class="timeline-item${isNow ? " now" : ""}">
            <div class="t-time">${escapeHtml(e.time || "")}</div>
            <div class="t-event">${escapeHtml(e.event || "")}</div>
            ${e.notes ? `<div class="t-notes">${escapeHtml(e.notes)}</div>` : ""}
          </div>`;
      })
      .join("");
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

    const cards = phase.teams.map((t) => {
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

      const fields = [
        t.section && ["Section", t.section],
        t.zone && ["Zone", t.zone],
        t.zonesLeft && ["Zones left", t.zonesLeft],
        t.countTeam && ["Hands off to", t.countTeam],
        t.notes && ["Notes", t.notes],
        t.mfr && t.mfr.length ? ["MFR", t.mfr.join(", ")] : null,
      ].filter(Boolean);

      return `
        <div class="team-card${matches ? "" : " dimmed"}">
          <div class="team-id">${escapeHtml(t.teamId)}</div>
          <div class="team-members">${escapeHtml((t.members || []).join(" & ") || "Unassigned")}</div>
          ${fields.map(([label, val]) => `<div class="team-field"><b>${escapeHtml(label)}:</b> ${escapeHtml(val)}</div>`).join("")}
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
      <div class="stat-counted"><div class="stat-value">${summary.counted}</div><div class="stat-label">Counted</div></div>
      <div class="stat-progress"><div class="stat-value">${summary.inProgress}</div><div class="stat-label">In progress</div></div>
      <div class="stat-remaining"><div class="stat-value">${summary.notStarted}</div><div class="stat-label">Not started</div></div>
      <div class="stat-total"><div class="stat-value">${summary.totalGroups}</div><div class="stat-label">Total sections</div></div>
    `;

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
      remainingEl.innerHTML = '<p class="empty-state">Everything is counted 🎉</p>';
    } else {
      remainingEl.innerHTML = `<div class="remaining-list">${remaining
        .map(
          (g) => `
          <div class="remaining-row">
            <span>${escapeHtml(g.group)} <span class="empty-state">(${escapeHtml(g.warehouse)})</span></span>
            <span class="status-pill ${g.status}">${statusLabel(g.status)}</span>
          </div>`
        )
        .join("")}</div>`;
    }
    setupAutoScroll(remainingEl);
  }

  function statusLabel(status) {
    switch (status) {
      case "counted": return "Counted";
      case "in_progress": return "In progress";
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

  loadDashboard();
  setInterval(loadDashboard, POLL_MS);
})();
