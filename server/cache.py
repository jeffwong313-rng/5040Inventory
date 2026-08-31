"""In-memory snapshot of the parsed sheet, kept fresh by a background
polling loop. If a fetch fails, the last good snapshot is kept and served
(with a staleness flag) rather than blanking the dashboard out.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx

from . import config
from .parsers.bins import parse_bins
from .parsers.count_teams import parse_count_teams, phases_to_dict
from .parsers.timeline import parse_timeline, timeline_to_dict
from .sheets_client import fetch_all

logger = logging.getLogger("warehouse_dashboard.cache")


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Snapshot:
    timeline: dict = field(default_factory=lambda: {"date": None, "entries": []})
    count_teams: list = field(default_factory=list)
    bins: dict = field(
        default_factory=lambda: {
            "groups": [],
            "summary": {
                "totalGroups": 0,
                "counted": 0,
                "inProgress": 0,
                "notStarted": 0,
                "percentComplete": 0.0,
                "byWarehouse": [],
                "remainingGroups": [],
            },
        }
    )
    last_success_at: Optional[datetime] = None
    last_attempt_at: Optional[datetime] = None
    last_error: Optional[str] = None

    def is_stale(self, now: Optional[datetime] = None) -> bool:
        now = now or _now()
        if self.last_success_at is None:
            return True
        age = (now - self.last_success_at).total_seconds()
        return age > config.STALE_AFTER_SECONDS

    def to_dict(self) -> dict:
        now = _now()
        return {
            "generatedAt": now.isoformat(),
            "source": {
                "sheetId": config.SHEET_ID,
                "lastSuccessAt": (
                    self.last_success_at.isoformat()
                    if self.last_success_at
                    else None
                ),
                "lastAttemptAt": (
                    self.last_attempt_at.isoformat()
                    if self.last_attempt_at
                    else None
                ),
                "stale": self.is_stale(now),
                "error": self.last_error,
                "pollIntervalSeconds": config.POLL_INTERVAL_SECONDS,
            },
            "timeline": self.timeline,
            "countTeams": self.count_teams,
            "bins": self.bins,
        }


class SheetCache:
    def __init__(self) -> None:
        self.snapshot = Snapshot()
        self._task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    async def refresh_once(self, client: httpx.AsyncClient) -> None:
        async with self._lock:
            self.snapshot.last_attempt_at = _now()
            try:
                raw = await fetch_all(client)
                timeline = timeline_to_dict(parse_timeline(raw["timeline"]))
                count_teams = phases_to_dict(
                    parse_count_teams(raw["count_teams"])
                )
                bins = parse_bins(raw["all_bins"])
            except Exception as exc:  # noqa: BLE001 - keep serving last good data
                logger.warning("sheet refresh failed: %s", exc)
                self.snapshot.last_error = str(exc)
                return

            self.snapshot.timeline = timeline
            self.snapshot.count_teams = count_teams
            self.snapshot.bins = bins
            self.snapshot.last_success_at = _now()
            self.snapshot.last_error = None

    async def _loop(self) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            while True:
                await self.refresh_once(client)
                await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None


cache = SheetCache()
