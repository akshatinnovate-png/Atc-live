"""Find the live ATC frequency a given aircraft is most likely talking on.

1. Nearest airports to the aircraft (OurAirports data, bundled).
2. The LiveATC feeds listed for each of those airports (scraped from the
   liveatc.net search page, cached).
3. The best feed for the aircraft's phase of flight: Ground/Clearance when
   taxiing, Tower near the runway, Approach/Departure in the terminal area,
   Center en route.

Coverage is whatever volunteers stream: dense in the US, Canada, much of
Europe, Australia and Brazil, thin elsewhere. When nothing is in range we
say so instead of guessing.
"""

import html
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).parent
_DATA = json.loads((ROOT / "data" / "airports.json").read_text())
AIRPORTS = [dict(zip(_DATA["fields"], row)) for row in _DATA["airports"]]
BY_ICAO = {a["icao"]: a for a in AIRPORTS}

MOUNT_RE = re.compile(r"^[a-z0-9_]{2,40}$")

# phase -> words that mark a feed as covering it, best first
PHASE_WORDS = {
    "ground": ["gnd", "ground", "del", "delivery", "clnc", "clearance", "ramp", "twr", "tower"],
    "tower": ["twr", "tower", "local", "gnd", "ground"],
    "terminal": ["app", "approach", "dep", "departure", "tracon", "radar", "final", "director", "arr", "arrival", "terminal"],
    "enroute": ["ctr", "center", "centre", "artcc", "control", "area", "acc", "radar", "oceanic"],
}


def distance_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(a))


def nearest_airports(lat, lon, limit=8, max_nm=200):
    # cheap box filter before the exact distance
    box = max_nm / 60 + 1
    near = []
    for a in AIRPORTS:
        if abs(a["lat"] - lat) > box:
            continue
        d = distance_nm(lat, lon, a["lat"], a["lon"])
        if d <= max_nm:
            near.append((d, a))
    near.sort(key=lambda x: (x[0] - (8 if x[1]["large"] else 0)))
    return [dict(a, dist_nm=round(d, 1)) for d, a in near[:limit]]


def flight_phase(alt, gs, dist_to_airport_nm, airport_elev_ft=0):
    """'ground' | 'tower' | 'terminal' | 'enroute' from ADS-B altitude and speed."""
    if alt == "ground" or (isinstance(alt, (int, float)) and alt - airport_elev_ft < 300 and (gs or 0) < 60):
        return "ground"
    if not isinstance(alt, (int, float)):
        return "terminal"
    agl = alt - airport_elev_ft
    if agl < 3000 and dist_to_airport_nm < 10:
        return "tower"
    if alt < 18000 and dist_to_airport_nm < 60:
        return "terminal"
    return "enroute"


def _text(fragment):
    return html.unescape(re.sub(r"<[^>]+>", " ", fragment)).strip()


def parse_liveatc_search(page):
    """Feeds on a liveatc.net/search/?icao=XXXX page: [{mount, name, status, freqs}].

    Written to survive layout changes: every feed has a player link with
    `mount=<id>` or `/play/<id>.pls`. Its title is the closest bold text
    before the link, and its status (UP/DOWN) and frequencies sit between
    it and the next feed.
    """
    links = [(m.start(), m.group(1)) for m in re.finditer(r"(?:mount=|/play/)([a-z0-9_]+)(?:\.pls)?", page)]
    first = {}
    for pos, mount in links:
        if MOUNT_RE.match(mount) and mount not in first:
            first[mount] = pos
    ordered = sorted(first.items(), key=lambda kv: kv[1])
    titles = [(m.start(), _text(m.group(1))) for m in re.finditer(r"<strong>(.*?)</strong>", page, re.S | re.I)]
    titles = [(p, t) for p, t in titles if t and t.upper() not in {"UP", "DOWN"} and len(t) < 90]
    feeds = []
    for i, (mount, pos) in enumerate(ordered):
        title_pos, name = max(((p, t) for p, t in titles if p < pos), default=(0, mount))
        end = ordered[i + 1][1] if i + 1 < len(ordered) else len(page)
        nxt_title = min((p for p, _ in titles if p > pos), default=len(page))
        window = page[title_pos:min(end, nxt_title) if nxt_title > pos else end]
        st = re.search(r"\b(UP|DOWN)\b", _text(window))
        freqs = sorted({f for f in re.findall(r"\b(1[1-3]\d\.\d{2,3})\b", _text(window))
                        if 108 <= float(f) < 137})
        feeds.append({"mount": mount, "name": name, "status": st.group(1).lower() if st else "unknown",
                      "freqs": freqs})
    return feeds


def parse_pls(text):
    """First stream URL in a .pls playlist."""
    m = re.search(r"^File\d+=(\S+)", text, re.M | re.I)
    return m.group(1).strip() if m else None


def score_feed(feed, phase, dist_nm):
    """Higher is better; None if the feed is down."""
    if feed["status"] == "down":
        return None
    name = feed["name"].lower()
    words = set(re.findall(r"[a-z]+", name))
    wanted = PHASE_WORDS[phase]
    score = 0.0
    for rank, w in enumerate(wanted):
        if w in words or (len(w) > 4 and w in name):
            score = max(score, 10 - rank * 0.5)
    if not score:
        # combined feeds ("Gnd/Twr/App") still help; other phases a little
        for other, ws in PHASE_WORDS.items():
            if other != phase and any(w in words for w in ws):
                score = 3
                break
    if feed["status"] == "up":
        score += 2
    return score - dist_nm / 25


def choose(feeds_by_airport, phase):
    """Rank every feed of every nearby airport. Returns best-first list."""
    ranked = []
    for apt, feeds in feeds_by_airport:
        for f in feeds:
            s = score_feed(f, phase, apt["dist_nm"])
            if s is not None:
                ranked.append((s, apt, f))
    ranked.sort(key=lambda x: x[0], reverse=True)
    seen, out = set(), []
    for s, apt, f in ranked:
        if f["mount"] in seen:
            continue
        seen.add(f["mount"])
        out.append({"mount": f["mount"], "name": f["name"], "status": f["status"], "freqs": f["freqs"],
                    "airport": apt["icao"], "airport_name": apt["name"], "city": apt["city"],
                    "dist_nm": apt["dist_nm"], "lat": apt["lat"], "lon": apt["lon"], "score": round(s, 2)})
    return out
