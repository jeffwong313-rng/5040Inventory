from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _read(name: str) -> str:
    return (FIXTURES_DIR / name).read_text()


@pytest.fixture
def timeline_csv() -> str:
    return _read("timeline.csv")


@pytest.fixture
def count_teams_csv() -> str:
    return _read("count_teams.csv")


@pytest.fixture
def all_bins_csv() -> str:
    return _read("all_bins.csv")
