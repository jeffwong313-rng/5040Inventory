import pytest

from server.parsers.bins import (
    COUNTED,
    IN_PROGRESS,
    NOT_STARTED,
    bin_group,
    group_bins,
    parse_bin_rows,
    parse_bins,
    warehouse_of,
)


@pytest.mark.parametrize(
    "bin_name, expected_group",
    [
        ("WH1-RED-A-4-1", "WH1-RED-A"),
        ("WH1-BLUE-B-2-OS", "WH1-BLUE-B"),
        ("WH1-GREEN-I-4", "WH1-GREEN-I"),
        ("WH1-ORANGE-B-END-2", "WH1-ORANGE-B"),
        ("WH1-RED-I-END", "WH1-RED-I"),
        ("YARD-FENCE-07", "YARD-FENCE"),
        ("YARD-DOCK-12-FLR", "YARD-DOCK"),
        ("YARD-DOCK-FLR-8", "YARD-DOCK"),
        ("WHSE 3", "WHSE 3"),
    ],
)
def test_bin_group_truncation(bin_name, expected_group):
    assert bin_group(bin_name) == expected_group


@pytest.mark.parametrize(
    "name, expected_warehouse",
    [
        ("WH1-RED-A-4-1", "Warehouse 1"),
        ("WH2-ANYTHING", "Warehouse 2"),
        ("YARD-FENCE-01", "Yard"),
        ("WHSE 3", "Other"),
    ],
)
def test_warehouse_of(name, expected_warehouse):
    assert warehouse_of(name) == expected_warehouse


def test_parse_bin_rows_reads_status_columns(all_bins_csv):
    rows = parse_bin_rows(all_bins_csv)
    counted_row = next(r for r in rows if r.bin_name == "WH1-BLUE-A-1-2")
    assert counted_row.status == COUNTED
    assert counted_row.counted_by == "Alice Adams"
    assert counted_row.count_date == "9/18/2026"


def test_parse_bin_rows_flags_excluded(all_bins_csv):
    rows = parse_bin_rows(all_bins_csv)
    deleted = next(r for r in rows if r.bin_name == "WH1-GRAY-OLD-1-2")
    assert deleted.excluded is True
    kept = next(r for r in rows if r.bin_name == "WH1-GRAY-OLD-1-1")
    assert kept.excluded is False


def test_group_counted_if_any_row_counted(all_bins_csv):
    rows = parse_bin_rows(all_bins_csv)
    groups = {g.group: g for g in group_bins(rows)}
    # WH1-BLUE-A-1-1 is blank, WH1-BLUE-A-1-2 is Counted, WH1-BLUE-A-2-OS
    # is blank -- the whole shelf-group should read Counted because the
    # team counts the whole shelf in one pass.
    assert groups["WH1-BLUE-A"].status == COUNTED
    assert groups["WH1-BLUE-A"].bin_count == 3


def test_group_in_progress(all_bins_csv):
    rows = parse_bin_rows(all_bins_csv)
    groups = {g.group: g for g in group_bins(rows)}
    assert groups["WH1-RED-A"].status == IN_PROGRESS


def test_group_not_started_by_default(all_bins_csv):
    rows = parse_bin_rows(all_bins_csv)
    groups = {g.group: g for g in group_bins(rows)}
    assert groups["WH1-RED-B"].status == NOT_STARTED


def test_fully_excluded_group_is_dropped(all_bins_csv):
    rows = parse_bin_rows(all_bins_csv)
    groups = {g.group: g for g in group_bins(rows)}
    assert "WH1-DELETED-BAY" not in groups


def test_partially_excluded_group_survives_with_excluded_count(all_bins_csv):
    rows = parse_bin_rows(all_bins_csv)
    groups = {g.group: g for g in group_bins(rows)}
    assert groups["WH1-GRAY-OLD"].bin_count == 1
    assert groups["WH1-GRAY-OLD"].excluded_count == 1


def test_summary_counts_and_percent(all_bins_csv):
    result = parse_bins(all_bins_csv)
    summary = result["summary"]
    # groups present: WH1-BLUE-A(counted), WH1-RED-A(in_progress),
    # WH1-RED-B(not_started), WH1-GREEN-I(not_started),
    # YARD-FENCE(not_started), WH1-GRAY-OLD(not_started), WHSE 3(not_started)
    assert summary["totalGroups"] == 7
    assert summary["counted"] == 1
    assert summary["inProgress"] == 1
    assert summary["notStarted"] == 5
    assert summary["percentComplete"] == pytest.approx(1 / 7 * 100, abs=0.1)


def test_summary_breaks_down_by_warehouse(all_bins_csv):
    result = parse_bins(all_bins_csv)
    by_wh = {w["warehouse"]: w for w in result["summary"]["byWarehouse"]}
    assert by_wh["Yard"]["total"] == 1
    assert by_wh["Warehouse 1"]["counted"] == 1


def test_summary_remaining_groups_excludes_counted(all_bins_csv):
    result = parse_bins(all_bins_csv)
    remaining_names = {g["group"] for g in result["summary"]["remainingGroups"]}
    assert "WH1-BLUE-A" not in remaining_names
    assert "WH1-RED-A" in remaining_names


def test_empty_input_returns_zeroed_summary():
    result = parse_bins("")
    assert result["summary"]["totalGroups"] == 0
    assert result["groups"] == []
