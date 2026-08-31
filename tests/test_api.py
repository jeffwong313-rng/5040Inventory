import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.cache import Snapshot, cache


@pytest.fixture
def client():
    app = create_app(start_background=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def reset_cache_snapshot():
    original = cache.snapshot
    cache.snapshot = Snapshot()
    yield
    cache.snapshot = original


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_dashboard_reflects_cache_snapshot(client):
    cache.snapshot.timeline = {"date": "Friday", "entries": [{"time": "1PM", "event": "Go", "notes": ""}]}
    cache.snapshot.count_teams = [{"title": "For PreCounts", "teams": []}]
    cache.snapshot.bins = {"groups": [], "summary": {"totalGroups": 0}}

    resp = client.get("/api/dashboard")
    body = resp.json()

    assert body["timeline"]["date"] == "Friday"
    assert body["countTeams"][0]["title"] == "For PreCounts"
    assert body["bins"]["summary"]["totalGroups"] == 0
    assert body["source"]["sheetId"]
    assert body["source"]["stale"] is True  # no successful fetch yet


def test_timeline_endpoint(client):
    cache.snapshot.timeline = {"date": "X", "entries": []}
    resp = client.get("/api/timeline")
    assert resp.json() == {"date": "X", "entries": []}


def test_count_teams_endpoint(client):
    cache.snapshot.count_teams = [{"title": "For PreCounts", "teams": []}]
    resp = client.get("/api/count-teams")
    assert resp.json() == [{"title": "For PreCounts", "teams": []}]


def test_bins_endpoint(client):
    resp = client.get("/api/bins")
    assert "summary" in resp.json()


def test_serves_dashboard_index_html(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
