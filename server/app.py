from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .cache import cache
from .routes.api import router as api_router

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


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
    app.include_router(api_router)

    if STATIC_DIR.exists():
        # mounted last so /api/* routes above are matched first
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return app
