from server.parsers.timeline import parse_timeline


def test_parses_date(timeline_csv):
    tl = parse_timeline(timeline_csv)
    assert tl.date == "Friday, September 18, 2026"


def test_skips_fully_blank_rows(timeline_csv):
    tl = parse_timeline(timeline_csv)
    # the fixture has two fully-blank rows that must not become entries
    assert all(e.time or e.event or e.notes for e in tl.entries)


def test_keeps_rows_with_only_a_time(timeline_csv):
    tl = parse_timeline(timeline_csv)
    times = [e.time for e in tl.entries]
    assert "1:00 PM" in times


def test_preserves_sheet_order(timeline_csv):
    tl = parse_timeline(timeline_csv)
    times = [e.time for e in tl.entries]
    assert times == [
        "10:00 AM",
        "12:00 PM",
        "1:00 PM",
        "3:30 PM",
        "9:00 PM",
    ]


def test_multiline_notes_preserved(timeline_csv):
    tl = parse_timeline(timeline_csv)
    first = tl.entries[0]
    assert "Drivers back from short routes" in first.notes
    assert "Everyone starts and finishes precounts" in first.notes


def test_empty_input_returns_empty_timeline():
    tl = parse_timeline("")
    assert tl.date is None
    assert tl.entries == []
