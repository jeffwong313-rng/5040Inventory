"""Parser for the "What's Left" tab -- the source of truth for % complete.

Sheet shape (column A is a spacer; a couple of legend cells sit above the
header):

    B               C                D               E                     F                 G
                    Assigned
                    Complete
    What's Left     Current Status   Team Precount   Team Official Count   Team Variance 1   Team Variance 2
    WH1-BLUE-A      Complete         Team1           Team4
    WH1-BLUE-B      Assigned         Team2
    WH1-BLUE-C
    ...

Each row is one zone. "Current Status" drives progress:

    blank     -> not started (nobody has touched it yet)
    Assigned  -> in progress (a team is actively working on it)
    Complete  -> counted

The "Team <round>" columns record which team has the zone in each round.
The latest round with a team filled in is the zone's current round, so the
dashboard can show e.g. "WH1-BLUE-B - Official Count - Team2 - Assigned".
Round columns are discovered by header name ("Team ..."), so adding a
"Team Variance 3" column later just works.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from .bins import COUNTED, IN_PROGRESS, NOT_STARTED, warehouse_of
from .csv_utils import cell, parse_csv, row_is_blank

_ROUND_COL_RE = re.compile(r"^team\s+(.+)$", re.IGNORECASE)


def normalize_status(raw: str) -> str:
    v = raw.strip().lower()
    if not v:
        return NOT_STARTED
    if "complete" in v or "counted" in v or "done" in v:
        return COUNTED
    if "assign" in v or "progress" in v or "started" in v or "working" in v:
        return IN_PROGRESS
    return NOT_STARTED


def _find_header(rows: List[List[str]]) -> int:
    for i, row in enumerate(rows):
        lowered = [c.lower() for c in row]
        if any("current status" in c for c in lowered):
            return i
    for i, row in enumerate(rows):
        if any("what" in c.lower() and "left" in c.lower() for c in row):
            return i
    return -1


def _round_label(text: str) -> str:
    label = text.strip()
    if label.lower() == "precount":
        return "Precount"
    return label


def parse_whats_left(csv_text: str) -> dict:
    rows = parse_csv(csv_text)
    header_idx = _find_header(rows)
    zones: List[dict] = []
    rounds: List[str] = []

    if header_idx != -1:
        headers = rows[header_idx]
        col_zone: Optional[int] = None
        col_status: Optional[int] = None
        round_cols: List[tuple] = []
        for idx, h in enumerate(headers):
            hl = h.strip().lower()
            if not hl:
                continue
            if "current status" in hl or hl == "status":
                col_status = idx
            elif col_zone is None and "what" in hl and "left" in hl:
                col_zone = idx
            else:
                m = _ROUND_COL_RE.match(h.strip())
                if m:
                    round_cols.append((idx, _round_label(m.group(1))))
        if col_zone is None:
            col_zone = 1
        rounds = [name for _, name in round_cols]

        for row in rows[header_idx + 1 :]:
            if row_is_blank(row):
                continue
            name = cell(row, col_zone).strip()
            if not name:
                continue
            status = (
                normalize_status(cell(row, col_status))
                if col_status is not None
                else NOT_STARTED
            )
            teams: Dict[str, str] = {}
            current_round = None
            current_team = None
            for idx, round_name in round_cols:
                team = cell(row, idx).strip()
                if team:
                    teams[round_name] = team
                    current_round = round_name
                    current_team = team
            zones.append(
                {
                    "group": name,
                    "warehouse": warehouse_of(name),
                    "status": status,
                    "round": current_round,
                    "team": current_team,
                    "teams": teams,
                }
            )

    return {"groups": zones, "rounds": rounds, "summary": summarize(zones, rounds)}


def _pct(part: int, whole: int) -> float:
    return round(part / whole * 100, 1) if whole else 0.0


def summarize(zones: List[dict], rounds: List[str]) -> dict:
    by_wh: Dict[str, Dict[str, int]] = {}
    for z in zones:
        s = by_wh.setdefault(
            z["warehouse"], {"total": 0, "counted": 0, "inProgress": 0, "notStarted": 0}
        )
        s["total"] += 1
        if z["status"] == COUNTED:
            s["counted"] += 1
        elif z["status"] == IN_PROGRESS:
            s["inProgress"] += 1
        else:
            s["notStarted"] += 1

    total = len(zones)
    counted = sum(1 for z in zones if z["status"] == COUNTED)
    in_progress = sum(1 for z in zones if z["status"] == IN_PROGRESS)

    # How many zones each round has reached (a team written in that round's
    # column) -- lets the dashboard show the count moving through rounds.
    by_round = [
        {
            "round": r,
            "zones": sum(1 for z in zones if r in z["teams"]),
        }
        for r in rounds
    ]
    current_rounds = [r["round"] for r in by_round if r["zones"] > 0]

    # Assigned zones first (actively being worked), then untouched ones.
    remaining = sorted(
        (z for z in zones if z["status"] != COUNTED),
        key=lambda z: 0 if z["status"] == IN_PROGRESS else 1,
    )

    return {
        "totalGroups": total,
        "counted": counted,
        "inProgress": in_progress,
        "notStarted": total - counted - in_progress,
        "percentComplete": _pct(counted, total),
        "currentRound": current_rounds[-1] if current_rounds else None,
        "byRound": by_round,
        "byWarehouse": [
            {
                "warehouse": wh,
                **s,
                "percentComplete": _pct(s["counted"], s["total"]),
            }
            for wh, s in sorted(by_wh.items())
        ],
        "remainingGroups": [
            {
                "group": z["group"],
                "warehouse": z["warehouse"],
                "status": z["status"],
                "round": z["round"],
                "team": z["team"],
            }
            for z in remaining
        ],
    }
