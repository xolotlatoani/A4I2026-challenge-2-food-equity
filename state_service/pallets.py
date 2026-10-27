"""How many pallets a posting is, read from its own words.

Postings say "10 crates", "about 60 gallons" or "half a truckload", never pallets, but the matcher
(sql/03_filter_and_rank.sql) weighs every load in pallets, and so does the offer bookkeeping:
shares in a split, what is unclaimed, when a request is fulfilled. So the figure is read once,
when a posting is saved, and kept; reading it again at every match could give a different number
than the shares already offered against it.

One reader for every caller: the service uses it when a request arrives without a figure, and the
agent (agent/tools.py) uses it for postings it matches without saving. Plain Python with no
imports from the service, so both can load it.

The table is on sql/03's scale (10 produce crates ~ 0.18 pallet) and reproduces the equity audit's
estimates for the eight seed postings that state a quantity. Add a unit here, not elsewhere.
"""

from __future__ import annotations

import re
from typing import NamedTuple

# How many of each unit fill one pallet.
PER_PALLET = {
    "crate": 55, "box": 55, "tray": 55,   # produce crates and their kin
    "case": 96,                           # shelf-stable cases, smaller than crates
    "gallon": 120,
    "loaf": 200,
    "lb": 2000,                           # so a ton is a pallet
    "ton": 1,
    "bin": 1,                             # a bulk bin takes a pallet's footprint
    "pallet": 1,
    "truckload": 1 / 24,                  # a full trailer holds about 24
}

# A posting that names no quantity ("prepared sandwiches from the deli case"): a small retail lot,
# what sql/03 lets any pantry take through the door.
GUESS = 0.25

_UNITS = {
    "crate": "crate", "crates": "crate", "box": "box", "boxes": "box", "tray": "tray",
    "trays": "tray", "case": "case", "cases": "case", "gallon": "gallon", "gallons": "gallon",
    "gal": "gallon", "loaf": "loaf", "loaves": "loaf", "lb": "lb", "lbs": "lb", "pound": "lb",
    "pounds": "lb", "ton": "ton", "tons": "ton", "bin": "bin", "bins": "bin", "pallet": "pallet",
    "pallets": "pallet", "truckload": "truckload", "truckloads": "truckload",
}
_WORDS = {"half": 0.5, "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
          "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "dozen": 12}
_QUANTITY = re.compile(
    r"(?:\b(?P<n>\d[\d,]*(?:\.\d+)?|" + "|".join(_WORDS) + r")\s+)?(?:of\s+)?(?:an?\s+)?"
    r"(?P<unit>" + "|".join(sorted(_UNITS, key=len, reverse=True)) + r")\b")


class PalletEstimate(NamedTuple):
    pallets: float
    source: str                  # 'read' from the words, or 'guessed' when they name no quantity
    basis: str                   # how, in words, for the coordinator
    quantity_text: str | None    # the words it read, e.g. "10 crates"
    count: float | None          # their number, e.g. 10
    unit: str | None             # e.g. "crate"


def estimate_pallets(*texts: str | None) -> PalletEstimate:
    """Pallets from the first text that names a quantity: a grocer's quantity field, then the
    posting itself. "10 crates" is a quantity; "the deli case" is not, so a unit only counts with
    a number in front of it, except a bare "pallet" or "truckload", which means one."""
    for text in texts:
        bare = None
        for m in _QUANTITY.finditer((text or "").lower()):
            unit = _UNITS[m.group("unit")]
            if m.group("n") is None:
                if unit in ("pallet", "truckload") and bare is None:
                    bare = (m, 1.0, unit)
                continue
            n = m.group("n")
            count = _WORDS.get(n) or float(n.replace(",", ""))
            return _estimate(m, count, unit)
        if bare:
            return _estimate(*bare)
    return PalletEstimate(GUESS, "guessed",
                          f"no quantity in the posting, so guessed {GUESS:g} (a small retail lot)",
                          None, None, None)


def _estimate(m: re.Match, count: float, unit: str) -> PalletEstimate:
    pallets = max(0.01, round(count / PER_PALLET[unit], 2))
    words = m.group(0).strip()
    per = PER_PALLET[unit]
    rate = f"{per:g} to a pallet" if per >= 1 else f"{1 / per:g} pallets to a {unit}"
    return PalletEstimate(pallets, "read", f"read '{words}' at {rate}", words, count, unit)
