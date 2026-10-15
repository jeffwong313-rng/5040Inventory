// Pure data logic for the companion site: CSV parsing, the Count Teams /
// Team Specific tabs, and turning an assignment like "WH1-PURPLE E-H" into
// the cells of the warehouse map that should light up. No DOM in here, so
// it is unit-tested with Node: node --test docs/tests/zones.test.mjs.

/* ------------------------------------------------------------------ CSV */

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const c = (row, i) => (row && row[i] != null ? String(row[i]) : "").trim();
const blank = (row) => !row || row.every((v) => !String(v).trim());

/* ---------------------------------------------------------- Count Teams */

const TEAM_ID_RE = /^team\s*\d+$/i;
const HEADER_TRIGGER_RE = /team member|^section$|^zone$|zones\s*left|^mfr\d*$|count\s*team/i;

function classifyHeader(h) {
  h = h.trim();
  if (!h) return null;
  const m = h.match(/team member\s*(\d+)/i);
  if (m) return "member" + m[1];
  if (/^section$/i.test(h)) return "section";
  if (/^zone$/i.test(h)) return "zone";
  if (/^notes?$/i.test(h)) return "notes";
  if (/zones\s*left/i.test(h)) return "zonesLeft";
  if (/count\s*team/i.test(h)) return "countTeam";
  if (/^mfr\d*$/i.test(h)) return "mfr";
  return h;
}

/** Stacked "For <phase>" tables -> [{title, name, description, zonesLeft, teams:[...]}] */
export function parseCountTeams(csvText) {
  const rows = parseCSV(csvText);
  const phases = [];
  let cur = null;
  let header = {};
  let awaiting = false;
  for (const row of rows) {
    const first = c(row, 1);
    if (/^for\s+\S/i.test(first)) {
      cur = {
        title: first,
        name: first.replace(/^for\s+/i, "").trim(),
        description: c(row, 2),
        zonesLeft: [],
        teams: [],
      };
      phases.push(cur);
      header = {};
      awaiting = true;
      continue;
    }
    if (!cur || blank(row)) continue;
    const teamId = c(row, 0);
    if (awaiting && !TEAM_ID_RE.test(teamId)) {
      if (row.some((v) => HEADER_TRIGGER_RE.test(String(v).trim()))) {
        header = {};
        row.forEach((h, i) => {
          const f = classifyHeader(String(h));
          if (f) header[i] = f;
        });
        awaiting = false;
      }
      continue;
    }
    for (const [i, f] of Object.entries(header)) {
      if (f === "zonesLeft" && c(row, +i)) cur.zonesLeft.push(c(row, +i));
    }
    const members = Object.entries(header)
      .filter(([, f]) => f.startsWith("member"))
      .map(([i]) => c(row, +i))
      .filter(Boolean);
    if (TEAM_ID_RE.test(teamId)) {
      const t = { teamId: teamId.replace(/\s+/g, ""), members, mfr: [], extra: {}, helper: false };
      for (const [i, f] of Object.entries(header)) {
        const v = c(row, +i);
        if (!v || f.startsWith("member") || f === "zonesLeft") continue;
        if (f === "mfr") t.mfr.push(v);
        else if (["section", "zone", "notes", "countTeam"].includes(f)) t[f] = v;
        else t.extra[f] = v;
      }
      cur.teams.push(t);
    } else if (cur.teams.length && members.length) {
      // helper rows under the numbered teams, e.g. "PRECOUNTS | David | Yohan"
      const last = cur.teams[cur.teams.length - 1];
      if (teamId) cur.teams.push({ teamId: titleCase(teamId), members, mfr: [], extra: {}, helper: true });
      else if (last.helper) last.members.push(...members);
    }
  }
  return phases;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}

/* -------------------------------------------------------- Team Specific */

/** "Team Name | Counter | Recorder | Map Section" -> {Team1: {counter, recorder, mapSection, extra}} */
export function parseTeamSpecific(csvText) {
  const rows = parseCSV(csvText);
  const out = {};
  const hi = rows.findIndex((r) => r.some((v) => /^team\s*name$/i.test(String(v).trim())));
  if (hi === -1) return out;
  const head = rows[hi].map((h) => String(h).trim());
  const col = (re) => head.findIndex((h) => re.test(h));
  const iTeam = col(/^team\s*name$/i);
  const iCounter = col(/^counter/i);
  const iRecorder = col(/^recorder/i);
  const iMap = col(/map\s*section/i);
  for (const row of rows.slice(hi + 1)) {
    const name = c(row, iTeam).replace(/\s+/g, "");
    if (!name) continue;
    const extra = {};
    head.forEach((h, i) => {
      if (h && ![iTeam, iCounter, iRecorder, iMap].includes(i) && c(row, i)) extra[h] = c(row, i);
    });
    out[name.toLowerCase()] = {
      teamId: name,
      counter: iCounter >= 0 ? c(row, iCounter) : "",
      recorder: iRecorder >= 0 ? c(row, iRecorder) : "",
      mapSection: iMap >= 0 ? c(row, iMap) : "",
      extra,
    };
  }
  return out;
}

/** Every real team (Team1..TeamN) across phases + Team Specific, in number order. */
export function teamList(phases, specific) {
  const ids = new Set();
  for (const p of phases) for (const t of p.teams) if (!t.helper) ids.add(t.teamId);
  for (const s of Object.values(specific || {})) if (TEAM_ID_RE.test(s.teamId)) ids.add(s.teamId);
  const num = (s) => parseInt(s.replace(/\D/g, ""), 10) || 0;
  return [...ids].sort((a, b) => num(a) - num(b));
}

export function findTeam(phase, teamId) {
  if (!phase) return null;
  const k = teamId.toLowerCase();
  return phase.teams.find((t) => t.teamId.toLowerCase() === k) || null;
}

/* ------------------------------------------------- assignment -> specs */

const COLORS = ["GRAY", "GREY", "PURPLE", "GREEN", "ORANGE", "YELLOW", "RED", "BLUE"];
const KINDS = ["FENCE", "DOCK", "CONTAINER", "RACK"];

/**
 * Turns free text from the sheet into structured specs. Handles the shapes
 * actually used: "WH1-PURPLE E-H", "WH1-Green A-B", "WH1-PURPLE-E / F / G / H",
 * "WH1-BLUE-H WH1-BLUE-I", "WH1-GRAY, WH1-BLUE-A, BLUE-B", "WH2 + WH3",
 * "YARD", "Yard-", "YARD-FENCE-03", "WH1-YELLOW-3C", "WH1-GREEN-OS-FLR".
 * Each spec: {tab, color|null, ids:[...]|null, kind|null, label}
 */
export function parseAssignment(text) {
  if (!text) return [];
  let s = String(text).toUpperCase().replace(/[–—]/g, "-");
  s = s.replace(/\bGREY\b/g, "GRAY");
  s = s.replace(/\bWAREHOUSE\s*(\d)/g, "WH$1");
  // every new "WH1"/"YARD" starts a new piece; so do , + & ; / and "and"/"then"
  s = s.replace(/\s+(?=(WH\s?\d|YARD)\b)/g, ",");
  const parts = s.split(/\s*(?:,|\+|&|;|\/|\bAND\b|\bTHEN\b)\s*/).map((p) => p.trim()).filter(Boolean);

  const specs = [];
  let ctxTab = null;
  let ctxColor = null;
  for (let part of parts) {
    let rest = part;
    let hadTab = false;
    const mt = rest.match(/^(WH\s?(\d)|YARD)\b[\s-]*(.*)$/);
    if (mt) {
      ctxTab = mt[2] ? "WH" + mt[2] : "YARD";
      rest = mt[3].trim();
      hadTab = true;
    }
    if (!ctxTab) continue;

    let color = null;
    let hadColor = false;
    const mc = rest.match(new RegExp(`^(${COLORS.join("|")})\\b[\\s-]*(.*)$`));
    if (mc) {
      color = mc[1] === "GREY" ? "GRAY" : mc[1];
      rest = mc[2].trim();
      hadColor = true;
    } else if (!hadTab) {
      color = ctxColor;
    }
    ctxColor = color;

    const tab = ctxTab;
    const baseLabel = [tab, color].filter(Boolean).join("-");
    rest = rest.replace(/^-+|-+$/g, "").trim();

    // YARD-FENCE-03, YARD-DOCK-04-FLR, YARD-CONTAINER-07, YARD-RACK-24
    const mk = tab === "YARD" && rest.match(new RegExp(`^(${KINDS.join("|")})S?\\b[\\s-]*(\\d+)?`));
    if (mk) {
      specs.push({
        tab, color, kind: mk[1], ids: mk[2] ? [String(parseInt(mk[2], 10))] : null,
        label: `${tab}-${rest}`,
      });
      continue;
    }

    if (!rest) {
      if (hadTab || hadColor) specs.push({ tab, color, ids: null, kind: null, label: baseLabel });
      continue;
    }
    // ranges / letters / short ids
    const range = rest.match(/^([A-Z])\s*-\s*([A-Z])$/);
    if (range) {
      const a = range[1].charCodeAt(0);
      const b = range[2].charCodeAt(0);
      const ids = [];
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) ids.push(String.fromCharCode(k));
      specs.push({ tab, color, ids, kind: null, label: `${baseLabel} ${range[1]}-${range[2]}` });
      continue;
    }
    const id = rest.match(/^([A-Z0-9]{1,5}(?:[- ][A-Z0-9]{1,5}){0,3})$/);
    if (id && (color || /^\d/.test(id[1]))) {
      specs.push({ tab, color, ids: [id[1]], kind: null, label: `${baseLabel}-${id[1]}` });
      continue;
    }
    // unrecognised trailing words ("then float for whoever needs help"):
    // if this piece named a tab/colour, still use that much
    if (hadTab || hadColor) specs.push({ tab, color, ids: null, kind: null, label: baseLabel });
  }
  // de-duplicate
  const seen = new Set();
  return specs.filter((sp) => {
    const k = JSON.stringify([sp.tab, sp.color, sp.ids, sp.kind]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------ colour families */

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function colorFamily(hex) {
  if (!hex) return null;
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.18 || d < 0.06) return l < 0.12 ? "BLACK" : "GRAY";
  let hue;
  if (max === r) hue = 60 * (((g - b) / d) % 6);
  else if (max === g) hue = 60 * ((b - r) / d + 2);
  else hue = 60 * ((r - g) / d + 4);
  if (hue < 0) hue += 360;
  if (hue >= 296 && hue < 320 && s > 0.9 && l > 0.45) return "MAGENTA"; // camera markers
  if (hue < 16 || hue >= 330) return "RED";
  if (hue < 42) return "ORANGE";
  if (hue < 68) return "YELLOW";
  if (hue < 175) return "GREEN";
  if (hue < 252) return "BLUE";
  if (hue < 330) return "PURPLE";
  return "RED";
}

/* -------------------------------------------------- specs -> map cells */
// map cell = [x, y, w, h, fill, text, fontSize, bold, textColor, align]

const cx = (k) => k[0] + k[2] / 2;
const cy = (k) => k[1] + k[3] / 2;

function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
  return Math.hypot(dx, dy);
}
const touches = (a, b) => rectGap(a, b) <= 1.5;
const norm = (t) => String(t || "").toUpperCase().replace(/\s+/g, "").replace(/[–—]/g, "-");

function famIndexes(tab, fam) {
  const out = [];
  tab.cells.forEach((k, i) => { if (k[4] && colorFamily(k[4]) === fam) out.push(i); });
  return out;
}

function component(tab, seeds, allowed) {
  const allow = new Set(allowed);
  const seen = new Set(seeds);
  const stack = [...seeds];
  while (stack.length) {
    const i = stack.pop();
    for (const j of allow) {
      if (!seen.has(j) && touches(tab.cells[i], tab.cells[j])) { seen.add(j); stack.push(j); }
    }
  }
  return [...seen];
}

function nearestOf(tab, anchor, idxs, maxGap) {
  let best = -1;
  let bd = Infinity;
  for (const i of idxs) {
    const d = rectGap(anchor, tab.cells[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return bd <= maxGap ? best : -1;
}

// Anchors = text cells that name a zone on the map: a full code like
// "WH1-BLUE-H" / "WH1-YELLOW-3C", or a bare letter like "H" or "D end"
// beside a coloured block. Each coloured cell then belongs to the anchor
// it sits closest to (weighted along the row/column the anchor labels).
export function anchorsFor(tab, fam, tabKey, colorName) {
  const famIdx = famIndexes(tab, fam);
  const colored = [];
  tab.cells.forEach((k, j) => { if (k[4] && colorFamily(k[4]) !== "MAGENTA") colored.push(j); });
  const anchors = [];
  const prefix = norm(`${tabKey}-${colorName}-`);
  tab.cells.forEach((k, i) => {
    const t = norm(k[5]);
    if (!t) return;
    let id = null;
    let full = false;
    if (t.startsWith(prefix) && t.length > prefix.length) {
      id = t.slice(prefix.length);
      full = true;
    } else {
      const m = String(k[5]).trim().toUpperCase().match(/^([A-Z])(?:\s+END)?$/);
      if (m) id = m[1];
    }
    if (!id) return;
    const near = nearestOf(tab, k, famIdx, full ? 260 : 110);
    if (near === -1) return;
    // a bare letter labels whichever coloured block it sits against; skip
    // letters that belong to a neighbouring block of another colour
    if (!full) {
      const any = nearestOf(tab, k, colored, 110);
      if (any !== -1 && colorFamily(tab.cells[any][4]) !== fam && rectGap(k, tab.cells[any]) < rectGap(k, tab.cells[near])) return;
    }
    const ov = (n) => ({
      y: Math.min(k[1] + k[3], n[1] + n[3]) - Math.max(k[1], n[1]),
      x: Math.min(k[0] + k[2], n[0] + n[2]) - Math.max(k[0], n[0]),
    });
    const close = famIdx.filter((j) => rectGap(k, tab.cells[j]) <= 3).map((j) => ov(tab.cells[j]));
    const list = close.length ? close : [ov(tab.cells[near])];
    let orient = "any";
    if (list.some((o) => o.x > 0 && o.y > 0)) orient = "in";
    else if (list.some((o) => o.y > 0)) orient = "row";
    else if (list.some((o) => o.x > 0)) orient = "col";
    anchors.push({ i, id, full, near, orient });
  });
  return { famIdx, anchors };
}

export function assignToAnchors(tab, famIdx, anchors) {
  const owner = new Map();
  if (!anchors.length) return owner;
  // only cells connected to a labelled block take part
  const comp = new Set(component(tab, [...new Set(anchors.map((a) => a.near))], famIdx));
  for (const i of comp) {
    const k = tab.cells[i];
    let best = null;
    let bd = Infinity;
    for (const a of anchors) {
      const ak = tab.cells[a.i];
      const dx = Math.abs(cx(k) - cx(ak));
      const dy = Math.abs(cy(k) - cy(ak));
      const d = a.orient === "row" ? dx + dy * 6 : a.orient === "col" ? dx * 6 + dy : Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) owner.set(i, best.id);
  }
  return owner;
}

/**
 * Resolve specs against map.json tabs.
 * Returns {byTab: {WH1: Set(cellIdx), ...}, whole: Set(tabKey), report: [{label, tab, found, approx}]}
 */
export function resolveSpecs(specs, map) {
  const byTab = {};
  const exact = {}; // cells matched precisely (used for zooming; fallbacks are only lit)
  const whole = new Set();
  const report = [];
  const add = (key, idxs, precise = true) => {
    if (!byTab[key]) byTab[key] = new Set();
    idxs.forEach((i) => byTab[key].add(i));
    if (precise) {
      if (!exact[key]) exact[key] = new Set();
      idxs.forEach((i) => exact[key].add(i));
    }
  };
  for (const sp of specs) {
    const tab = map.tabs.find((t) => t.key === sp.tab);
    if (!tab) { report.push({ label: sp.label, tab: sp.tab, found: false }); continue; }

    if (!sp.color && !sp.kind) {
      whole.add(tab.key);
      report.push({ label: sp.label, tab: tab.key, found: true, whole: true });
      continue;
    }

    if (sp.kind) {
      const hits = findKind(tab, sp.kind, sp.ids);
      if (hits.length) { add(tab.key, hits); report.push({ label: sp.label, tab: tab.key, found: true }); }
      else { whole.add(tab.key); report.push({ label: sp.label, tab: tab.key, found: false, approx: true }); }
      continue;
    }

    const fam = sp.color;
    const famIdx = famIndexes(tab, fam);
    if (!sp.ids) {
      if (famIdx.length) { add(tab.key, famIdx); report.push({ label: sp.label, tab: tab.key, found: true }); }
      else { whole.add(tab.key); report.push({ label: sp.label, tab: tab.key, found: false, approx: true }); }
      continue;
    }

    const { anchors } = anchorsFor(tab, fam, tab.key, fam);
    const fulls = anchors.filter((a) => a.full);
    const letters = anchors.filter((a) => !a.full);
    let got = [];
    // try full-code labels first, then bare letters
    for (const set of [fulls, letters]) {
      if (!set.length) continue;
      const owner = assignToAnchors(tab, famIdx, set);
      const want = new Set(sp.ids.map(norm));
      const ids = [...owner].filter(([, id]) => want.has(norm(id)) || [...want].some((w) => norm(id).startsWith(w + "-"))).map(([i]) => i);
      if (ids.length) { got = ids; break; }
    }
    if (got.length) {
      add(tab.key, got);
      report.push({ label: sp.label, tab: tab.key, found: true });
    } else if (famIdx.length) {
      add(tab.key, famIdx, false);
      report.push({ label: sp.label, tab: tab.key, found: true, approx: true });
    } else {
      whole.add(tab.key);
      report.push({ label: sp.label, tab: tab.key, found: false, approx: true });
    }
  }
  return { byTab, exact, whole, report };
}

function findKind(tab, kind, ids) {
  const n = ids && ids[0] ? parseInt(ids[0], 10) : null;
  const cells = tab.cells;
  if (kind === "FENCE") {
    // The fence is one row of small labelled slots, numbered left to right.
    const fam = new Map();
    cells.forEach((k, i) => {
      if (!k[4]) return;
      const f = colorFamily(k[4]);
      if (f !== "YELLOW" && f !== "ORANGE") return;
      const key = k[1];
      if (!fam.has(key)) fam.set(key, []);
      fam.get(key).push(i);
    });
    let row = [];
    for (const list of fam.values()) if (list.length > row.length) row = list;
    row.sort((a, b) => cells[a][0] - cells[b][0]);
    if (n == null) return row;
    return row[n - 1] != null ? [row[n - 1]] : [];
  }
  // docks and containers share the numbered slots on the yard map:
  // "Dock 12 ( ENPH )", "17 (EMPTY)"
  const re =
    kind === "CONTAINER" || kind === "DOCK"
      ? new RegExp(`(^0*${n}\\b|\\b(DOCK|CONTAINER)\\W*0*${n}\\b)`, "i")
      : new RegExp(`\\b${kind}\\W*0*${n}\\b`, "i");
  if (n == null) {
    const kre = new RegExp(`\\b${kind}`, "i");
    return cells.map((k, i) => (kre.test(k[5]) ? i : -1)).filter((i) => i >= 0);
  }
  return cells.map((k, i) => (re.test(k[5]) ? i : -1)).filter((i) => i >= 0);
}

/** Variance rounds list manufacturers: light up map cells whose label mentions them. */
export function resolveMfrs(mfrs, map) {
  const byTab = {};
  const report = [];
  for (const raw of mfrs) {
    const words = String(raw).toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3);
    if (!words.length) continue;
    let found = false;
    for (const tab of map.tabs) {
      tab.cells.forEach((k, i) => {
        const t = String(k[5] || "").toUpperCase();
        if (!t) return;
        if (words.some((w) => new RegExp(`\\b${w}`).test(t))) {
          if (!byTab[tab.key]) byTab[tab.key] = new Set();
          byTab[tab.key].add(i);
          found = true;
        }
      });
    }
    report.push({ label: raw, found, mfr: true });
  }
  return { byTab, exact: byTab, whole: new Set(), report };
}

export function mergeResolved(a, b) {
  const join = (key) => {
    const out = {};
    for (const r of [a, b]) for (const [k, set] of Object.entries(r[key] || {})) {
      if (!out[k]) out[k] = new Set();
      set.forEach((i) => out[k].add(i));
    }
    return out;
  };
  return { byTab: join("byTab"), exact: join("exact"), whole: new Set([...a.whole, ...b.whole]), report: [...a.report, ...b.report] };
}

/** The text a team's map should use for a phase (zone/section, else Team Specific map section). */
export function assignmentText(team, specificRow) {
  const t = team ? [team.zone, team.section].filter(Boolean).join(", ") : "";
  return t || (specificRow && specificRow.mapSection) || "";
}
