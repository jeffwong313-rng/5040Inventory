// Builds docs/data/map.json for the companion site from the map tabs of the
// inventory Google Sheet.
//
// The sheet's map tabs are drawn with cell colours, merges and borders, which a
// CSV export throws away. So this opens each tab's public "htmlview" in
// headless Chromium and records what is actually drawn: every coloured or
// labelled cell as a rectangle (position, size, fill, text) plus the borders
// as merged line segments. The companion site renders that as a picture.
//
// Usage:  node tools/extract_map.mjs docs/data/map.json
// Env:    SHEET_ID (defaults to the 2026 BONUS sheet)
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SHEET_ID =
  process.env.SHEET_ID || "1eSonYt5Fyxyune85dnnntaunvOupIzBN6eMEhFrHnU8";

// key        -> used by the companion app to match zone codes (WH1-..., YARD-...)
// crop       -> optional bounds (sheet pixels) to cut legends/side tables off
const TABS = [
  { key: "WH1", name: "Warehouse 1", tab: "Main Warehouse", gid: "0", crop: { maxY: 1270 } },
  { key: "WH2", name: "Warehouse 2", tab: "Warehouse 2", gid: "1903736930", crop: { maxX: 1610 } },
  { key: "WH3", name: "Warehouse 3", tab: "Warehouse 3", gid: "37419945", crop: { minX: 200 } },
  { key: "YARD", name: "Yard", tab: "Yard and Containers", gid: "2015963818", crop: {} },
];

function extractInPage() {
  const table = document.querySelector("table.waffle") || document.querySelector("table");
  if (!table) return null;
  const origin = table.getBoundingClientRect();
  const rgb = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((v) => parseFloat(v));
    if (p.length === 4 && p[3] === 0) return null;
    return p.slice(0, 3).map((v) => Math.round(v));
  };
  const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const cells = [];
  const segs = [];
  for (const td of table.querySelectorAll("td")) {
    const cs = getComputedStyle(td);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = td.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const x = Math.round(r.left - origin.left);
    const y = Math.round(r.top - origin.top);
    const w = Math.round(r.width);
    const h = Math.round(r.height);

    // borders -> segments
    const sides = {
      Top: [x, y, x + w, y],
      Bottom: [x, y + h, x + w, y + h],
      Left: [x, y, x, y + h],
      Right: [x + w, y, x + w, y + h],
    };
    for (const [side, seg] of Object.entries(sides)) {
      const bw = parseFloat(cs["border" + side + "Width"]);
      const st = cs["border" + side + "Style"];
      if (!bw || st === "none" || st === "hidden") continue;
      const col = rgb(cs["border" + side + "Color"]);
      if (!col) continue;
      segs.push([...seg, hex(col), Math.min(4, Math.max(1, Math.round(bw)))]);
    }

    const bgc = rgb(cs.backgroundColor);
    const fill = bgc && !(bgc[0] > 250 && bgc[1] > 250 && bgc[2] > 250) ? hex(bgc) : "";
    const text = (td.innerText || "").replace(/\s+/g, " ").trim();
    if (!fill && !text) continue;
    const fc = rgb(cs.color) || [0, 0, 0];
    const align = cs.textAlign === "center" ? "c" : cs.textAlign === "right" ? "r" : "l";
    cells.push([
      x, y, w, h, fill, text,
      Math.round(parseFloat(cs.fontSize) * 10) / 10,
      parseInt(cs.fontWeight, 10) >= 600 ? 1 : 0,
      hex(fc),
      align,
    ]);
  }
  return { width: Math.round(origin.width), height: Math.round(origin.height), cells, segs };
}

// Merge touching collinear segments of the same colour/width so a wall drawn
// as 40 cell borders becomes one line.
function mergeSegments(segs) {
  const key = (s) => `${s[4]}|${s[5]}`;
  const horiz = new Map();
  const vert = new Map();
  for (const s of segs) {
    const [x1, y1, x2, y2] = s;
    if (y1 === y2) {
      const k = key(s) + "|" + y1;
      if (!horiz.has(k)) horiz.set(k, []);
      horiz.get(k).push([Math.min(x1, x2), Math.max(x1, x2), s]);
    } else {
      const k = key(s) + "|" + x1;
      if (!vert.has(k)) vert.set(k, []);
      vert.get(k).push([Math.min(y1, y2), Math.max(y1, y2), s]);
    }
  }
  const out = [];
  const run = (groups, mk) => {
    for (const list of groups.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let [a, b, s] = list[0];
      for (let i = 1; i < list.length; i++) {
        const [c, d] = list[i];
        if (c <= b + 1) b = Math.max(b, d);
        else { out.push(mk(a, b, s)); [a, b, s] = list[i]; }
      }
      out.push(mk(a, b, s));
    }
  };
  run(horiz, (a, b, s) => [a, s[1], b, s[1], s[4], s[5]]);
  run(vert, (a, b, s) => [s[0], a, s[0], b, s[4], s[5]]);
  return out;
}

function crop(data, c) {
  const inside = (x, y, w, h) =>
    (c.maxX == null || x < c.maxX) && (c.maxY == null || y < c.maxY) &&
    (c.minX == null || x >= c.minX) && (c.minY == null || y >= c.minY);
  const cells = data.cells.filter(([x, y, w, h]) => inside(x, y, w, h));
  const segs = data.segs.filter(([x1, y1, x2, y2]) =>
    inside(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)));
  // tighten bounds to what's left
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  for (const [x, y, w, h] of cells) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
  for (const [x1, y1, x2, y2] of segs) {
    minX = Math.min(minX, x1, x2); minY = Math.min(minY, y1, y2);
    maxX = Math.max(maxX, x1, x2); maxY = Math.max(maxY, y1, y2);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = data.width; maxY = data.height; }
  return { cells, segs, bounds: [minX, minY, maxX - minX, maxY - minY] };
}

async function main() {
  const outPath = process.argv[2] || "docs/data/map.json";
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const tabs = [];
  for (const t of TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview/sheet?headers=false&gid=${t.gid}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    const raw = await page.evaluate(extractInPage);
    if (!raw || !raw.cells.length) throw new Error(`No map data found on tab ${t.tab}`);
    const merged = { ...raw, segs: mergeSegments(raw.segs) };
    const c = crop(merged, t.crop || {});
    console.log(`${t.tab}: ${c.cells.length} cells, ${c.segs.length} lines, bounds ${c.bounds.join(",")}`);
    tabs.push({ key: t.key, name: t.name, tab: t.tab, gid: t.gid, bounds: c.bounds, cells: c.cells, lines: c.segs });
  }
  await browser.close();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    // no timestamp in the file, so an unchanged map produces no commit
    JSON.stringify({ sheetId: SHEET_ID, tabs })
  );
  console.log(`wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
