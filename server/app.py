from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from . import config
from .cache import cache
from .manager import page_router as manager_page_router
from .manager import router as manager_router
from .round_control import router as round_router
from .routes.api import router as api_router

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    """Forces browsers to revalidate the dashboard's HTML/CSS/JS on every
    load instead of serving a stale cached copy. This is a dashboard that
    gets tweaked and redeployed; without this, a phone or the TV's browser
    can keep showing an old layout until someone thinks to hard-refresh.

    Still cheap: revalidation is a conditional GET (304 if unchanged), not
    a full re-download every time -- this just stops browsers from
    skipping that check entirely.
    """

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(start_background: bool = True) -> FastAPI:
    """Build the FastAPI app.

    `start_background=False` is used by the test suite so importing the
    app never fires off real requests to Google Sheets; tests instead
    call `cache.refresh_once(...)` themselves against a mocked client.
    """

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if start_background:
            cache.start()
        try:
            yield
        finally:
            if start_background:
                await cache.stop()

    app = FastAPI(title="Warehouse Inventory Dashboard", lifespan=lifespan)
    app.add_middleware(NoCacheStaticMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
    app.include_router(api_router)
    app.include_router(manager_router)
    app.include_router(round_router)
    app.include_router(manager_page_router)

    if STATIC_DIR.exists():
        # mounted last so /api/* routes above are matched first
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return app
