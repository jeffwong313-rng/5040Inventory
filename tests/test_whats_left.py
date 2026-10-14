import pytest

from server.parsers.bins import COUNTED, IN_PROGRESS, NOT_STARTED
from server.parsers.whats_left import normalize_status, parse_whats_left


@pytest.mark.parametrize(
    "raw, expected",
    [("", NOT_STARTED), ("Assigned", IN_PROGRESS), ("Complete", COUNTED),
     ("complete", COUNTED), ("  ASSIGNED ", IN_PROGRESS)],
)
def test_normalize_status(raw, expected):
    assert normalize_status(raw) == expected


def test_legend_rows_above_header_are_ignored(whats_left_csv):
    zones = {z["group"] for z in parse_whats_left(whats_left_csv)["groups"]}
    assert "Assigned" not in zones and "Complete" not in zones
    assert len(zones) == 6


def test_rounds_discovered_from_team_columns(whats_left_csv):
    result = parse_whats_left(whats_left_csv)
    assert result["rounds"] == ["Precount", "Official Count", "Variance 1", "Variance 2"]


def test_zone_current_round_and_team(whats_left_csv):
    zones = {z["group"]: z for z in parse_whats_left(whats_left_csv)["groups"]}
    assert zones["WH1-BLUE-A"]["round"] == "Official Count"
    assert zones["WH1-BLUE-A"]["team"] == "Team4"
    assert zones["WH3-RED"]["round"] == "Variance 1"
    assert zones["WH1-BLUE-C"]["round"] is None


def test_summary(whats_left_csv):
    s = parse_whats_left(whats_left_csv)["summary"]
    assert s["totalGroups"] == 6
    assert s["counted"] == 2
    assert s["inProgress"] == 2
    assert s["notStarted"] == 2
    assert s["percentComplete"] == pytest.approx(33.3)
    assert s["currentRound"] == "Variance 1"
    by_round = {r["round"]: r["zones"] for r in s["byRound"]}
    assert by_round == {"Precount": 4, "Official Count": 2, "Variance 1": 1, "Variance 2": 0}
    by_wh = {w["warehouse"]: w for w in s["byWarehouse"]}
    assert by_wh["Warehouse 3"]["inProgress"] == 1
    assert by_wh["Yard"]["notStarted"] == 1


def test_remaining_lists_assigned_first_and_excludes_complete(whats_left_csv):
    remaining = parse_whats_left(whats_left_csv)["summary"]["remainingGroups"]
    names = [r["group"] for r in remaining]
    assert "WH1-BLUE-A" not in names and "WH2-GRAY" not in names
    assert names[:2] == ["WH1-BLUE-B", "WH3-RED"]


def test_empty_input():
    result = parse_whats_left("")
    assert result["summary"]["totalGroups"] == 0
    assert result["summary"]["percentComplete"] == 0.0
