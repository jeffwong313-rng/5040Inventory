"""Small shared helpers for turning raw Google Sheets CSV export text into
a clean grid of strings, used by every tab parser.
"""
from __future__ import annotations

import csv
import io
from typing import List


def parse_csv(text: str) -> List[List[str]]:
    """Parse CSV text into a grid of trimmed strings.

    Google's CSV export uses standard RFC4180 quoting, including embedded
    newlines inside quoted cells (e.g. multi-line notes), so we hand the
    whole text to csv.reader rather than splitting on "\\n" ourselves.
    """
    if text is None:
        return []
    reader = csv.reader(io.StringIO(text))
    rows = [[cell.strip() for cell in row] for row in reader]
    return rows


def cell(row: List[str], index: int) -> str:
    """Safe indexed access into a CSV row -> "" if the row is short."""
    if 0 <= index < len(row):
        return row[index]
    return ""


def row_is_blank(row: List[str]) -> bool:
    return all(c == "" for c in row)


def find_header_row(rows: List[List[str]], must_contain: str) -> int:
    """Return the index of the first row containing `must_contain`
    (case-insensitive, substring match) in any cell, or -1 if not found.
    """
    needle = must_contain.lower()
    for i, row in enumerate(rows):
        for c in row:
            if needle in c.lower():
                return i
    return -1
