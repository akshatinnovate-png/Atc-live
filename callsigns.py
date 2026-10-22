"""Pull aircraft callsigns out of transcribed ATC speech.

Pilots and controllers say callsigns as "<telephony> <digits>", e.g.
"Delta twenty-one forty-five" or "Speedbird one seven niner". ADS-B feeds
broadcast the ICAO form ("DAL2145", "BAW179"). This module bridges the two
so a transcript line can be linked to a plane on the radar.
"""

import re

# Spoken airline telephony -> ICAO 3-letter designator. Longest phrases are
# matched first, so "air india express" wins over "air india".
TELEPHONY = {
    "american": "AAL", "delta": "DAL", "united": "UAL", "southwest": "SWA",
    "jetblue": "JBU", "jet blue": "JBU", "alaska": "ASA", "spirit": "NKS",
    "frontier": "FFT", "flagship": "EDV", "endeavor": "EDV", "skywest": "SKW",
    "envoy": "ENY", "republic": "RPA", "brickyard": "RPA", "piedmont": "PDT",
    "air shuttle": "JIA", "blue streak": "JIA", "hawaiian": "HAL",
    "sun country": "SCX", "allegiant": "AAY", "breeze": "MXY", "moxy": "MXY",
    "fedex": "FDX", "fed ex": "FDX", "ups": "UPS", "atlas": "GTI",
    "air canada": "ACA", "jazz": "JZA", "westjet": "WJA", "west jet": "WJA",
    "speedbird": "BAW", "shamrock": "EIN", "lufthansa": "DLH",
    "air france": "AFR", "airfrans": "AFR", "klm": "KLM", "swiss": "SWR",
    "iberia": "IBE", "virgin": "VIR", "easy": "EZY", "ryanair": "RYR",
    "emirates": "UAE", "qatari": "QTR", "etihad": "ETD", "turkish": "THY",
    "air india": "AIC", "air india express": "AXB", "express india": "AXB",
    "indigo": "IGO", "ifly": "IGO", "vistara": "VTI", "akasa air": "AKJ",
    "spicejet": "SEJ", "singapore": "SIA", "cathay": "CPA", "qantas": "QFA",
    "japan air": "JAL", "all nippon": "ANA", "korean air": "KAL",
    "asiana": "AAR", "china eastern": "CES", "air china": "CCA",
    "china southern": "CSN", "aeromexico": "AMX", "volaris": "VOI",
    "copa": "CMP", "avianca": "AVA", "latam": "LAN",
}

ONES = {
    "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "tree": 3, "four": 4,
    "fower": 4, "five": 5, "fife": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "niner": 9,
}
TEENS = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19,
}
TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
NUMBER_WORDS = set(ONES) | set(TEENS) | set(TENS) | {"hundred"}

_TELEPHONY_RE = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in sorted(TELEPHONY, key=len, reverse=True)) + r")\b"
)


def _tokens(text):
    text = text.lower().replace("-", " ")
    return re.findall(r"[a-z]+|\d+", text)


def _spoken_digits(tokens):
    """Read a flight number from the start of `tokens`.

    Handles digit strings ("2145"), digit-by-digit speech ("two one four
    five"), paired speech ("twenty-one forty-five") and "hundred"
    ("four hundred"). Returns (digits, tokens_consumed).
    """
    out, i = "", 0
    while i < len(tokens) and len(out) < 4:
        t = tokens[i]
        if t.isdigit():
            out += t
        elif t in ONES:
            out += str(ONES[t])
        elif t in TEENS:
            out += str(TEENS[t])
        elif t in TENS:
            nxt = tokens[i + 1] if i + 1 < len(tokens) else None
            if nxt in ONES and ONES[nxt] > 0:
                out += str(TENS[t] + ONES[nxt])
                i += 1
            else:
                out += str(TENS[t])
        elif t == "hundred" and out:
            out += "00"
        else:
            break
        i += 1
    return out[:4], i


def extract_callsigns(text):
    """Return ICAO-style callsigns ("DAL2145") mentioned in `text`, in order."""
    found = []
    lowered = " ".join(_tokens(text))
    for m in _TELEPHONY_RE.finditer(lowered):
        rest = lowered[m.end():].split()
        digits, _ = _spoken_digits(rest)
        if digits and not digits.startswith("0"):
            cs = TELEPHONY[m.group(1)] + digits
            if cs not in found:
                found.append(cs)
    return found


def guess_speaker(text):
    """Guess who keyed the mic: "ATC", "PILOT" or None.

    Radio convention: a controller opens with the callsign they are calling
    ("Delta 123, cleared for takeoff"), while a pilot reading back closes
    with their own ("cleared for takeoff, Delta 123").
    """
    tokens = _tokens(text)
    lowered = " ".join(tokens)
    for m in _TELEPHONY_RE.finditer(lowered):
        start = len(lowered[: m.start()].split())
        after = lowered[m.end():].split()
        digits, used = _spoken_digits(after)
        if not digits:
            continue
        end = start + len(m.group(1).split()) + used
        trailing = len(tokens) - end
        if start == 0 and trailing > 0:
            return "ATC"
        if start > 0 and trailing <= 1:  # allow a trailing "heavy"/"roger"
            return "PILOT"
    return None
