"""Small text helpers shared by the scrapers that read Armenian registers and bulletins."""
from __future__ import annotations

import html as htmllib
import re


def html_text(fragment: str | None) -> str:
    """Visible text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed."""
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", fragment or ""))).strip()


def iso_day(value: str | None) -> str | None:
    """A day-first date as the registers print it (19/02/2026, 09-07-2015, 07.10.2025) → 2026-02-19."""
    m = re.search(r"(\d{2})[./-](\d{2})[./-](\d{4})", value or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None
