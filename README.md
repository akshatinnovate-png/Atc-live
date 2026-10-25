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
- **🎧 Listen on LiveATC.** Tap any aircraft and the app works out which
  airport and which kind of frequency it's most likely on (Ground or Tower
  near the runway, Approach or Departure near the airport, Center when
  cruising). It opens that airport's page in LiveATC's own player in a new
  tab and tells you which feed to pick, with nearby airports as backups.
- **ATC radio** plays streams you're allowed to use, such as your own
  airband receiver, with a live transcript. Callsigns heard on it light up
  on the map.

## Web version (GitHub Pages)

The page also works with no server: open `static/index.html` from any
static host, such as GitHub Pages (the root `index.html` redirects to it). It then talks to the public services straight from the
browser: aircraft from adsb.lol / adsb.fi (through public CORS proxies if
needed), routes from adsbdb and photos from planespotters.

What you get on the web version: the live map of every aircraft, search,
routes and **🎧 Listen on LiveATC**. What needs the server below: ACARS
pilot messages and the ATC radio with live transcripts. Add `?mode=browser`
to the URL to try the web version locally.

## Run

Needs Python 3.10+ and `ffmpeg` (ffmpeg is only used for ATC radio).

```bash
git clone https://github.com/akshatinnovate-png/Atc-live atc-live
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

### Listening to ATC

[LiveATC.net](https://www.liveatc.net)'s terms say its audio "may not be
used in any third-party products", and its site checks that you're human.
So the app never fetches LiveATC pages or plays its streams itself: the 🎧
button just opens LiveATC's own player for the right airport. Coverage is
wherever a volunteer runs a scanner: dense across the US and Canada, good
in much of Europe, Australia, Brazil and Japan, and thin or missing in much
of Asia (including most of India), Africa and over oceans. ACARS messages
cover far more of the world.

### Optional: your own ATC audio, in the app

To hear ATC inside the app, with live transcripts and callsigns lighting up
on the map, stream your own airband receiver. An RTL-SDR dongle running
[rtl_airband](https://github.com/rtl-airband/RTLSDR-Airband) with an
Icecast output works. **Check your local law first:** some countries
(including India) require a licence to receive aviation frequencies. Then
list the stream in `feeds.json`:

```json
[
  {"id": "home-twr", "airport": "VABB", "name": "Mumbai Tower (my receiver)",
   "lat": 19.0887, "lon": 72.8679, "url": "http://192.168.1.50:8000/tower.mp3"}
]
```

It appears under **ATC radio**.

## How it works

```
acarsdec/dumpvdl2 ──UDP──┐
airframes.io ──poll──────┴─▶ acars.normalize ─▶ MessageStore ──SSE──▶ live feed
                                                     │
adsb.fi / adsb.lol ──▶ /api/traffic (aircraft + message counts) ──▶ map tags
adsbdb.com ──▶ /api/route   planespotters.net ──▶ /api/photo

your receiver ─ffmpeg─▶ Segmenter ─▶ Whisper ─▶ callsigns ──SSE──▶ ATC radio drawer
```

- `acars.py`: parses acarsdec, dumpvdl2, dumphfdl and airframes.io
  messages. It matches them to aircraft by transponder hex, registration
  or flight number (`AA1779` → `AAL1779`), and separates crew-written text
  from automated position and weather reports.
- `sources.py`: the UDP receiver, the airframes.io poller and optional
  Claude headlines.
- `static/finder.js`: nearest airports (bundled OurAirports data, public
  domain), flight phase, and which LiveATC page and feed to suggest.
- `segmenter.py` / `callsigns.py`: split ATC audio into one clip per radio
  call, then read callsigns ("Speedbird one seven niner" → `BAW179`) and
  guess whether a call is from ATC or a pilot.
- `static/`: the map (Leaflet, Esri dark tiles with an OpenStreetMap
  fallback), flight sheet, replay, MCDU, feed and radio drawer.

ATC radio settings: `WHISPER_MODEL` (`base.en`, `small.en` default,
`medium.en`), `TRANSCRIBER=none` to skip speech-to-text.

```bash
pytest tests
node --test tests/finder.test.js
```

## Caveats

- **Personal use.** airframes.io data is under its own terms; check them
  before hosting this publicly.
- ACARS free text can mention passengers. Turn on AI headlines to have
  names redacted, and don't repost what you read.
- Transcripts and headlines are machine-generated. Never use this for
  navigation.
