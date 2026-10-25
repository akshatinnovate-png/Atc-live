import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from acars import MessageStore, acars_flight_to_callsign, fallback_headline, is_crew_text, normalize  # noqa: E402

CREW = "FA1 REPORTS PAX IN SEAT 9D IS VERY UNWELL AND NEEDS MEDICAL ASSISTANCE ON ARRIVAL PLEASE ADVISE"
POSITION = "POSN N40123W073456,ROBUC,153012,350,LINND,154512,BOS,M47,24512,186"


def test_flight_to_callsign():
    assert acars_flight_to_callsign("AA1779") == "AAL1779"
    assert acars_flight_to_callsign("AA01779") == "AAL1779"
    assert acars_flight_to_callsign("6E0123") == "IGO123"
    assert acars_flight_to_callsign("XX123") == "XX123"
    assert acars_flight_to_callsign("XQ0642") == "XQ642"
    # seen live: Delta sends ACARS as NW, Icelandair as FI
    assert acars_flight_to_callsign("NW0230") == "DAL230"
    assert acars_flight_to_callsign("FI0642") == "ICE642"


def test_acarsdec_format():
    m = normalize({"timestamp": 1700000000.5, "freq": 131.55, "label": "H1", "tail": ".N123AA",
                   "flight": "AA1779", "text": CREW, "icao": 10691512})
    assert m["reg"] == "N123AA" and m["callsign"] == "AAL1779" and m["hex"] == "a323b8"
    assert m["t"] == 1700000000.5 and m["interesting"] and m["headline"]


def test_dumpvdl2_format():
    raw = {"vdl2": {"freq": 136975000, "t": {"sec": 1700000100, "usec": 0},
                    "avlc": {"src": {"addr": "A1B2C3", "type": "Aircraft"},
                             "acars": {"reg": ".N456UA", "flight": "UA0090", "label": "H1", "msg_text": CREW}}}}
    m = normalize(raw)
    assert (m["hex"], m["reg"], m["callsign"], m["t"]) == ("a1b2c3", "N456UA", "UAL90", 1700000100)


def test_dumphfdl_format():
    raw = {"hfdl": {"t": {"sec": 1700000200}, "freq": 8927000,
                    "lpdu": {"src": {"ac_info": {"icao": "4CA1B2"}},
                             "hfnpdu": {"acars": {"reg": "EI-ABC", "flight": "FR27QJ", "label": "5Z", "msg_text": CREW}}}}}
    m = normalize(raw)
    assert (m["hex"], m["reg"], m["callsign"]) == ("4ca1b2", "EI-ABC", "RYR27QJ")


def test_airframes_format():
    raw = {"id": 987654, "timestamp": "2026-10-21T14:00:00.000Z", "tail": "N123AA", "flightNumber": "AA1779",
           "label": "H1", "text": CREW, "airframe": {"icao": "A323B8", "tail": "N123AA"}}
    m = normalize(raw, source="airframes")
    assert m["id"] == "987654" and m["hex"] == "a323b8" and m["source"] == "airframes"
    assert m["t"] == 1792591200.0


def test_empty_text_is_dropped():
    assert normalize({"tail": ".N1", "label": "_d", "text": ""}) is None


def test_crew_text_vs_automated():
    assert is_crew_text(CREW)
    assert not is_crew_text(POSITION)
    assert not is_crew_text("KJFK 211951Z 31012KT 10SM FEW250 18/03 A3012")
    assert not is_crew_text(CREW, label="Q0")


def test_fallback_headline_skips_routing_codes():
    assert fallback_headline("OS KMIA /FTM FA1 REPORTS THAT PAX IN SEAT 9DEF HAS TAKEN OFF") == "Pax in seat has taken off"
    assert fallback_headline("CABIN CREW FOUND PAX WITH COCAINE ONBOARD") == "Cabin crew found pax with cocaine"


def test_store_matching_and_dedup():
    s = MessageStore()
    a = normalize({"tail": ".N123AA", "flight": "AA1779", "text": CREW, "timestamp": 1})
    b = normalize({"icao": "a323b8", "text": POSITION, "timestamp": 2})
    assert s.add(a) and s.add(b) and not s.add(dict(a))
    assert [m["t"] for m in s.for_aircraft(hex_="a323b8", reg="N123AA")] == [1, 2]
    assert len(s.for_aircraft(callsign="AAL1779")) == 1
    idx = s.index()
    assert idx[("reg", "N123AA")] == [a] and idx[("hex", "a323b8")] == [b]
    assert [m["text"] for m in s.feed()] == [CREW]
    assert len(s.feed(interesting_only=False)) == 2
    assert s.feed(q="N123") and not s.feed(q="ZZZ")


def test_feed_is_newest_first_even_if_received_out_of_order():
    s = MessageStore()
    s.add(normalize({"tail": ".N1", "text": CREW, "timestamp": 100}))
    s.add(normalize({"tail": ".N2", "text": CREW, "timestamp": 50}))
    s.add(normalize({"tail": ".N3", "text": CREW, "timestamp": 200}))
    assert [m["reg"] for m in s.feed()] == ["N3", "N1", "N2"]


def test_fallback_headline_does_not_end_on_a_connector():
    assert fallback_headline("NEED WHEELCHAIR AT GATE FOR TWO PAX") == "Need wheelchair at gate for two"
    assert fallback_headline("PLEASE CALL CREW SCHEDULING ABOUT") == "Call crew scheduling"


# Real messages seen on airframes.io; none of these were typed by a crew.
REAL_AUTOMATED = [
    # JIA5317 (CRJ-900) maintenance computer report: wordy but machine-made
    "PAGE 00001 MDC REPORT: SYSTEM PARAMETERS FILENAME: N619NN8.SP TIME: 01:55 DATE: 25Oct2026 MDC APPLICATION "
    "PN: 832-6207-426 MDC TABLES PN: 810-0042-115 L FLAP BPSU POS-SFEC1 70.61 DEG L FLAP BPSU POS-SFEC2 70.73 DEG "
    "L OB L/E TEMP 15.3 C L OB WHEEL SPEED 0.0 KTS APU TOT HOURS HISTORY 9855.5 HRS APU CYCLES HISTORY 17052 CYC "
    "LA FADEC CHAN IN-CNTR 0 T=1 LOB SLAT DIS PROX SFEC1 FAR",
    # UAL64 brake data
    "CTIVITY; 20 +0.1;; 21 +0.1;ENGAGED;; 22 ;25;OCT;26;01:54:06 RPT13;PG2;REAL;SW030M4GV09 1 2 3 243.1;-1.57;5055;"
    "248.8;-2.26 4 249.6;-1.55;4953;249.4;-2.26 5 243.8;-1.57;5017;241.0;+0.03;BRK 6",
    # ASA34 flight plan / fault log
    "#T1BRTE 1 25OCT26 0149 N712AL ASA34 KSEA/KJFK BCG59-U000-08E7 BCG3A-0MFC-0015 L 2101 24OCT26 FDE 34230132 I 0147 25OCT26",
    # CMP366 position report
    "POSN40039W074128,GREIN,014817,368,MYRCA,015106,JFK,M48,327024,1232ECF",
    # AFR033 encrypted
    "T.0&HDeF/k.E`<E<'Szm@ukK|",
]
REAL_CREW = [
    "FA1 REPORTS PAX IN SEAT 9D IS VERY UNWELL AND NEEDS MEDICAL ASSISTANCE ON ARRIVAL PLEASE ADVISE",
    "CABIN CREW FOUND PAX WITH COCAINE ONBOARD PLEASE ARRANGE POLICE IN IBZ",
    "PLS ADVISE GATE FOR ARRIVAL KMIA AND CONNECTING PAX COUNT THANKS",
    "NEED 2 WHEELCHAIRS AT GATE B12 AND ONE UNACCOMPANIED MINOR ESCORT PLEASE",
    "DELAYED 25 MIN DUE TO LATE CATERING TRUCK WILL ADVISE NEW ETD",
]


def test_real_automated_reports_are_not_crew_messages():
    for text in REAL_AUTOMATED:
        assert not is_crew_text(text), text[:40]


def test_real_crew_messages_still_detected():
    for text in REAL_CREW:
        assert is_crew_text(text), text[:40]
