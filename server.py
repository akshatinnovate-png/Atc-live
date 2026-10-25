"""ATC Live: what pilots are saying, on a live map of every aircraft.

Two kinds of real pilot traffic:

* ACARS text messages (acars.py, sources.py): crew <-> airline datalink,
  from your own receiver over UDP and/or the airframes.io network.
* ATC voice radio, from streams listed in feeds.json that you're allowed to
  use (e.g. your own airband receiver). For other planes the page links out
  to LiveATC's own player, whose terms don't allow use in other apps.
    ffmpeg (stream -> 16 kHz PCM) -> Segmenter (one chunk per radio call)
      -> Whisper -> callsign extraction -> Server-Sent Events -> browser
  One worker runs per radio feed, shared by every browser tab, and stops a
  minute after the last listener leaves.

Aircraft positions come from the open adsb.fi / adsb.lol ADS-B APIs, routes
from adsbdb.com and photos from planespotters.net.
"""

import asyncio
import json
import os
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import sources
from acars import MessageStore
from callsigns import extract_callsigns, guess_speaker
from segmenter import SAMPLE_RATE, Segmenter

ROOT = Path(__file__).parent
FEEDS_FILE = Path(sources.env("FEEDS_FILE", ROOT / "feeds.json"))
FEEDS = {f["id"]: f for f in json.loads(FEEDS_FILE.read_text())}
WHISPER_MODEL = sources.env("WHISPER_MODEL", "small.en")
TRANSCRIBER = sources.env("TRANSCRIBER", "whisper")  # "whisper" or "none"
IDLE_STOP_S = 60

# Biases Whisper toward radio phraseology instead of everyday words.
ATC_PROMPT = (
    "Air traffic control radio. Runway two two left, cleared for takeoff. "
    "Contact departure one two five point seven. Climb and maintain five thousand. "
    "Delta twenty-one forty-five, United niner zero, Speedbird one seven niner, "
    "squawk seven two zero zero, wilco, roger, line up and wait, hold short."
)
# Whisper invents these on static and silence.
HALLUCINATIONS = {"you", "thank you", "thanks for watching", "bye", "okay", ""}


class Transcriber:
    def __init__(self):
        self._pool = ThreadPoolExecutor(max_workers=1)  # model isn't thread safe
        self._model = None

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel
            self._model = WhisperModel(WHISPER_MODEL, device="auto", compute_type="int8")
        return self._model

    def _run(self, audio):
        if TRANSCRIBER == "none":
            return f"[transmission {len(audio) / SAMPLE_RATE:.1f}s]"
        segments, _ = self._load().transcribe(
            audio, language="en", beam_size=5, initial_prompt=ATC_PROMPT,
            condition_on_previous_text=False, vad_filter=False,
        )
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6)
        return text.strip()

    async def transcribe(self, audio):
        return await asyncio.get_running_loop().run_in_executor(self._pool, self._run, audio)


transcriber = Transcriber()


class FeedWorker:
    def __init__(self, feed):
        self.feed = feed
        self.listeners = set()
        self.history = deque(maxlen=40)
        self.status = "connecting"
        self.task = None
        self.idle_since = None

    def publish(self, event, data):
        for q in self.listeners:
            q.put_nowait((event, data))

    def set_status(self, status):
        self.status = status
        self.publish("status", {"status": status})

    def ensure_running(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())

    async def _run(self):
        while True:
            if not self.listeners and self.idle_since and time.time() - self.idle_since > IDLE_STOP_S:
                self.set_status("stopped")
                return
            try:
                await self._stream_once()
            except Exception as e:  # keep the worker alive across stream drops
                self.publish("error", {"message": str(e)})
            self.set_status("reconnecting")
            await asyncio.sleep(5)

    async def _stream_once(self):
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-reconnect", "1", "-reconnect_streamed", "1",
            "-i", self.feed["url"], "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        segmenter = Segmenter()
        started = False
        try:
            while True:
                if not self.listeners and self.idle_since and time.time() - self.idle_since > IDLE_STOP_S:
                    return
                try:
                    chunk = await proc.stdout.readexactly(SAMPLE_RATE)  # 0.5 s of int16
                except asyncio.IncompleteReadError:
                    err = (await proc.stderr.read()).decode(errors="replace").strip()
                    raise RuntimeError(err or "stream ended")
                if not started:
                    started = True
                    self.set_status("live")
                pcm = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768
                for audio in segmenter.feed(pcm):
                    await self._handle(audio)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    async def _handle(self, audio):
        heard_at = time.time() - len(audio) / SAMPLE_RATE
        text = await transcriber.transcribe(audio)
        if text.lower().strip(" .!?,") in HALLUCINATIONS:
            return
        msg = {
            "t": heard_at,
            "duration": round(len(audio) / SAMPLE_RATE, 1),
            "text": text,
            "callsigns": extract_callsigns(text),
            "speaker": guess_speaker(text),
        }
        self.history.append(msg)
        self.publish("message", msg)


workers = {}
store = MessageStore()
headliner = sources.Headliner()
ACARS_UDP_PORT = int(sources.env("ACARS_UDP_PORT", "5550"))


def on_acars(msg):
    if store.add(msg) and msg["interesting"] and headliner.enabled:
        asyncio.get_running_loop().create_task(_add_headline(msg))


async def _add_headline(msg):
    result = await headliner.headline(msg["text"])
    if result:
        store.update(msg["id"], interesting=result["interesting"], headline=result["headline"],
                     text=result["redacted_text"] or msg["text"])


airframes = sources.AirframesPoller(on_acars)


@asynccontextmanager
async def lifespan(app):
    transport = None
    if ACARS_UDP_PORT:
        transport = await sources.start_udp_receiver(on_acars, port=ACARS_UDP_PORT)
    poller = asyncio.create_task(airframes.run())
    yield
    poller.cancel()
    if transport:
        transport.close()


app = FastAPI(title="ATC Live", lifespan=lifespan)


@app.get("/api/feeds")
def list_feeds():
    return [{k: v for k, v in f.items() if k != "url"} for f in FEEDS.values()]


def _feed(feed_id):
    if feed_id not in FEEDS:
        raise HTTPException(404, "unknown feed")
    return FEEDS[feed_id]


@app.get("/api/transcripts/{feed_id}")
async def transcripts(feed_id: str):
    feed = _feed(feed_id)
    worker = workers.get(feed_id) or workers.setdefault(feed_id, FeedWorker(feed))
    queue = asyncio.Queue()

    async def events():
        worker.listeners.add(queue)
        worker.idle_since = None
        worker.ensure_running()
        try:
            yield _sse("status", {"status": worker.status})
            for msg in list(worker.history):
                yield _sse("message", msg)
            while True:
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=15)
                    yield _sse(event, data)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            worker.listeners.discard(queue)
            if not worker.listeners:
                worker.idle_since = time.time()

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.get("/api/audio/{feed_id}")
async def audio(feed_id: str):
    """Relay the feed's MP3 so the browser plays it from our own origin."""
    url = _feed(feed_id)["url"]
    client = httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(15, read=None))
    req = client.build_request("GET", url, headers={"User-Agent": "atc-live/1.0"})
    try:
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(502, f"feed unreachable: {e}")
    if resp.status_code != 200:
        await resp.aclose()
        await client.aclose()
        raise HTTPException(502, f"feed returned HTTP {resp.status_code}")

    async def body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(body(), media_type=resp.headers.get("content-type", "audio/mpeg"))


ADSB_SOURCES = [
    ("adsb.fi", "https://opendata.adsb.fi/api/v2"),
    ("adsb.lol", "https://api.adsb.lol/v2"),
]
ADSB_PATHS = {
    "point": {"adsb.fi": "/lat/{lat}/lon/{lon}/dist/{dist}", "adsb.lol": "/point/{lat}/{lon}/{dist}"},
    "callsign": {"adsb.fi": "/callsign/{q}", "adsb.lol": "/callsign/{q}"},
    "reg": {"adsb.fi": "/registration/{q}", "adsb.lol": "/reg/{q}"},
    "hex": {"adsb.fi": "/hex/{q}", "adsb.lol": "/hex/{q}"},
}
_cache = {}


async def _cached(key, ttl, fetch):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = await fetch()
    _cache[key] = (time.time(), value)
    if len(_cache) > 5000:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:1000]:
            del _cache[k]
    return value


async def _adsb(kind, **params):
    """Query the ADS-B aggregators in order, returning (source, aircraft list)."""
    errors = []
    async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "atc-live/1.0"}) as client:
        for name, base in ADSB_SOURCES:
            try:
                r = await client.get(base + ADSB_PATHS[kind][name].format(**params))
                r.raise_for_status()
                body = r.json()
                return name, body.get("aircraft") or body.get("ac") or []
            except (httpx.HTTPError, ValueError) as e:
                errors.append(f"{name}: {e}")
    raise HTTPException(502, "ADS-B sources unreachable: " + "; ".join(errors))


def _plane(a, idx):
    p = {
        "hex": (a.get("hex") or "").lower(),
        "callsign": (a.get("flight") or "").strip().upper(),
        "reg": a.get("r"),
        "type": a.get("t"),
        "desc": a.get("desc"),
        "lat": a["lat"], "lon": a["lon"],
        "alt": a.get("alt_baro"),
        "gs": a.get("gs"),
        "track": a.get("track") if a.get("track") is not None else a.get("true_heading") or 0,
        "squawk": a.get("squawk"),
    }
    matched = {}
    for key in (("hex", p["hex"]), ("reg", (p["reg"] or "").upper()), ("cs", p["callsign"])):
        for m in idx.get(key, ()) if key[1] else ():
            matched[m["id"]] = m
    p["msgs"] = len(matched)
    p["crew"] = sum(1 for m in matched.values() if m["interesting"])
    p["lastMsg"] = max(matched.values(), key=lambda m: m["t"]) if matched else None
    return p


def _planes(rows):
    idx = store.index()
    return [_plane(a, idx) for a in rows if a.get("lat") is not None and a.get("lon") is not None]


@app.get("/api/traffic")
async def traffic(lat: float, lon: float, dist: int = 60):
    """Every aircraft within `dist` NM of a point, with its ACARS message count."""
    dist = max(5, min(dist, 250))
    lat, lon = round(lat, 2), round(lon, 2)
    source, rows = await _cached(("pt", lat, lon, dist), 4, lambda: _adsb("point", lat=lat, lon=lon, dist=dist))
    return {"source": source, "aircraft": _planes(rows)}


@app.get("/api/search")
async def search(q: str):
    """Find an aircraft anywhere by flight number, callsign, registration or hex."""
    q = q.strip().upper().replace(" ", "")
    if not q:
        return {"aircraft": []}
    from acars import acars_flight_to_callsign
    tries = [("callsign", acars_flight_to_callsign(q)), ("callsign", q), ("reg", q)]
    if len(q) == 6 and all(c in "0123456789ABCDEF" for c in q):
        tries.insert(0, ("hex", q.lower()))
    for kind, value in dict.fromkeys(tries):
        try:
            _, rows = await _cached(("s", kind, value), 4, lambda: _adsb(kind, q=value))
        except HTTPException:
            continue
        if rows:
            return {"aircraft": _planes(rows)}
    return {"aircraft": []}


@app.get("/api/route/{callsign}")
async def route(callsign: str):
    """Origin and destination airports for a callsign (adsbdb.com)."""
    callsign = callsign.strip().upper()

    async def fetch():
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                r = await client.get(f"https://api.adsbdb.com/v0/callsign/{callsign}")
            except httpx.HTTPError:
                return None
        if r.status_code != 200:
            return None
        fr = (r.json().get("response") or {}).get("flightroute") or {}

        def apt(a):
            return a and {"icao": a.get("icao_code"), "iata": a.get("iata_code"), "name": a.get("name"),
                          "city": a.get("municipality"), "lat": a.get("latitude"), "lon": a.get("longitude")}
        return {"origin": apt(fr.get("origin")), "destination": apt(fr.get("destination")),
                "airline": (fr.get("airline") or {}).get("name")} if fr else None

    result = await _cached(("route", callsign), 3600, fetch)
    if not result:
        raise HTTPException(404, "route unknown")
    return result


@app.get("/api/photo/{hex_}")
async def photo(hex_: str):
    """An aircraft photo with photographer credit (planespotters.net)."""
    hex_ = hex_.strip().lower()

    async def fetch():
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "atc-live/1.0"}) as client:
            try:
                r = await client.get(f"https://api.planespotters.net/pub/photos/hex/{hex_}")
            except httpx.HTTPError:
                return None
        photos = r.json().get("photos") if r.status_code == 200 else None
        if not photos:
            return None
        ph = photos[0]
        return {"src": (ph.get("thumbnail_large") or ph.get("thumbnail") or {}).get("src"),
                "link": ph.get("link"), "photographer": ph.get("photographer")}

    result = await _cached(("photo", hex_), 86400, fetch)
    if not result:
        raise HTTPException(404, "no photo")
    return result


@app.get("/api/messages")
def messages(q: str = "", limit: int = 50, all: bool = False):
    """Latest ACARS messages, crew-written ones only unless all=true."""
    return store.feed(limit=max(1, min(limit, 500)), q=q, interesting_only=not all)


@app.get("/api/messages/aircraft")
def aircraft_messages(hex: str = "", reg: str = "", callsign: str = ""):
    return store.for_aircraft(hex_=hex, reg=reg, callsign=callsign)


@app.get("/api/messages/stream")
async def message_stream():
    queue = asyncio.Queue()

    async def events():
        store.listeners.add(queue)
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15)
                    yield _sse("message", msg)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            store.listeners.discard(queue)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/status")
def status():
    return {
        "messages": len(store.messages),
        "receiver": {"udp_port": ACARS_UDP_PORT or None,
                     "messages": sum(1 for m in store.messages if m["source"] == "receiver")},
        "airframes": {"status": airframes.status, "error": airframes.last_error},
        "headlines": "claude" if headliner.enabled else "basic",
    }


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


# The page uses relative paths so the same files also work on GitHub Pages
# (atc-live/static/), where it reads ../data and ../feeds.json directly.
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.mount("/data", StaticFiles(directory=ROOT / "data"), name="data")
app.mount("/", StaticFiles(directory=ROOT / "static"), name="root")
