import json
import os
import socket
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _free_udp_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


PORT = _free_udp_port()
os.environ["ACARS_UDP_PORT"] = str(PORT)
os.environ.pop("AIRFRAMES_API_KEY", None)
os.environ["TRANSCRIBER"] = "none"

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

TRAFFIC = [
    {"hex": "a323b8", "flight": "AAL1779 ", "r": "N123AA", "t": "A321", "lat": 38.1, "lon": -84.9,
     "alt_baro": 35000, "gs": 450, "track": 180, "squawk": "1234"},
    {"hex": "abcdef", "flight": "JBU88", "lat": 38.3, "lon": -84.5, "alt_baro": "ground", "gs": 3, "track": 90},
    {"hex": "nolat1", "flight": "DAL1"},
]
CREW = "FA1 REPORTS PAX IN SEAT 9D IS VERY UNWELL AND NEEDS MEDICAL ASSISTANCE ON ARRIVAL"


@pytest.fixture()
def client(monkeypatch):
    async def fake_adsb(kind, **params):
        return "test", TRAFFIC
    monkeypatch.setattr(server, "_adsb", fake_adsb)
    server._cache.clear()
    with TestClient(server.app) as c:
        yield c


def send_udp(obj):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(json.dumps(obj).encode(), ("127.0.0.1", PORT))
    s.close()


def wait_for(fn, timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.05)
    return fn()


def test_receiver_message_reaches_feed_and_traffic(client):
    assert client.get("/api/status").json()["airframes"]["status"] == "disabled"
    send_udp({"timestamp": time.time(), "tail": ".N123AA", "flight": "AA1779", "label": "H1", "text": CREW})
    send_udp({"vdl2": {"t": {"sec": time.time()}, "avlc": {"src": {"addr": "A323B8", "type": "Aircraft"},
              "acars": {"label": "Q0", "msg_text": "POSN N40123W073456,ROBUC,153012"}}}})
    feed = wait_for(lambda: client.get("/api/messages").json())
    assert [m["text"] for m in feed] == [CREW]
    assert feed[0]["source"] == "receiver" and feed[0]["callsign"] == "AAL1779"
    assert wait_for(lambda: len(client.get("/api/messages?all=true").json()) == 2)

    planes = client.get("/api/traffic?lat=38.2&lon=-84.9&dist=60").json()["aircraft"]
    assert [p["hex"] for p in planes] == ["a323b8", "abcdef"]  # no-position rows dropped
    aal = planes[0]
    assert aal["callsign"] == "AAL1779" and aal["msgs"] == 2 and aal["lastMsg"]["label"] == "Q0"
    assert aal["crew"] == 1  # the position report doesn't count as crew
    assert planes[1]["msgs"] == 0

    msgs = client.get("/api/messages/aircraft?hex=a323b8&reg=N123AA&callsign=AAL1779").json()
    assert len(msgs) == 2 and msgs[0]["t"] <= msgs[1]["t"]


def test_bad_datagram_is_ignored(client):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(b"not json at all", ("127.0.0.1", PORT))
    s.close()
    send_udp({"tail": ".N9", "text": "SECOND MESSAGE AFTER GARBAGE STILL ARRIVES FINE OKAY"})
    assert wait_for(lambda: any(m["reg"] == "N9" for m in client.get("/api/messages?all=true").json()))


def test_search_and_static(client):
    assert client.get("/api/search?q=AA1779").json()["aircraft"][0]["hex"] == "a323b8"
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/vendor/leaflet/leaflet.js").status_code == 200
    assert client.get("/api/feeds").json() == []  # no LiveATC presets; add your own streams
    assert client.get("/data/airports.json").json()["airports"]  # used by the page's airport finder


def test_upstream_failure_is_502(monkeypatch):
    async def down(kind, **params):
        raise server.HTTPException(502, "ADS-B sources unreachable")
    monkeypatch.setattr(server, "_adsb", down)
    server._cache.clear()
    with TestClient(server.app) as c:
        assert c.get("/api/traffic?lat=1&lon=1").status_code == 502



def test_settings_ignore_stray_whitespace(monkeypatch):
    # Windows: `set AIRFRAMES_API_KEY=abc && python ...` stores "abc "
    monkeypatch.setenv("AIRFRAMES_API_KEY", "af_abc123 ")
    monkeypatch.setenv("HEADLINES", " claude\t")
    monkeypatch.setenv("EMPTY_SETTING", "   ")
    assert server.sources.env("AIRFRAMES_API_KEY") == "af_abc123"
    assert server.sources.env("HEADLINES") == "claude"
    assert server.sources.env("EMPTY_SETTING", "fallback") == "fallback"
    assert server.sources.env("NOT_SET_AT_ALL") is None
