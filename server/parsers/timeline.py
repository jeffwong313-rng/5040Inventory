"""Parser for the 'Timeline and Sequence' tab.

Sheet shape (column A is a spacer, unused):
    B          C                              D
    Date:      Friday, September 18, 2026
    Time       What's Happening               Notes
    10:00 AM   Store is officially closed...   Drivers back from...
    12:00 PM   Everyone takes 1 hour lunch
    1:00 PM
    ...
    9:00 PM    Done

The user keeps adding rows through the day (1PM-9PM), so this parser makes
no assumptions about how many rows exist -- it just keeps every row that
has *something* in it (a time, an event, or a note), in sheet order, which
is also chronological order since that's how the user builds it out.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .csv_utils import cell, parse_csv, row_is_blank


@dataclass
class TimelineEntry:
    time: str
    event: str
    notes: str


@dataclass
class Timeline:
    date: Optional[str] = None
    entries: List[TimelineEntry] = field(default_factory=list)


def parse_timeline(csv_text: str) -> Timeline:
    rows = parse_csv(csv_text)
    timeline = Timeline()

    for row in rows:
        if row_is_blank(row):
            continue

        label = cell(row, 1).strip().lower()
        if label == "date:":
            timeline.date = cell(row, 2).strip() or None
            continue

        if label == "time":
            # header row, e.g. "Time | What's Happening | Notes"
            continue

        time_val = cell(row, 1).strip()
        event_val = cell(row, 2).strip()
        notes_val = cell(row, 3).strip()

        if not (time_val or event_val or notes_val):
            continue

        timeline.entries.append(
            TimelineEntry(time=time_val, event=event_val, notes=notes_val)
        )

    return timeline


def timeline_to_dict(timeline: Timeline) -> dict:
    return {
        "date": timeline.date,
        "entries": [
            {"time": e.time, "event": e.event, "notes": e.notes}
            for e in timeline.entries
        ],
    }
