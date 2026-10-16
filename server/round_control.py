"""The manager's "everyone is on this round now" switch.

The day runs PreCounts -> First Count (official counts) -> Variance 1 ...
Everyone starts on the first round (PreCounts). When the manager taps a
round on the manager page, the server remembers it here, and every screen
(the TV dashboard and every phone running the companion) switches to that
round on its next poll. Anyone who then taps a different round gets a
warning first.

Kept in memory like the Question queue: one server instance, and the
manager page re-sends its last choice if the server restarted and forgot
it, so a redeploy or a Render wake-up doesn't drop everyone back to
PreCounts.
"""
from __future__ import annotations

import re
import time
from typing import Optional

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .manager import require_manager


def phase_key(name: str) -> str:
    """'For PreCounts' / 'PreCounts' / 'precount' -> 'precounts'.

    The dashboard reads phase titles as 'For PreCounts' and the companion
    as 'PreCounts', so both sides match rounds through this key.
    """
    s = re.sub(r"^\s*for\s+", "", name or "", flags=re.I)
    s = re.sub(r"[^a-z0-9]", "", s.lower())
    if s == "precount":
        s = "precounts"
    return s


class RoundState:
    def __init__(self) -> None:
        self.clear()

    def clear(self) -> None:
        self.phase: Optional[str] = None  # phase_key of the round, None = not set
        self.label: str = ""
        self.set_at: float = 0.0

    def set(self, label: str, set_at: Optional[float] = None) -> None:
        key = phase_key(label)
        if not key:
            self.clear()
            return
        self.phase = key
        self.label = re.sub(r"^\s*for\s+", "", label, flags=re.I).strip()[:40]
        self.set_at = set_at or time.time()

    def public(self) -> dict:
        return {"phase": self.phase, "label": self.label, "setAt": self.set_at}


round_state = RoundState()

router = APIRouter(prefix="/api")
_NO_STORE = {"Cache-Control": "no-store"}


@router.get("/round")
async def get_round():
    return JSONResponse(round_state.public(), headers=_NO_STORE)


class RoundIn(BaseModel):
    label: str = ""  # "" clears the override
    setAt: Optional[float] = None  # used when re-sending after a restart


@router.post("/manager/round")
async def set_round(body: RoundIn, x_manager_key: Optional[str] = Header(None)) -> dict:
    require_manager(x_manager_key)
    set_at = body.setAt
    # only trust a re-sent timestamp if it's from the last day and not in the future
    if set_at is not None and not (time.time() - 86400 < set_at <= time.time() + 5):
        set_at = None
    round_state.set(body.label, set_at)
    return round_state.public()
