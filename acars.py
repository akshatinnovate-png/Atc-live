"""ACARS: the text messages aircraft exchange with their airline.

Crews type free-text notes to dispatch ("FA1 REPORTS PAX IN 9D UNWELL"),
and avionics send automated position, weather and engine reports. This
module normalizes messages from the common decoders into one shape, keeps
recent ones in memory and links them to aircraft seen on ADS-B.

Supported inputs:
  * acarsdec JSON (VHF ACARS)         {"tail", "flight", "label", "text", ...}
  * dumpvdl2 JSON (VDL Mode 2)        {"vdl2": {"avlc": {"acars": {...}}}}
  * dumphfdl JSON (HF data link)      {"hfdl": {"lpdu": {"hfnpdu": {"acars": {...}}}}}
  * airframes.io API messages         {"tail", "flightNumber", "text", "airframe": {...}}
"""

import hashlib
import re
import time
from collections import deque

# ACARS flight IDs use the IATA airline code ("AA1779"); ADS-B callsigns use
# ICAO ("AAL1779"). This covers the carriers most often heard on ACARS.
IATA_TO_ICAO = {
    "AA": "AAL", "DL": "DAL", "UA": "UAL", "WN": "SWA", "B6": "JBU", "AS": "ASA",
    "NK": "NKS", "F9": "FFT", "HA": "HAL", "G4": "AAY", "SY": "SCX", "MX": "MXY",
    "9E": "EDV", "OO": "SKW", "MQ": "ENY", "YX": "RPA", "OH": "JIA", "PT": "PDT",
    "FX": "FDX", "5X": "UPS", "5Y": "GTI", "AC": "ACA", "QK": "JZA", "WS": "WJA",
    "BA": "BAW", "EI": "EIN", "LH": "DLH", "AF": "AFR", "KL": "KLM", "LX": "SWR",
    "IB": "IBE", "VS": "VIR", "U2": "EZY", "FR": "RYR", "EK": "UAE", "QR": "QTR",
    "EY": "ETD", "TK": "THY", "AI": "AIC", "IX": "AXB", "6E": "IGO", "UK": "VTI",
    "QP": "AKJ", "SG": "SEJ", "SQ": "SIA", "CX": "CPA", "QF": "QFA", "JL": "JAL",
    "NH": "ANA", "KE": "KAL", "OZ": "AAR", "MU": "CES", "CA": "CCA", "CZ": "CSN",
    "AM": "AMX", "Y4": "VOI", "CM": "CMP", "AV": "AVA", "LA": "LAN", "SK": "SAS",
    "AY": "FIN", "TP": "TAP", "OS": "AUA", "SN": "BEL", "LO": "LOT", "W6": "WZZ",
    # Delta aircraft still send ACARS under Northwest's old code
    "NW": "DAL", "FI": "ICE", "BR": "EVA", "CI": "CAL", "EW": "EWG", "VY": "VLG",
    "A3": "AEE", "LY": "ELY", "MS": "MSR", "SV": "SVA", "ET": "ETH", "KQ": "KQA",
    "PR": "PAL", "GA": "GIA", "MH": "MAS", "TG": "THA", "VN": "HVN", "NZ": "ANZ",
    "VA": "VOZ", "WY": "OMA", "GF": "GFA", "KU": "KAC", "UL": "ALK", "PK": "PIA",
}

# Labels that carry automated or link-management traffic, never crew text.
AUTOMATED_LABELS = {"_d", "Q0", "SQ", "H1_ACK", "5U", "B9", "Q1", "Q2", "QA", "QB",
                    "QC", "QD", "QE", "QF", "QG", "QH", "QK", "QL", "QM", "QN", "QP",
                    "QQ", "QR", "QS", "QT", "QX", "10", "11", "12", "15", "16", "17",
                    "20", "21", "22", "26", "2Z", "44", "4T", "80", "83"}

_WORD = re.compile(r"[A-Z]{2,}")
_VOWEL = re.compile(r"[AEIOUY]")
# Routing prefixes at the start of free text: "OS KMIA /FTM", "FROM DISP", "FA1" ...
_PREFIX = re.compile(r"^(?:(?:[A-Z]{2}\s+)?[A-Z]{4}\s*/[A-Z0-9]{2,4}\s*|/[A-Z0-9.]+\s*|- ?#[A-Z0-9]+\s*)+")


def _strip_dot(reg):
    reg = (reg or "").strip().upper()
    return reg.lstrip(".") or None


def _hex(value):
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return f"{value:06x}"
    value = str(value).strip().lower()
    if value.startswith("0x"):
        value = value[2:]
    return value if re.fullmatch(r"[0-9a-f]{6}", value) else None


def acars_flight_to_callsign(flight):
    """'AA1779' / 'AA01779' -> 'AAL1779'. Unknown airlines pass through."""
    flight = re.sub(r"\s+", "", (flight or "").upper())
    m = re.fullmatch(r"([A-Z0-9]{2})0*(\d{1,4}[A-Z]{0,2})", flight)
    if m and m.group(1) in IATA_TO_ICAO:
        return IATA_TO_ICAO[m.group(1)] + m.group(2)
    if m:  # unknown airline: at least drop the zero padding ("XQ0642" -> "XQ642")
        return m.group(1) + m.group(2)
    return flight or None


def normalize(raw, source="local"):
    """Turn one decoder/API record into a message dict, or None if it has no text."""
    if "vdl2" in raw:
        v = raw["vdl2"]
        avlc = v.get("avlc", {})
        a = avlc.get("acars") or {}
        t = (v.get("t") or {}).get("sec")
        src = avlc.get("src") or {}
        hex_ = _hex(src.get("addr")) if src.get("type", "Aircraft") == "Aircraft" else None
        rec = dict(text=a.get("msg_text"), label=a.get("label"), reg=a.get("reg"),
                   flight=a.get("flight"), hex=hex_, t=t, freq=v.get("freq"))
    elif "hfdl" in raw:
        h = raw["hfdl"]
        lpdu = h.get("lpdu", {})
        a = (lpdu.get("hfnpdu") or {}).get("acars") or {}
        ac = (lpdu.get("src") or {}).get("ac_info") or {}
        rec = dict(text=a.get("msg_text"), label=a.get("label"), reg=a.get("reg"),
                   flight=a.get("flight"), hex=_hex(ac.get("icao")),
                   t=(h.get("t") or {}).get("sec"), freq=h.get("freq"))
    else:
        airframe = raw.get("airframe") or {}
        flight = raw.get("flight") if isinstance(raw.get("flight"), str) else None
        flight_obj = raw.get("flight") if isinstance(raw.get("flight"), dict) else {}
        t = raw.get("timestamp")
        if isinstance(t, str):  # airframes.io uses ISO timestamps
            from datetime import datetime
            try:
                t = datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
            except ValueError:
                t = None
        rec = dict(
            text=raw.get("text") or raw.get("msg_text"),
            label=raw.get("label"),
            reg=raw.get("tail") or airframe.get("tail"),
            flight=flight or raw.get("flightNumber") or flight_obj.get("flight")
                   or flight_obj.get("flightIata"),
            callsign=flight_obj.get("flightIcao"),
            hex=_hex(raw.get("icao") or raw.get("hex") or airframe.get("icao")),
            t=t, freq=raw.get("freq") or raw.get("frequency"),
        )

    text = (rec.get("text") or "").strip()
    if not text:
        return None
    t = float(rec.get("t") or time.time())
    reg = _strip_dot(rec.get("reg"))
    flight = (rec.get("flight") or "").strip().upper() or None
    callsign = (rec.get("callsign") or "").strip().upper() or acars_flight_to_callsign(flight)
    label = (rec.get("label") or "").strip() or None
    uid = raw.get("id") or raw.get("uuid")
    if uid is None:
        uid = hashlib.sha1(f"{reg}|{flight}|{label}|{text}|{int(t)}".encode()).hexdigest()[:16]
    msg = {
        "id": str(uid), "t": t, "hex": rec.get("hex"), "reg": reg, "flight": flight,
        "callsign": callsign, "label": label, "text": text,
        "freq": rec.get("freq"), "source": source,
    }
    msg["interesting"] = is_crew_text(text, label)
    msg["headline"] = fallback_headline(text) if msg["interesting"] else None
    return msg


def is_crew_text(text, label=None):
    """True for human-written messages; False for automated reports.

    Free text reads like words; automated reports are mostly codes and digits
    ("POSN N40123W073456,ROBUC,153012,350"). We look at how much of the
    message is pronounceable words.
    """
    if label in AUTOMATED_LABELS:
        return False
    upper = text.upper()
    tokens = re.findall(r"\S+", upper)
    if len(tokens) < 5:
        return False
    words = [w for w in _WORD.findall(upper) if _VOWEL.search(w) and len(w) >= 3]
    digits = sum(c.isdigit() for c in upper)
    letters = sum(c.isalpha() for c in upper)
    if letters == 0 or digits / (letters + digits) > 0.3:
        return False
    plain_tokens = [tk for tk in tokens if re.fullmatch(r"[A-Z'.,!?:;-]+", tk)]
    return len(words) >= 5 and len(plain_tokens) / len(tokens) >= 0.6


_DANGLING = {"AT", "IN", "ON", "OF", "TO", "FOR", "AND", "OR", "WITH", "IS", "ARE", "HAS", "HAVE",
             "WAS", "BY", "FROM", "THAT", "THE", "AN", "A", "AS", "BE", "BEEN", "NEED", "ABOUT"}


def fallback_headline(text, max_words=6):
    """A short card title from the message itself, used when no AI is set up."""
    body = _PREFIX.sub("", text.upper()).strip()
    body = re.sub(r"^(?:FA\d|FOM|CAPT|FO|CREW|DISP|MX|OPS)\s+(?:SAYS|REPORTS|ADVISES)?\s*(?:THAT\s+)?", "", body)
    tokens = (t.strip(".,:;!?") for t in body.split())
    words = [t for t in tokens if re.fullmatch(r"[A-Z][A-Z']+", t) and t not in {"THE", "AN", "THAT", "PLS", "PLEASE"}]
    words = words[:max_words]
    while words and words[-1] in _DANGLING:  # don't end on "...wheelchair at"
        words.pop()
    if not words:
        return None
    return " ".join(words).capitalize()


class MessageStore:
    """Recent messages in memory, indexed by every way we can match a plane."""

    def __init__(self, maxlen=5000):
        self.messages = deque(maxlen=maxlen)
        self.by_id = {}
        self.listeners = set()

    def add(self, msg):
        if msg is None or msg["id"] in self.by_id:
            return False
        if len(self.messages) == self.messages.maxlen:
            self.by_id.pop(self.messages[0]["id"], None)
        self.messages.append(msg)
        self.by_id[msg["id"]] = msg
        for q in self.listeners:
            q.put_nowait(msg)
        return True

    def update(self, msg_id, **fields):
        msg = self.by_id.get(msg_id)
        if msg:
            msg.update(fields)
            for q in self.listeners:
                q.put_nowait(msg)

    def for_aircraft(self, hex_=None, reg=None, callsign=None):
        hex_ = (hex_ or "").lower() or None
        reg = _strip_dot(reg)
        callsign = (callsign or "").strip().upper() or None
        out = [m for m in self.messages
               if (hex_ and m["hex"] == hex_) or (reg and m["reg"] == reg)
               or (callsign and m["callsign"] == callsign)]
        return sorted(out, key=lambda m: m["t"])

    def index(self):
        """{("hex"|"reg"|"cs", value): [msgs]} for fast matching against ADS-B traffic."""
        idx = {}
        for m in self.messages:
            for key in (("hex", m["hex"]), ("reg", m["reg"]), ("cs", m["callsign"])):
                if key[1]:
                    idx.setdefault(key, []).append(m)
        return idx

    def feed(self, limit=50, q=None, interesting_only=True):
        q = (q or "").strip().upper()
        out = []
        for m in sorted(self.messages, key=lambda m: m["t"], reverse=True):
            if interesting_only and not m["interesting"]:
                continue
            if q and not any(q in (m.get(k) or "") for k in ("callsign", "flight", "reg")):
                continue
            out.append(m)
            if len(out) >= limit:
                break
        return out
