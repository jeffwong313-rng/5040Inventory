from server.parsers.csv_utils import cell, find_header_row, parse_csv, row_is_blank


def test_parse_csv_handles_embedded_newlines_in_quotes():
    text = 'a,"line one\nline two",c\n'
    rows = parse_csv(text)
    assert rows == [["a", "line one\nline two", "c"]]


def test_parse_csv_trims_whitespace():
    text = " a , b ,c\n"
    rows = parse_csv(text)
    assert rows == [["a", "b", "c"]]


def test_parse_csv_empty_text_returns_empty_list():
    assert parse_csv("") == []
    assert parse_csv(None) == []


def test_cell_out_of_range_returns_empty_string():
    assert cell(["a", "b"], 5) == ""
    assert cell(["a", "b"], -1) == ""
    assert cell(["a", "b"], 1) == "b"


def test_row_is_blank():
    assert row_is_blank(["", "", ""]) is True
    assert row_is_blank(["", "x", ""]) is False
    assert row_is_blank([]) is True


def test_find_header_row_case_insensitive():
    rows = [["a", "b"], ["Bin Name", "Area"], ["x", "y"]]
    assert find_header_row(rows, "bin name") == 1


def test_find_header_row_not_found():
    rows = [["a", "b"]]
    assert find_header_row(rows, "bin name") == -1
