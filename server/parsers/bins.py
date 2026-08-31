"""Parser for the 'All Bin Locations' tab, plus the counted/remaining
progress rollup shown on the dashboard.

The tab lists every physical bin at full granularity, e.g.:

    Should Delete Bin   Bin Name          Area   Bin Notes   Other Notes
                        WH1-BLUE-A-1-1
                        WH1-BLUE-A-1-2
                        WH1-RED-A-4-1
                        YARD-FENCE-07

But the warehouse is counted a whole shelf/section at a time, not bin by
bin, so the dashboard groups bin names down to the shelf/section they
belong to (e.g. "WH1-BLUE-A-1-1" -> "WH1-BLUE-A", "YARD-FENCE-07" ->
"YARD-FENCE") and tracks progress per group. See `bin_group()` below for
the exact rule.

Status tracking: the tab does not have to have a "Status" column for the
app to work (everything just shows "Not Started"), but if/when the user
adds one, any header containing "status" is picked up automatically
(case-insensitive, so "Status", "Count Status", etc. all work), along
with optional "Counted By" / "Count Date" columns. Because a whole group
is counted in one pass, a group is considered Counted as soon as *any*
one of its rows is marked Counted -- the user doesn't have to update
every sub-bin row.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .csv_utils import cell, find_header_row, parse_csv, row_is_blank

NOT_STARTED = "not_started"
IN_PROGRESS = "in_progress"
COUNTED = "counted"

_STATUS_RANK = {NOT_STARTED: 0, IN_PROGRESS: 1, COUNTED: 2}

_TRUTHY = {"true", "yes", "y", "x", "1"}

# Trailing segments that identify a shelf/slot/position *within* a group
# rather than the group itself, e.g. the "4", "1", "OS" (overstock),
# "FLR" (floor) and "END" (end-cap) in "WH1-RED-A-4-1", "WH1-BLUE-B-2-OS",
# "YARD-DOCK-12-FLR", "WH1-RED-I-END".
_SUFFIX_SEGMENT_RE = re.compile(r"^(\d+|OS|FLR|END)$", re.IGNORECASE)


def bin_group(bin_name: str) -> str:
    """Collapse a full bin name down to the shelf/section it belongs to.

    Repeatedly strips trailing hyphen-separated segments that look like a
    shelf/slot/position marker (purely numeric, or OS/FLR/END), stopping
    as soon as a non-matching segment is hit or only one segment is left.

        WH1-RED-A-4-1        -> WH1-RED-A
        WH1-BLUE-B-2-OS       -> WH1-BLUE-B
        WH1-GREEN-I-4         -> WH1-GREEN-I
        WH1-ORANGE-B-END-2    -> WH1-ORANGE-B
        YARD-FENCE-07         -> YARD-FENCE
        YARD-DOCK-12-FLR      -> YARD-DOCK
        WHSE 3                -> WHSE 3   (no hyphens, kept as-is)
    """
    segments = bin_name.split("-")
    while len(segments) > 1 and _SUFFIX_SEGMENT_RE.match(segments[-1]):
        segments.pop()
    return "-".join(segments)


def warehouse_of(name: str) -> str:
    m = re.match(r"^WH(\d+)\b", name, re.IGNORECASE)
    if m:
        return f"Warehouse {m.group(1)}"
    if name.upper().startswith("YARD"):
        return "Yard"
    return "Other"


def _normalize_status(raw: str) -> str:
    v = raw.strip().lower()
    if not v:
        return NOT_STARTED
    if v in _TRUTHY or "counted" in v or "done" in v or "complete" in v:
        return COUNTED
    if "progress" in v or "in progress" in v or v == "started":
        return IN_PROGRESS
    return NOT_STARTED


@dataclass
class BinRow:
    bin_name: str
    group: str
    warehouse: str
    excluded: bool
    status: str
    counted_by: Optional[str] = None
    count_date: Optional[str] = None


@dataclass
class BinGroup:
    group: str
    warehouse: str
    status: str
    bin_count: int
    excluded_count: int
    counted_by: Optional[str] = None
    count_date: Optional[str] = None


def _find_col(headers: List[str], *needles: str) -> Optional[int]:
    for idx, h in enumerate(headers):
        hl = h.lower()
        if any(n in hl for n in needles):
            return idx
    return None


def parse_bin_rows(csv_text: str) -> List[BinRow]:
    rows = parse_csv(csv_text)
    header_idx = find_header_row(rows, "bin name")
    if header_idx == -1:
        return []
    headers = rows[header_idx]

    col_bin_name = _find_col(headers, "bin name")
    col_delete = _find_col(headers, "should delete")
    col_status = _find_col(headers, "status")
    col_counted_by = _find_col(headers, "counted by")
    col_count_date = _find_col(headers, "count date")

    if col_bin_name is None:
        return []

    out: List[BinRow] = []
    for row in rows[header_idx + 1 :]:
        if row_is_blank(row):
            continue
        name = cell(row, col_bin_name).strip()
        if not name:
            continue

        excluded = False
        if col_delete is not None:
            excluded = cell(row, col_delete).strip().lower() in _TRUTHY

        status = NOT_STARTED
        if col_status is not None:
            status = _normalize_status(cell(row, col_status))

        counted_by = (
            cell(row, col_counted_by).strip() or None
            if col_counted_by is not None
            else None
        )
        count_date = (
            cell(row, col_count_date).strip() or None
            if col_count_date is not None
            else None
        )

        out.append(
            BinRow(
                bin_name=name,
                group=bin_group(name),
                warehouse=warehouse_of(name),
                excluded=excluded,
                status=status,
                counted_by=counted_by,
                count_date=count_date,
            )
        )
    return out


def group_bins(rows: List[BinRow]) -> List[BinGroup]:
    """Roll individual bin rows up into shelf/section groups.

    Fully-excluded groups (every row marked "should delete") are dropped
    entirely -- they're not real inventory to count. Rows marked deleted
    within an otherwise-active group are counted in `excluded_count` but
    don't affect the group's status.
    """
    by_group: Dict[str, List[BinRow]] = {}
    for r in rows:
        by_group.setdefault(r.group, []).append(r)

    groups: List[BinGroup] = []
    for group_name, group_rows in by_group.items():
        active = [r for r in group_rows if not r.excluded]
        if not active:
            continue

        best_status = NOT_STARTED
        counted_by = None
        count_date = None
        for r in active:
            if _STATUS_RANK[r.status] > _STATUS_RANK[best_status]:
                best_status = r.status
                counted_by = r.counted_by
                count_date = r.count_date
            if best_status == COUNTED:
                break

        groups.append(
            BinGroup(
                group=group_name,
                warehouse=active[0].warehouse,
                status=best_status,
                bin_count=len(active),
                excluded_count=len(group_rows) - len(active),
                counted_by=counted_by,
                count_date=count_date,
            )
        )

    groups.sort(key=lambda g: (g.warehouse, g.group))
    return groups


@dataclass
class WarehouseSummary:
    warehouse: str
    total: int
    counted: int
    in_progress: int
    not_started: int

    @property
    def percent_complete(self) -> float:
        if self.total == 0:
            return 0.0
        return round(self.counted / self.total * 100, 1)


def summarize(groups: List[BinGroup]) -> dict:
    by_wh: Dict[str, WarehouseSummary] = {}
    for g in groups:
        s = by_wh.setdefault(
            g.warehouse, WarehouseSummary(g.warehouse, 0, 0, 0, 0)
        )
        s.total += 1
        if g.status == COUNTED:
            s.counted += 1
        elif g.status == IN_PROGRESS:
            s.in_progress += 1
        else:
            s.not_started += 1

    total = len(groups)
    counted = sum(1 for g in groups if g.status == COUNTED)
    in_progress = sum(1 for g in groups if g.status == IN_PROGRESS)
    not_started = total - counted - in_progress
    percent = round(counted / total * 100, 1) if total else 0.0

    remaining = [
        {
            "group": g.group,
            "warehouse": g.warehouse,
            "status": g.status,
            "binCount": g.bin_count,
        }
        for g in groups
        if g.status != COUNTED
    ]

    return {
        "totalGroups": total,
        "counted": counted,
        "inProgress": in_progress,
        "notStarted": not_started,
        "percentComplete": percent,
        "byWarehouse": [
            {
                "warehouse": wh,
                "total": s.total,
                "counted": s.counted,
                "inProgress": s.in_progress,
                "notStarted": s.not_started,
                "percentComplete": s.percent_complete,
            }
            for wh, s in sorted(by_wh.items())
        ],
        "remainingGroups": remaining,
    }


def parse_bins(csv_text: str) -> dict:
    rows = parse_bin_rows(csv_text)
    groups = group_bins(rows)
    return {
        "groups": [
            {
                "group": g.group,
                "warehouse": g.warehouse,
                "status": g.status,
                "binCount": g.bin_count,
                "excludedCount": g.excluded_count,
                "countedBy": g.counted_by,
                "countDate": g.count_date,
            }
            for g in groups
        ],
        "summary": summarize(groups),
    }
