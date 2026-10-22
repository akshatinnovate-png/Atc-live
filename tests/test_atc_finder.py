import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import atc_finder as f  # noqa: E402

PAGE = (Path(__file__).parent / "fixtures" / "liveatc_search_kjfk.html").read_text()


def test_parse_search_page():
    feeds = f.parse_liveatc_search(PAGE)
    assert [x["mount"] for x in feeds] == ["kjfk9_s", "kjfk_app_final", "kjfk_dep", "zny_34"]
    assert feeds[0] == {"mount": "kjfk9_s", "name": "KJFK Ground/Tower", "status": "up", "freqs": ["119.100", "121.900"]}
    assert feeds[1]["status"] == "down" and feeds[1]["freqs"] == ["132.400"]
    assert feeds[3]["name"] == "ZNY New York Center (Sector 34)"


def test_parse_empty_page():
    assert f.parse_liveatc_search("<html>No results</html>") == []


def test_parse_pls():
    assert f.parse_pls("[playlist]\nNumberOfEntries=1\nFile1=http://d.liveatc.net/kjfk9_s\nTitle1=KJFK\n") == "http://d.liveatc.net/kjfk9_s"
    assert f.parse_pls("garbage") is None


def test_nearest_airports_worldwide():
    assert f.nearest_airports(40.64, -73.78)[0]["icao"] == "KJFK"
    assert f.nearest_airports(19.09, 72.87)[0]["icao"] == "VABB"   # Mumbai
    assert f.nearest_airports(51.47, -0.46)[0]["icao"] == "EGLL"   # Heathrow
    assert f.nearest_airports(0.0, -30.0) == []                     # mid-Atlantic


def test_flight_phase():
    assert f.flight_phase("ground", 10, 0.5) == "ground"
    assert f.flight_phase(1500, 150, 4) == "tower"
    assert f.flight_phase(9000, 280, 30) == "terminal"
    assert f.flight_phase(36000, 460, 30) == "enroute"
    assert f.flight_phase(5300, 30, 1, airport_elev_ft=5280) == "ground"  # Denver-style high field


def _ranked(phase):
    apt = {"icao": "KJFK", "name": "JFK", "city": "New York", "dist_nm": 3.0, "lat": 40.6, "lon": -73.8}
    return [x["mount"] for x in f.choose([(apt, f.parse_liveatc_search(PAGE))], phase)]


def test_choose_by_phase_and_skip_down_feeds():
    assert _ranked("ground")[0] == "kjfk9_s"
    assert _ranked("tower")[0] == "kjfk9_s"
    assert _ranked("terminal")[0] == "kjfk_dep"
    assert _ranked("enroute")[0] == "zny_34"
    assert "kjfk_app_final" not in _ranked("terminal")   # DOWN feeds are never offered


def test_closer_airport_wins_tie():
    near = {"icao": "KLGA", "name": "", "city": "", "dist_nm": 5.0, "lat": 0, "lon": 0}
    far = {"icao": "KEWR", "name": "", "city": "", "dist_nm": 40.0, "lat": 0, "lon": 0}
    feed = lambda m: [{"mount": m, "name": m.upper() + " Tower", "status": "up", "freqs": []}]  # noqa: E731
    assert f.choose([(far, feed("kewr")), (near, feed("klga"))], "tower")[0]["mount"] == "klga"
