"""Fetches the tabs we care about from the public Google Sheet as
CSV. The sheet must be shared "Anyone with the link can view" -- this app
never authenticates and never writes to the sheet.
"""
from __future__ import annotations

import asyncio
from typing import Dict

import httpx

from . import config

TABS = ("timeline", "count_teams", "whats_left")

_GIDS = {
    "timeline": config.GID_TIMELINE,
    "count_teams": config.GID_COUNT_TEAMS,
    "whats_left": config.GID_WHATS_LEFT,
}

_HEADERS = {"User-Agent": "warehouse-dashboard/1.0 (+read-only sheet sync)"}


async def fetch_tab(client: httpx.AsyncClient, tab: str) -> str:
    url = config.sheet_csv_url(_GIDS[tab])
    resp = await client.get(url, headers=_HEADERS, follow_redirects=True)
    resp.raise_for_status()
    return resp.text


async def fetch_all(client: httpx.AsyncClient) -> Dict[str, str]:
    results = await asyncio.gather(
        *(fetch_tab(client, tab) for tab in TABS)
    )
    return dict(zip(TABS, results))
