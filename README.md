# Warehouse Inventory Dashboard

A live dashboard for the 2026 BONUS inventory count, reading directly from the
[Warehouse Map Wiegman 2026 BONUS!!! Inventory](https://docs.google.com/spreadsheets/d/1eSonYt5Fyxyune85dnnntaunvOupIzBN6eMEhFrHnU8)
Google Sheet. No manual export/import step: the server re-pulls the sheet
every 20 seconds (configurable) and the dashboard polls the server, so any
edit made in the sheet shows up on screen within about half a minute,
everywhere it's open.

Three panels:

- **Timeline & Sequence** (top) — the day's schedule, straight from the
  *Timeline and Sequence* tab.
- **Count Teams** (bottom left) — every team, its members, and the
  section/zone it's assigned, with tabs for PreCounts / First Count /
  Variance 1 (and any further `For ...` phase you add to the sheet), plus
  a search box so someone on their phone can find their own team fast.
- **Zone Progress** (bottom right) — % complete from the *What's Left*
  tab: one row per zone, **Current Status** blank = not started,
  `Assigned` = a team is on it, `Complete` = counted. The `Team Precount` /
  `Team Official Count` / `Team Variance 1` / `Team Variance 2` columns show
  which round each zone is in and which team has it. Breaks down by
  warehouse and lists everything not yet complete (assigned zones first).
- Count Teams also shows each round's **Zones Left** column as a strip of
  chips, plus the extra precount helpers listed under the numbered teams.

Built to be readable on a TV across the room (large text, everything
visible without scrolling on wide screens, gently auto-scrolling lists
that don't fit) and on a phone (fully responsive, single column, normal
scrolling).

## Why Python instead of Node/React

This was built in an environment with no Node.js/npm available and no way
to install it, so the stack is **FastAPI (Python) + plain HTML/CSS/JS**
instead — no build step, nothing to compile, same result. If you'd rather
have a Node/React version, that's a straightforward rebuild against the
same `/api/*` endpoints; ask and I'll do it.

## Running it locally

Requires Python 3.9+.

```bash
cd warehouse-dashboard
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn server.main:app --reload --port 8000
```

Open http://localhost:8000 — that's the dashboard. Other devices on the
same wifi can reach it at `http://<your-computer's-LAN-IP>:8000`.

## Running the tests

```bash
source .venv/bin/activate
python -m pytest
```

59 tests cover: CSV parsing edge cases, the bin-name → shelf/section
truncation rule, counted/in-progress/not-started rollups, the multi-phase
Count Teams parser (including the sheet's stray annotation/instruction
rows that aren't real headers), the API endpoints, and that the frontend's
DOM lookups actually match `index.html`.

## Keeping "All Bin Locations" in sync with the dashboard

The tab already has `Bin Name` (full granularity, e.g. `WH1-RED-A-4-1`) —
the dashboard automatically groups these down to the shelf/section level
(`WH1-RED-A`) since that's the unit you actually count. You don't need to
change that.

To track progress, add these column headers (any position, matched by
name so order doesn't matter):

| Column | Values | Notes |
|---|---|---|
| `Status` | *(blank)*, `In Progress`, `Counted` | Mark **any one row** in a shelf/section as `Counted` and the whole group flips to counted — you don't have to update every sub-bin. |
| `Counted By` | a name | optional |
| `Count Date` | any text/date | optional |

`Should Delete Bin` (already there) still works the same way — rows
marked there are excluded from the count, and a group with every row
marked deleted disappears from the dashboard entirely.

## Phone companion (team page + map)

The dashboard shows a QR code next to the Count Teams search. It opens
**https://jeffwong313-rng.github.io/5040Inventory/**, a phone page served by
GitHub Pages from the `docs/` folder. It doesn't use Render at all, so it
works even while the free Render instance is asleep.

- **Pick your team.** No login. The phone remembers the choice ("← Teams" switches).
- **Team screen:** members, a **Roles & login** card (from the *Team
  Specific* tab: Counter, Recorder and 3rd Teammate side by side, each with
  the role description, plus the team's username/password), and the assignment for PreCounts / First Count / Variance 1, read live
  from *Count Teams* every 30 seconds.
- **Map:** a picture of the Main Warehouse / Warehouse 2 / Warehouse 3 /
  Yard tabs. Everything is muted except the team's zones, and it zooms to
  them. Drag to move, pinch or +/− to zoom. Variance rounds (which list
  MFRs, not zones) light up map labels mentioning those manufacturers.

How zones are found on the map: a code like `WH1-PURPLE-E` is matched to
the purple block next to the letter **E** on the map (or to a small label
like `WH1-BLUE-H` placed beside a block). `WH2` / `YARD` with nothing after
lights up that whole map. If a zone can't be pinned down, the app lights
the whole colour area and marks it with ≈ in the legend.

The map picture itself is `docs/data/map.json`, built by the **Refresh
companion map** GitHub Action (`tools/extract_map.mjs`). It runs daily.
After editing a map tab, run it right away from the repo's *Actions* tab
→ *Refresh companion map* → *Run workflow*. Its commits say
`[skip render]`, so they don't redeploy the dashboard.

Team Specific tab columns used (matched by name, any order): `Team Name`,
`Counter`, `Recorder`, `3rd Teammate`, `Login`, `Map Section`. Text in
parentheses in a header, e.g. `Counter (actively moving boxes…)`, is shown
as that role's description, so edit the header to change it. `Login` fills
both Username and Password (the sheet uses the same value for both). First
names are expanded to the full name from *Count Teams* when it's unambiguous.
Map Section is used for the map when a round has no zone for that team. Any
extra columns you add are shown on the team screen.

Tests: `node --test docs/tests/zones.test.mjs`

## Manager page (Question alerts + part lookup)

The manager's own screen lives at a private link:
`https://warehouse-inventory-dashboard.onrender.com/m/<MANAGER_PASSWORD>`.
`MANAGER_PASSWORD` is set only in Render (service → *Environment*), never in
this repo, so the link can't be worked out from the code. Any other `/m/...`
address returns "Not Found", and nothing links to it: no QR code, no button
on the dashboard or the companion. Bookmark it. To revoke it, change the
value in Render; the old link stops working after the redeploy.

- **Questions.** Every team screen in the companion (and the map) has a
  **✋ Question** button. A team can add a short note or tap a quick reason,
  then it shows up here right away: red banner, chime every 10 s, tab title
  and a desktop notification until you tap **On my way** (the team's phone
  then says you're coming) and **Done**. A team tapping again bumps its
  existing call instead of adding a new one.
- **Lookup.** Searches the *LPF* tab by Catalog # (mainly) and MFR. Spaces
  and punctuation don't matter (`emt 3/4` finds `EMT-3/4 (10)*`), and
  `ANKER A52` narrows to that MFR. Each hit shows columns B–H: Mfr,
  Catalog #, Description, LPO Cost, UOM, OH Qty, Qty Avail. Press `/` to
  jump to the search box.

- **Count round.** One button per round from *Count Teams* (PreCounts →
  First Count, i.e. official counts → Variance 1 …). Everyone starts on
  PreCounts. Tap a round and the TV dashboard and every team phone switch
  to it within ~10–15 s (phones show "Jeff moved everyone to …"). That
  round gets a ● on everyone's round tabs. If someone taps a different
  round after that, they get a warning ("Everyone is on First Count. Look
  at PreCounts anyway?"). They can still look, but reopening the app puts
  them back on your round. The server keeps the round in memory, and the
  manager page re-sends it if the server restarts, so keep the page open.

Keep the page open during the count: browsers only allow sound after one
click on the page, so if the button says **🔇 Turn on alerts**, click it.
Having the page open also keeps the free Render instance awake, so a
team's Question goes through instantly instead of after a ~30 s wake-up.
Calls live in the server's memory, so a redeploy clears them.

## Configuration

Environment variables (all optional, defaults point at the real sheet):

| Var | Default | Meaning |
|---|---|---|
| `SHEET_ID` | the 2026 BONUS sheet | which spreadsheet to read |
| `GID_TIMELINE` / `GID_COUNT_TEAMS` / `GID_WHATS_LEFT` | current tab gids | which tab within it (if you ever rename/recreate a tab, its gid changes — grab the new one from the tab's URL) |
| `MANAGER_PASSWORD` | *(unset = manager page off)* | secret part of the manager link `/m/<value>` |
| `GID_LOOKUP` | LPF tab | tab the manager lookup searches |
| `CORS_ORIGINS` | the GitHub Pages site | sites allowed to send Questions |
| `POLL_INTERVAL_SECONDS` | `20` | how often the server re-fetches the sheet |
| `STALE_AFTER_SECONDS` | `120` | how long since the last good fetch before the dashboard shows a "may be stale" warning |
| `PORT` | `8000` | server port |

The sheet only needs to be shared as **"Anyone with the link can view"**
— the app reads it as CSV and never signs in or writes to it.

## Deploying so everyone can reach it

Any host that runs a Docker container or a Python web service works. The
free tier of [Render](https://render.com) is a good default — no server
to babysit test:

1. Push this folder to a GitHub repo (private is fine).
2. In Render: **New → Blueprint**, point it at the repo — it will read
   `render.yaml` and set everything up automatically.
3. Once it deploys, Render gives you a public `https://...onrender.com`
   URL — that's what you share for people to open on the TV/their phones.

The free tier spins down after inactivity and takes ~30s to wake back up
on the next request; fine for a dashboard someone glances at, less fine
if the TV is expected to be instantly live all day — a $7/mo starter
instance removes that spin-down if it matters.
