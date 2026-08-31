from server.parsers.count_teams import parse_count_teams


def test_finds_all_three_phases(count_teams_csv):
    phases = parse_count_teams(count_teams_csv)
    titles = [p.title for p in phases]
    assert titles == ["For PreCounts", "For First Count", "For Variance 1"]


def test_precounts_maps_members_and_section(count_teams_csv):
    phases = parse_count_teams(count_teams_csv)
    precounts = phases[0]
    team1 = next(t for t in precounts.teams if t.team_id == "Team1")
    assert team1.members == ["Alice Adams", "Bob Baker"]
    assert team1.section == "WH2, then float for whoever needs help"


def test_first_count_maps_zone_and_zones_left(count_teams_csv):
    phases = parse_count_teams(count_teams_csv)
    first_count = phases[1]
    team1 = next(t for t in first_count.teams if t.team_id == "Team1")
    assert team1.zone == "WH1-YELLOW, WH1-RED-A"
    assert team1.zones_left == "WH1-BLUE-C"
    assert team1.count_team == "Team 3"


def test_skips_stray_annotation_row_before_header(count_teams_csv):
    # "For Variance 1" is followed by a row whose only content is a lone
    # "YARD" note in a far column, before the real header row -- it must
    # not get mistaken for the header.
    phases = parse_count_teams(count_teams_csv)
    variance = phases[2]
    assert "member1" not in [c.lower() for c in variance.columns]
    team1 = next(t for t in variance.teams if t.team_id == "Team1")
    assert team1.members == ["Alice Adams", "Bob Baker"]


def test_skips_instructional_row_before_header(count_teams_csv):
    phases = parse_count_teams(count_teams_csv)
    first_count = phases[1]
    assert "Zone" in first_count.columns


def test_unknown_input_returns_no_phases():
    assert parse_count_teams("a,b,c\n1,2,3\n") == []
