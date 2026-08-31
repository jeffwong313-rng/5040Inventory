"""There's no JS runtime available to unit-test app.js directly, so this
suite does two things instead: (1) statically verifies every DOM id the
script looks up actually exists in index.html, so a rename on one side
can't silently break the dashboard, and (2) checks the static assets are
served correctly through the real FastAPI app.
"""
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import STATIC_DIR, create_app

INDEX_HTML = (STATIC_DIR / "index.html").read_text()
APP_JS = (STATIC_DIR / "app.js").read_text()
STYLES_CSS = (STATIC_DIR / "styles.css").read_text()


def test_static_files_exist():
    assert (STATIC_DIR / "index.html").exists()
    assert (STATIC_DIR / "app.js").exists()
    assert (STATIC_DIR / "styles.css").exists()


def test_every_js_id_lookup_exists_in_html():
    referenced_ids = set(re.findall(r'\$\("([\w-]+)"\)', APP_JS))
    html_ids = set(re.findall(r'id="([\w-]+)"', INDEX_HTML))
    missing = referenced_ids - html_ids
    assert not missing, f"app.js references #{missing} but index.html has no such id"


def test_index_links_stylesheet_and_script():
    assert '<link rel="stylesheet" href="/styles.css" />' in INDEX_HTML
    assert '<script src="/app.js">' in INDEX_HTML


def test_index_has_viewport_meta_for_mobile():
    assert "width=device-width" in INDEX_HTML


def test_app_js_braces_and_parens_balanced():
    # crude but effective guard against a stray typo breaking the file
    assert APP_JS.count("{") == APP_JS.count("}")
    assert APP_JS.count("(") == APP_JS.count(")")


@pytest.fixture
def client():
    app = create_app(start_background=False)
    with TestClient(app) as c:
        yield c


def test_styles_served(client):
    resp = client.get("/styles.css")
    assert resp.status_code == 200
    assert "text/css" in resp.headers["content-type"]


def test_app_js_served(client):
    resp = client.get("/app.js")
    assert resp.status_code == 200
    assert "javascript" in resp.headers["content-type"]
