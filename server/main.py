"""Entrypoint: `python -m server.main` (or the uvicorn command in the
README/Dockerfile) starts the API + background sheet-polling loop and
serves the dashboard.
"""
from __future__ import annotations

import uvicorn

from . import config
from .app import create_app

app = create_app(start_background=True)

if __name__ == "__main__":
    uvicorn.run(
        "server.main:app", host=config.HOST, port=config.PORT, reload=False
    )
