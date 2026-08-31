from __future__ import annotations

from fastapi import APIRouter

from ..cache import cache

router = APIRouter(prefix="/api")


@router.get("/health")
async def health() -> dict:
    return {"ok": True}


@router.get("/dashboard")
async def dashboard() -> dict:
    return cache.snapshot.to_dict()


@router.get("/timeline")
async def timeline() -> dict:
    return cache.snapshot.timeline


@router.get("/count-teams")
async def count_teams() -> list:
    return cache.snapshot.count_teams


@router.get("/bins")
async def bins() -> dict:
    return cache.snapshot.bins
