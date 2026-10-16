"""Manager-only features: the "Question" call queue and the part lookup.

* Phones running the companion app POST to /api/question when a team taps
  "Question". That call sits in an in-memory queue until the manager
  marks it "On my way" and then "Done". The phone polls its own call to
  show the manager's response. (In-memory is fine: one server instance,
  and a call is only meaningful for a few minutes. A redeploy clears it.)
* The manager page (static/manager.html) polls the queue and searches the
  LPF tab of the sheet by MFR / Catalog #.

Everything under /api/manager/* needs the MANAGER_PASSWORD env var, sent
as the X-Manager-Key header. If that env var isn't set, those endpoints
refuse to work at all rather than being open to anyone.
"""
from __future__ import annotations

import hmac
import itertools
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional

import httpx
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import config
from .parsers.csv_utils import cell, parse_csv, row_is_blank

# ------------------------------------------------------------------ auth


def require_manager(key: Optional[str]) -> None:
    expected = config.MANAGER_PASSWORD
    if not expected:
        raise HTTPException(503, "MANAGER_PASSWORD is not set on the server.")
    if not key or not hmac.compare_digest(key.encode(), expected.encode()):
        raise HTTPException(401, "Wrong password.")


# ------------------------------------------------------------- questions

OPEN = "open"
ACK = "ack"
DONE = "done"
CANCELLED = "cancelled"
KEEP_CLOSED_SECONDS = 30 * 60  # finished calls stay visible for 30 minutes
MAX_CALLS = 200


@dataclass
class Call:
    id: str
    team: str
    members: List[str] = field(default_factory=list)
    phase: str = ""
    assignment: str = ""
    note: str = ""
    status: str = OPEN
    created_at: float = 0.0
    updated_at: float = 0.0
    times_called: int = 1

    def public(self) -> dict:
        return {"id": self.id, "status": self.status, "updatedAt": self.updated_at}

    def full(self) -> dict:
        d = asdict(self)
        d["createdAt"] = d.pop("created_at")
        d["updatedAt"] = d.pop("updated_at")
        d["timesCalled"] = d.pop("times_called")
        return d


class CallQueue:
    def __init__(self) -> None:
        self.calls: Dict[str, Call] = {}
        self._ids = itertools.count(1)

    def _prune(self, now: float) -> None:
        for cid in [c.id for c in self.calls.values()
                    if c.status in (DONE, CANCELLED) and now - c.updated_at > KEEP_CLOSED_SECONDS]:
            del self.calls[cid]
        while len(self.calls) > MAX_CALLS:
            del self.calls[min(self.calls.values(), key=lambda c: c.updated_at).id]

    def raise_hand(self, team: str, members: List[str], phase: str,
                   assignment: str, note: str, now: Optional[float] = None) -> Call:
        now = now or time.time()
        self._prune(now)
        # One live call per team: tapping again bumps it instead of piling up.
        for c in self.calls.values():
            if c.team.lower() == team.lower() and c.status in (OPEN, ACK):
                c.times_called += 1
                c.updated_at = now
                c.status = OPEN  # re-alert, even if already acknowledged
                if note:
                    c.note = note
                c.phase, c.assignment, c.members = phase or c.phase, assignment or c.assignment, members or c.members
                return c
        call = Call(id=f"q{next(self._ids)}-{int(now)}", team=team, members=members,
                    phase=phase, assignment=assignment, note=note,
                    created_at=now, updated_at=now)
        self.calls[call.id] = call
        return call

    def set_status(self, cid: str, status: str, now: Optional[float] = None) -> Call:
        c = self.calls.get(cid)
        if not c:
            raise KeyError(cid)
        c.status = status
        c.updated_at = now or time.time()
        return c

    def listing(self, now: Optional[float] = None) -> List[dict]:
        now = now or time.time()
        self._prune(now)
        order = {OPEN: 0, ACK: 1, DONE: 2, CANCELLED: 3}
        calls = sorted(self.calls.values(), key=lambda c: (order[c.status], c.created_at if c.status in (OPEN, ACK) else -c.updated_at))
        return [c.full() for c in calls]


queue = CallQueue()


# ---------------------------------------------------------------- lookup

# Columns B..H of the LPF tab: Mfr, Catalog #, Description, LPO Cost, UOM,
# OH Qty, Qty Avail. Taken by position (that's what "B through H" means),
# with the labels read from the sheet's own header row.
LOOKUP_COLS = range(1, 8)
MFR_COL, CAT_COL = 1, 2
LOOKUP_CACHE_SECONDS = 60


def _norm(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", s.upper())


@dataclass
class LookupTable:
    headers: List[str] = field(default_factory=list)
    rows: List[List[str]] = field(default_factory=list)
    fetched_at: float = 0.0


def parse_lookup(text: str) -> LookupTable:
    grid = parse_csv(text)
    hdr = next((i for i, r in enumerate(grid[:15]) if "catalog" in cell(r, CAT_COL).lower()), 0)
    head = grid[hdr] if grid else []
    headers = [cell(head, i) or f"Column {chr(65 + i)}" for i in LOOKUP_COLS]
    rows = []
    for r in grid[hdr + 1:]:
        vals = [cell(r, i) for i in LOOKUP_COLS]
        if row_is_blank(vals) or not (vals[0] or vals[1]):
            continue
        rows.append(vals)
    return LookupTable(headers=headers, rows=rows)


def search(table: LookupTable, query: str, limit: int = 50) -> List[List[str]]:
    """Match on Catalog # first, MFR second.

    Every word in the query must hit either the MFR or the Catalog #, so
    "ANKER A5220" and "A5220" both work. Punctuation/spaces are ignored
    ("emt-3/4" finds "EMT-3/4"). Best matches first: exact catalog, then
    catalog starting with the query, then catalog containing it, then MFR.
    """
    words = [w for w in (_norm(t) for t in query.split()) if w]
    if not words:
        return []
    whole = _norm(query)
    scored = []
    for idx, row in enumerate(table.rows):
        mfr, cat = _norm(row[MFR_COL - 1]), _norm(row[CAT_COL - 1])
        if not all(w in cat or w in mfr for w in words):
            # also allow the catalog typed with spaces in it ("EMT 3/4")
            if not (whole and whole in cat):
                continue
        cat_words = [w for w in words if w not in mfr] or words
        cw = "".join(cat_words)
        if cat == whole or cat == cw:
            score = 0
        elif cat.startswith(cw):
            score = 1
        elif cw in cat:
            score = 2
        else:
            score = 3  # matched on MFR only
        scored.append((score, len(cat), idx, row))
    scored.sort(key=lambda t: t[:3])
    return [r for *_, r in scored[:limit]]


class LookupCache:
    def __init__(self) -> None:
        self.table = LookupTable()

    async def get(self, client: Optional[httpx.AsyncClient] = None) -> LookupTable:
        if time.time() - self.table.fetched_at < LOOKUP_CACHE_SECONDS and self.table.rows:
            return self.table
        owns = client is None
        client = client or httpx.AsyncClient(timeout=15.0)
        try:
            resp = await client.get(config.sheet_csv_url(config.GID_LOOKUP), follow_redirects=True)
            resp.raise_for_status()
            table = parse_lookup(resp.text)
            table.fetched_at = time.time()
            self.table = table
        except Exception:  # noqa: BLE001 - fall back to the last good copy
            if not self.table.rows:
                raise
        finally:
            if owns:
                await client.aclose()
        return self.table


lookup_cache = LookupCache()


# ---------------------------------------------------------------- routes

router = APIRouter(prefix="/api")


class QuestionIn(BaseModel):
    team: str
    members: List[str] = []
    phase: str = ""
    assignment: str = ""
    note: str = ""


def _clip(s: str, n: int) -> str:
    return (s or "").strip()[:n]


@router.post("/question")
async def raise_question(q: QuestionIn) -> dict:
    team = _clip(q.team, 40)
    if not team:
        raise HTTPException(400, "team is required")
    call = queue.raise_hand(team, [_clip(m, 60) for m in q.members[:6]],
                            _clip(q.phase, 40), _clip(q.assignment, 200), _clip(q.note, 280))
    return call.public()


@router.get("/question/{cid}")
async def question_status(cid: str) -> dict:
    c = queue.calls.get(cid)
    if not c:
        return {"id": cid, "status": DONE, "updatedAt": 0}
    return c.public()


@router.post("/question/{cid}/cancel")
async def cancel_question(cid: str) -> dict:
    c = queue.calls.get(cid)
    if c and c.status in (OPEN, ACK):
        queue.set_status(cid, CANCELLED)
    return {"id": cid, "status": CANCELLED}


@router.get("/manager/questions")
async def list_questions(x_manager_key: Optional[str] = Header(None)) -> dict:
    require_manager(x_manager_key)
    return {"now": time.time(), "calls": queue.listing()}


@router.post("/manager/questions/{cid}/{action}")
async def update_question(cid: str, action: str, x_manager_key: Optional[str] = Header(None)) -> dict:
    require_manager(x_manager_key)
    status = {"ack": ACK, "done": DONE, "reopen": OPEN}.get(action)
    if not status:
        raise HTTPException(400, "action must be ack, done or reopen")
    try:
        return queue.set_status(cid, status).full()
    except KeyError:
        raise HTTPException(404, "No such call.")


@router.get("/manager/lookup")
async def lookup(q: str = "", x_manager_key: Optional[str] = Header(None)) -> dict:
    require_manager(x_manager_key)
    try:
        table = await lookup_cache.get()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Couldn't read the LPF tab: {exc}")
    results = search(table, q) if q.strip() else []
    return {"headers": table.headers, "results": results,
            "total": len(table.rows), "fetchedAt": table.fetched_at}


# ------------------------------------------------------- private page
#
# The manager page lives only at /m/<MANAGER_PASSWORD>. Any other key gets
# a plain 404, so the page looks like it doesn't exist. It isn't linked
# from the dashboard or the companion (no QR, no button).

PAGE_DIR = Path(__file__).resolve().parent / "manager_page"
page_router = APIRouter()
_PRIVATE = {"X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store"}


@page_router.get("/m/{key}", include_in_schema=False)
async def manager_page(key: str):
    expected = config.MANAGER_PASSWORD
    if not expected or not hmac.compare_digest(key.encode(), expected.encode()):
        raise HTTPException(404, "Not Found")
    return FileResponse(PAGE_DIR / "manager.html", headers=_PRIVATE)


@page_router.get("/m-assets/{name}", include_in_schema=False)
async def manager_asset(name: str):
    if name not in ("manager.css", "manager.js"):
        raise HTTPException(404, "Not Found")
    return FileResponse(PAGE_DIR / name, headers={"Cache-Control": "no-cache"})


@router.get("/manager/check")
async def check(x_manager_key: Optional[str] = Header(None)) -> dict:
    require_manager(x_manager_key)
    return {"ok": True}
