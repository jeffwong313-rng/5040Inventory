import time

import pytest
from fastapi.testclient import TestClient

from server import config, round_control
from server.app import create_app

KEY = {"X-Manager-Key": "s3cret"}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(config, "MANAGER_PASSWORD", "s3cret")
    round_control.round_state.clear()
    yield
    round_control.round_state.clear()


@pytest.fixture
def client():
    with TestClient(create_app(start_background=False)) as c:
        yield c


def test_phase_key_matches_dashboard_and_companion_names():
    k = round_control.phase_key
    assert k("For PreCounts") == k("PreCounts") == k("precount") == "precounts"
    assert k("For First Count") == k("First Count") == "firstcount"
    assert k("For Variance 1") == "variance1"


def test_round_starts_unset(client):
    r = client.get("/api/round")
    assert r.status_code == 200
    assert r.json()["phase"] is None
    assert r.headers["cache-control"] == "no-store"


def test_manager_switches_everyone(client):
    r = client.post("/api/manager/round", json={"label": "For First Count"}, headers=KEY)
    assert r.status_code == 200
    body = client.get("/api/round").json()
    assert body["phase"] == "firstcount"
    assert body["label"] == "First Count"
    assert body["setAt"] > 0
    # the TV dashboard gets it in its normal payload
    assert client.get("/api/dashboard").json()["round"]["phase"] == "firstcount"


def test_only_manager_can_switch(client):
    assert client.post("/api/manager/round", json={"label": "Variance 1"}).status_code == 401
    assert client.post("/api/manager/round", json={"label": "Variance 1"},
                       headers={"X-Manager-Key": "nope"}).status_code == 401
    assert client.get("/api/round").json()["phase"] is None


def test_resend_after_restart_keeps_original_time(client):
    t = time.time() - 600
    client.post("/api/manager/round", json={"label": "First Count", "setAt": t}, headers=KEY)
    assert client.get("/api/round").json()["setAt"] == pytest.approx(t)
    # a stale or future timestamp is replaced with now
    client.post("/api/manager/round", json={"label": "Variance 1", "setAt": 5}, headers=KEY)
    assert client.get("/api/round").json()["setAt"] > t


def test_companion_site_can_read_round(client):
    r = client.get("/api/round", headers={"Origin": "https://jeffwong313-rng.github.io"})
    assert r.headers.get("access-control-allow-origin") == "https://jeffwong313-rng.github.io"
