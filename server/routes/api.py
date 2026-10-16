from __future__ import annotations

from fastapi import APIRouter

from ..cache import cache
from ..round_control import round_state

router = APIRouter(prefix="/api")


@router.get("/health")
async def health() -> dict:
    return {"ok": True}


@router.get("/dashboard")
async def dashboard() -> dict:
    # the manager's current round rides along so the TV follows it too
    return {**cache.snapshot.to_dict(), "round": round_state.public()}


@router.get("/timeline")
async def timeline() -> dict:
    return cache.snapshot.timeline


@router.get("/count-teams")
async def count_teams() -> list:
    return cache.snapshot.count_teams


@router.get("/bins")
async def bins() -> dict:
    return cache.snapshot.bins
