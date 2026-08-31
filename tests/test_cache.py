import httpx
import respx

from server import config
from server.cache import SheetCache


def _mock_sheet_routes(timeline_csv: str, count_teams_csv: str, all_bins_csv: str):
    respx.get(config.sheet_csv_url(config.GID_TIMELINE)).mock(
        return_value=httpx.Response(200, text=timeline_csv)
    )
    respx.get(config.sheet_csv_url(config.GID_COUNT_TEAMS)).mock(
        return_value=httpx.Response(200, text=count_teams_csv)
    )
    respx.get(config.sheet_csv_url(config.GID_ALL_BINS)).mock(
        return_value=httpx.Response(200, text=all_bins_csv)
    )


@respx.mock
async def test_refresh_once_populates_snapshot(
    timeline_csv, count_teams_csv, all_bins_csv
):
    _mock_sheet_routes(timeline_csv, count_teams_csv, all_bins_csv)
    c = SheetCache()

    async with httpx.AsyncClient() as client:
        await c.refresh_once(client)

    assert c.snapshot.last_error is None
    assert c.snapshot.last_success_at is not None
    assert c.snapshot.timeline["date"] == "Friday, September 18, 2026"
    assert len(c.snapshot.count_teams) == 3
    assert c.snapshot.bins["summary"]["totalGroups"] == 7
    assert c.snapshot.is_stale() is False


@respx.mock
async def test_refresh_once_keeps_last_good_snapshot_on_failure(
    timeline_csv, count_teams_csv, all_bins_csv
):
    _mock_sheet_routes(timeline_csv, count_teams_csv, all_bins_csv)
    c = SheetCache()
    async with httpx.AsyncClient() as client:
        await c.refresh_once(client)
        assert c.snapshot.last_error is None

        respx.get(config.sheet_csv_url(config.GID_TIMELINE)).mock(
            return_value=httpx.Response(500)
        )
        await c.refresh_once(client)

    # last good data is still there ...
    assert c.snapshot.timeline["date"] == "Friday, September 18, 2026"
    # ... but the failure is now recorded
    assert c.snapshot.last_error is not None


async def test_snapshot_is_stale_before_first_success():
    c = SheetCache()
    assert c.snapshot.is_stale() is True
    assert c.snapshot.to_dict()["source"]["stale"] is True
