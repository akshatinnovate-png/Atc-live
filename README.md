# ATC Live

See what real pilots are saying, on a live map of every aircraft:

- **ACARS pilot messages.** These are the text messages crews and airlines
  send each other ("FA1 REPORTS PAX IN 9D UNWELL…"). Each aircraft on the
  map shows its callsign tag and message count. Tap one to see its route
  and its latest message.
- **Replay** flies to the aircraft and types out each of its messages in turn.
- **MCDU** shows a message on a cockpit-style MCDU screen (← → step through
  messages, ↑ ↓ change pages).
- **Messages** is a live feed of crew-written messages from every aircraft,
  as cards with a headline and a photo of the aircraft.
- **Listen to this plane.** Tap any aircraft, anywhere in the world, then
  tap 🎧. The app finds the frequency that plane is most likely on:
  Ground/Tower near the runway, Approach/Departure in the terminal area,
  Center en route. It plays the live audio with a running transcript and
  **follows the plane**, switching frequency when it's handed to the next
  controller. Other nearby frequencies are in the drop-down.
- **ATC radio** lets you pick any frequency yourself. Callsigns heard on the
  radio light up on the map.

## Web version (GitHub Pages)

The page also works with no server: open `static/index.html` from any
static host, such as GitHub Pages (the root `index.html` redirects to it). It then talks to the public services straight from the
browser: aircraft from adsb.lol / adsb.fi, routes from adsbdb, photos from
planespotters, LiveATC lookups through public CORS proxies (allorigins,
corsproxy.io, codetabs), and audio directly from LiveATC.

What you get on the web version: the live map of every aircraft, search,
routes, and **🎧 Listen to this plane** with auto-follow (audio only).
What needs the server below: ACARS pilot messages, live transcripts, and
LiveATC lookups that don't depend on free proxies. Add `?mode=browser` to
the URL to try the web version locally.

## Run

Needs Python 3.10+ and `ffmpeg` (ffmpeg is only used for ATC radio).

```bash
git clone https://github.com/akshatinnovate-png/atc-live
cd atc-live
pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

Aircraft positions, routes, photos and the map work as soon as it starts.
**ACARS messages need a source**, and the Messages tab tells you if none is
connected:

### Option A: the airframes.io network (no hardware)

[airframes.io](https://app.airframes.io) collects ACARS from thousands of
volunteer receivers worldwide. Create an account, get an API key, then:

```bash
AIRFRAMES_API_KEY=your-key python -m uvicorn server:app --port 8000
```

If they've changed their API, set `AIRFRAMES_URL` (default
`https://api.airframes.io/messages?limit=200`) and `AIRFRAMES_KEY_HEADER`
(default `X-API-KEY`) to match their docs. `/api/status` shows whether
polling works.

### Option B: your own receiver (most reliable)

Use an RTL-SDR dongle (~$30) and an airband antenna. Run a decoder and send
its JSON to this server on UDP port 5550 (change it with `ACARS_UDP_PORT`):

```bash
acarsdec -j 127.0.0.1:5550 -r 0 131.550 130.025 129.125     # VHF ACARS (US)
dumpvdl2 --output decoded:json:udp:address=127.0.0.1,port=5550 136975000 136650000
```

dumphfdl and acars_router JSON work the same way.

### Optional: AI headlines

The feed builds each headline from the message's first words. For headlines
like "Cocaine found onboard", with passenger names replaced by `[NAME]`,
have Claude write them:

```bash
HEADLINES=claude ANTHROPIC_API_KEY=sk-ant-... python -m uvicorn server:app --port 8000
```

This uses `claude-opus-5-5` by default (change it with `HEADLINE_MODEL`), at
low effort, and only for messages that already look crew-written. It also
turns on server-side refusal fallbacks.

### Where you can hear planes

Audio comes from [LiveATC.net](https://www.liveatc.net) volunteers, so
coverage is wherever someone runs a scanner. It's dense across the US and
Canada, good in much of Europe, Australia, Brazil and Japan, and thin or
missing in much of Asia (including most of India), Africa and over oceans.
When nothing covers a plane, the app tells you which airports it checked
instead of playing the wrong frequency. ACARS text messages (below) cover
far more of the world.

Frequency lookup scrapes LiveATC's public search page for the nearest
airports (`atc_finder.py`, cached 6 h). If LiveATC changes its page layout
and lookups stop finding feeds, that parser is the place to fix.

## How it works

```
acarsdec/dumpvdl2 ──UDP──┐
airframes.io ──poll──────┴─▶ acars.normalize ─▶ MessageStore ──SSE──▶ live feed
                                                     │
adsb.fi / adsb.lol ──▶ /api/traffic (aircraft + message counts) ──▶ map tags
adsbdb.com ──▶ /api/route   planespotters.net ──▶ /api/photo

LiveATC ─ffmpeg─▶ Segmenter ─▶ Whisper ─▶ callsigns ──SSE──▶ ATC radio drawer
```

- `acars.py`: parses acarsdec, dumpvdl2, dumphfdl and airframes.io
  messages. It matches them to aircraft by transponder hex, registration
  or flight number (`AA1779` → `AAL1779`), and separates crew-written text
  from automated position and weather reports.
- `sources.py`: the UDP receiver, the airframes.io poller and optional
  Claude headlines.
- `atc_finder.py`: nearest airports (bundled OurAirports data, public
  domain), LiveATC feed lookup, flight phase, and which feed to pick.
- `segmenter.py` / `callsigns.py`: split ATC audio into one clip per radio
  call, then read callsigns ("Speedbird one seven niner" → `BAW179`) and
  guess whether a call is from ATC or a pilot.
- `static/`: the map (Leaflet, CARTO dark tiles), flight sheet, replay,
  MCDU, feed and radio drawer.

ATC radio settings: `WHISPER_MODEL` (`base.en`, `small.en` default,
`medium.en`), `TRANSCRIBER=none` to skip speech-to-text. Radio feeds are
listed in `feeds.json`. The LiveATC mount names there are best guesses, so
check them on liveatc.net if one doesn't connect.

```bash
pytest tests
```

## Caveats

- **Personal use only.** LiveATC doesn't allow rebroadcasting its streams,
  and airframes.io data is under its own terms. Don't host this publicly
  without permission.
- ACARS free text can mention passengers. Turn on AI headlines to have
  names redacted, and don't repost what you read.
- Transcripts and headlines are machine-generated. Never use this for
  navigation.
