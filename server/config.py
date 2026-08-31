"""Configuration for the warehouse dashboard server.

Everything is read from environment variables so the same code can run
locally, in Docker, or on a hosting platform (Render/Railway/Fly/etc.)
without code changes. Sensible defaults point at the real 2027 inventory
sheet the app was built for.
"""
from __future__ import annotations

import os


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# The Google Sheet must be shared as "Anyone with the link can view" for the
# CSV export endpoints below to work without authentication. The app never
# writes to the sheet -- it only ever reads it.
SHEET_ID = os.environ.get(
    "SHEET_ID", "1j--r1edg8-_njQzHx9kBNeuy0nI9iOhapH3epCzPDXw"
)

# Tab (gid) ids, discovered from the sheet's own tab URLs. Override via env
# vars if the user renames/reorders/recreates a tab and its gid changes.
GID_TIMELINE = os.environ.get("GID_TIMELINE", "289573693")
GID_COUNT_TEAMS = os.environ.get("GID_COUNT_TEAMS", "208058828")
GID_ALL_BINS = os.environ.get("GID_ALL_BINS", "91380376")

# How often the server re-pulls the sheet, in seconds. The dashboard polls
# the server about this often too (see static/app.js), so this is the true
# end-to-end "how stale can the dashboard be" number.
POLL_INTERVAL_SECONDS = _env_int("POLL_INTERVAL_SECONDS", 20)

# If a fetch fails, the server keeps serving the last good snapshot instead
# of blanking the dashboard out. This is how long it will keep doing that
# before it starts telling viewers the data may be stale.
STALE_AFTER_SECONDS = _env_int("STALE_AFTER_SECONDS", 120)

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = _env_int("PORT", 8000)


def sheet_csv_url(gid: str) -> str:
    return (
        f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
        f"/export?format=csv&gid={gid}"
    )
