"""Parser for the 'Count Teams' tab.

The sheet stacks several phase tables on top of one another in the same
tab (PreCounts, First Count, Variance 1, ...), each looking like:

    For <Phase Name>          <optional description>
    Team Member 1  Team Member 2  Team Member 3  Section  ...   <- header
    Team1          Archie Cole    Mateo Saiki             WH2, ...
    Team2          ...
    ...
    <blank row>

Rather than hard-coding column positions per phase (which breaks the
moment a column is added/reordered, and doesn't handle a future
"Variance 2" phase at all), this walks the sheet generically:

  * a row whose first labeled cell starts with "For " starts a new phase
  * the next row containing a recognizable column label (e.g. "Team
    Member 1", "Zone", "MFR") becomes that phase's header row; stray
    instructional/annotation rows in between are skipped
  * rows starting with "Team<N>" in column A are that phase's data,
    mapped positionally onto whatever headers preceded them

Header names are normalized (lowercased, punctuation-insensitive) into a
small set of known fields (members, section, zone, notes, zones_left,
count_team, mfr) when recognized; anything unrecognized is kept verbatim
in `extra` so no data is silently dropped if the sheet grows new columns.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .csv_utils import cell, parse_csv, row_is_blank

TEAM_ID_RE = re.compile(r"^team\s*\d+$", re.IGNORECASE)

# header text (substring, lowercased) -> normalized field name
_MEMBER_RE = re.compile(r"team member\s*(\d+)", re.IGNORECASE)
_KNOWN_FIELD_PATTERNS = [
    (re.compile(r"^section$", re.IGNORECASE), "section"),
    (re.compile(r"^zone$", re.IGNORECASE), "zone"),
    (re.compile(r"^notes?$", re.IGNORECASE), "notes"),
    (re.compile(r"zones\s*left", re.IGNORECASE), "zones_left"),
    (re.compile(r"count\s*team", re.IGNORECASE), "count_team"),
    (re.compile(r"^mfr\d*$", re.IGNORECASE), "mfr"),
]

# A row is recognized as a phase's header row (as opposed to a stray
# instructional/notes row like "If colored, group together for next team",
# or a one-off annotation cell like a lone "YARD") only if at least one
# cell matches one of these -- every real header row in the sheet has a
# "Team Member" cell, but the trigger list stays a little wider in case
# wording drifts.
_HEADER_TRIGGER_RE = re.compile(
    r"team member|^section$|^zone$|zones\s*left|^mfr\d*$|count\s*team",
    re.IGNORECASE,
)


@dataclass
class TeamRow:
    team_id: str
    members: List[str] = field(default_factory=list)
    section: Optional[str] = None
    zone: Optional[str] = None
    notes: Optional[str] = None
    zones_left: Optional[str] = None
    count_team: Optional[str] = None
    mfr: List[str] = field(default_factory=list)
    extra: Dict[str, str] = field(default_factory=dict)


@dataclass
class Phase:
    title: str
    description: str = ""
    columns: List[str] = field(default_factory=list)
    teams: List[TeamRow] = field(default_factory=list)


def _classify_header(col_index: int, header_text: str) -> Optional[str]:
    header_text = header_text.strip()
    if not header_text:
        return None
    m = _MEMBER_RE.search(header_text)
    if m:
        return f"member{m.group(1)}"
    for pattern, field_name in _KNOWN_FIELD_PATTERNS:
        if pattern.search(header_text):
            return field_name
    return header_text  # unknown -> keep verbatim as the field key


def parse_count_teams(csv_text: str) -> List[Phase]:
    rows = parse_csv(csv_text)
    phases: List[Phase] = []

    current: Optional[Phase] = None
    # column index -> normalized field name, for the current phase
    header_map: Dict[int, str] = {}
    awaiting_header = False

    for row in rows:
        first = cell(row, 1).strip()

        if first.lower().startswith("for ") and len(first) > 4:
            current = Phase(title=first, description=cell(row, 2).strip())
            phases.append(current)
            header_map = {}
            awaiting_header = True
            continue

        if current is None:
            continue

        if row_is_blank(row):
            # blank row: harmless between title/header/data; don't treat
            # as the header and don't end awaiting_header early
            continue

        team_id = cell(row, 0).strip()
        if awaiting_header and not TEAM_ID_RE.match(team_id):
            if any(_HEADER_TRIGGER_RE.search(c) for c in row):
                header_map = {}
                current.columns = []
                for idx, raw_header in enumerate(row):
                    field_name = _classify_header(idx, raw_header)
                    if field_name:
                        header_map[idx] = field_name
                        current.columns.append(raw_header.strip())
                awaiting_header = False
            # else: stray instructional/annotation row before the real
            # header (e.g. "If colored, group together..." or a lone
            # "YARD" note) -- skip it and keep waiting for the header
            continue

        if TEAM_ID_RE.match(team_id):
            data = TeamRow(team_id=team_id)
            for idx, field_name in header_map.items():
                val = cell(row, idx).strip()
                if not val:
                    continue
                if field_name.startswith("member"):
                    data.members.append(val)
                elif field_name == "mfr":
                    data.mfr.append(val)
                elif field_name in {
                    "section",
                    "zone",
                    "notes",
                    "zones_left",
                    "count_team",
                }:
                    setattr(data, field_name, val)
                else:
                    data.extra[field_name] = val
            current.teams.append(data)
            awaiting_header = False
            continue

        # otherwise: a stray row with data in a column we don't track
        # (team_id didn't match, and awaiting_header was already false)
        # -- skip

    return phases


def phases_to_dict(phases: List[Phase]) -> list:
    return [
        {
            "title": p.title,
            "description": p.description,
            "columns": p.columns,
            "teams": [
                {
                    "teamId": t.team_id,
                    "members": t.members,
                    "section": t.section,
                    "zone": t.zone,
                    "notes": t.notes,
                    "zonesLeft": t.zones_left,
                    "countTeam": t.count_team,
                    "mfr": t.mfr,
                    "extra": t.extra,
                }
                for t in p.teams
            ],
        }
        for p in phases
    ]
