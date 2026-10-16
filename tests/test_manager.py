from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import config, manager
from server.app import create_app

LPF = (Path(__file__).parent / "fixtures" / "lpf.csv").read_text()
KEY = {"X-Manager-Key": "s3cret"}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(config, "MANAGER_PASSWORD", "s3cret")
    monkeypatch.setattr(manager, "queue", manager.CallQueue())
    table = manager.parse_lookup(LPF)
    table.fetched_at = 9e18  # never refetch during tests
    monkeypatch.setattr(manager.lookup_cache, "table", table)


@pytest.fixture
def client():
    with TestClient(create_app(start_background=False)) as c:
        yield c


# ---------------------------------------------------------------- lookup

def test_parse_lookup_takes_columns_b_to_h():
    t = manager.parse_lookup(LPF)
    assert t.headers == ["Mfr", "Catalog #", "Description", "LPO Cost", "UOM", "OH Qty", "Qty Avail"]
    assert t.rows[0] == ["ANKER", "A5101JZ3", "POWER MODULE W/WALL MNT & ACSRY K", "1196", "E", "11", "11"]
    assert len(t.rows) == 6  # blank row dropped


def cats(results):
    return [r[1] for r in results]


def test_search_catalog_exact_first():
    t = manager.parse_lookup(LPF)
    assert cats(manager.search(t, "a5220jz1")) == ["A5220JZ1", "A5220JZ1-B"]


def test_search_catalog_partial_and_punctuation():
    t = manager.parse_lookup(LPF)
    assert cats(manager.search(t, "emt 3/4")) == ["EMT-3/4 (10)*"]
    assert cats(manager.search(t, "V1A6")) == ["V-1-A-6"]
    assert cats(manager.search(t, "A52")) == ["A5220JZ1", "A5220JZ1-B"]


def test_search_by_mfr_and_mfr_plus_catalog():
    t = manager.parse_lookup(LPF)
    assert set(cats(manager.search(t, "anker"))) == {"A5101JZ3", "A5220JZ1", "A5220JZ1-B"}
    assert cats(manager.search(t, "ANKER A5101")) == ["A5101JZ3"]
    assert manager.search(t, "nothing-like-this") == []
    assert manager.search(t, "  ") == []


def test_lookup_endpoint(client):
    r = client.get("/api/manager/lookup", params={"q": "CRN75"}, headers=KEY)
    body = r.json()
    assert r.status_code == 200
    assert body["headers"][1] == "Catalog #"
    assert body["results"] == [["APP", "CRN75", "3/4 ALUM LOC DRAIN", "12.87", "E", "208", "208"]]
    assert body["total"] == 6


# ------------------------------------------------------------------ auth

def test_manager_endpoints_need_password(client):
    assert client.get("/api/manager/questions").status_code == 401
    assert client.get("/api/manager/questions", headers={"X-Manager-Key": "nope"}).status_code == 401
    assert client.get("/api/manager/lookup?q=a", headers={"X-Manager-Key": "nope"}).status_code == 401
    assert client.get("/api/manager/check", headers=KEY).json() == {"ok": True}


def test_manager_disabled_when_no_password_set(client, monkeypatch):
    monkeypatch.setattr(config, "MANAGER_PASSWORD", "")
    assert client.get("/api/manager/questions", headers={"X-Manager-Key": ""}).status_code == 503


# ------------------------------------------------------------- questions

def test_question_flow(client):
    r = client.post("/api/question", json={"team": "Team 3", "members": ["Ana", "Bo"], "phase": "First Count",
                                           "assignment": "WH1-RED-A", "note": "Can't find a bin"})
    call = r.json()
    assert call["status"] == "open"

    listed = client.get("/api/manager/questions", headers=KEY).json()["calls"]
    assert listed[0]["team"] == "Team 3" and listed[0]["note"] == "Can't find a bin"
    assert listed[0]["assignment"] == "WH1-RED-A"

    client.post(f"/api/manager/questions/{call['id']}/ack", headers=KEY)
    assert client.get(f"/api/question/{call['id']}").json()["status"] == "ack"
    client.post(f"/api/manager/questions/{call['id']}/done", headers=KEY)
    assert client.get(f"/api/question/{call['id']}").json()["status"] == "done"


def test_same_team_twice_bumps_one_call(client):
    a = client.post("/api/question", json={"team": "Team 3"}).json()
    client.post(f"/api/manager/questions/{a['id']}/ack", headers=KEY)
    b = client.post("/api/question", json={"team": "team 3", "note": "still stuck"}).json()
    assert a["id"] == b["id"] and b["status"] == "open"  # re-alerts
    calls = client.get("/api/manager/questions", headers=KEY).json()["calls"]
    assert len(calls) == 1 and calls[0]["timesCalled"] == 2 and calls[0]["note"] == "still stuck"


def test_phone_can_cancel(client):
    a = client.post("/api/question", json={"team": "Team 1"}).json()
    client.post(f"/api/question/{a['id']}/cancel")
    assert client.get(f"/api/question/{a['id']}").json()["status"] == "cancelled"


def test_question_needs_team(client):
    assert client.post("/api/question", json={"team": "  "}).status_code == 400


def test_cors_allows_companion_site(client):
    r = client.options("/api/question", headers={
        "Origin": "https://jeffwong313-rng.github.io",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://jeffwong313-rng.github.io"


def test_manager_page_only_at_private_link(client):
    r = client.get("/m/s3cret")
    assert r.status_code == 200 and "manager.js" in r.text
    assert "noindex" in r.headers["x-robots-tag"]
    assert client.get("/m/wrong").status_code == 404
    assert client.get("/manager.html").status_code == 404
    assert client.get("/m-assets/manager.js").status_code == 200


def test_manager_page_off_without_password(client, monkeypatch):
    monkeypatch.setattr(config, "MANAGER_PASSWORD", "")
    assert client.get("/m/").status_code == 404
    assert client.get("/m/anything").status_code == 404


def test_nothing_public_links_to_manager_page():
    root = Path(__file__).resolve().parent.parent
    for f in ["static/index.html", "static/app.js", "docs/index.html", "docs/app.js", "docs/question.js"]:
        text = (root / f).read_text()
        assert "/m/" not in text and "manager.html" not in text, f
