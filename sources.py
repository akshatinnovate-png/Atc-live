"""Where ACARS messages come from, and optional AI headlines for them.

Two sources, use either or both:

* Your own receiver. Point acarsdec, dumpvdl2, dumphfdl or acars_router at
  this server's UDP port (ACARS_UDP_PORT, default 5550). Each datagram is
  one JSON message. This is the most reliable source and covers whatever
  your antenna hears.
* airframes.io, the community network that aggregates thousands of
  receivers worldwide. Set AIRFRAMES_API_KEY (from your airframes.io
  account) to poll it.
"""

import asyncio
import json
import logging
import os

import httpx

from acars import normalize

log = logging.getLogger("atc-live.sources")


def env(name, default=None):
    """An environment setting with stray whitespace removed.

    On Windows, `set KEY=value && next-command` keeps the space before
    `&&` as part of the value, which breaks API keys sent as headers.
    """
    value = os.environ.get(name)
    value = value.strip() if value is not None else ""
    return value if value else default

AIRFRAMES_URL = env("AIRFRAMES_URL", "https://api.airframes.io/messages?limit=200")
AIRFRAMES_API_KEY = env("AIRFRAMES_API_KEY")
AIRFRAMES_KEY_HEADER = env("AIRFRAMES_KEY_HEADER", "X-API-KEY")
AIRFRAMES_POLL_S = float(env("AIRFRAMES_POLL_S", "10"))


class _UDPProtocol(asyncio.DatagramProtocol):
    def __init__(self, on_message):
        self.on_message = on_message

    def datagram_received(self, data, addr):
        # acars_router sends one JSON object per datagram; acarsdec may
        # batch several newline-separated ones.
        for line in data.decode(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                self.on_message(normalize(json.loads(line), source="receiver"))
            except (ValueError, TypeError, AttributeError) as e:
                log.warning("bad ACARS datagram from %s: %s", addr[0], e)


async def start_udp_receiver(on_message, host="0.0.0.0", port=5550):
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: _UDPProtocol(on_message), local_addr=(host, port))
    log.info("listening for ACARS JSON on udp/%s", port)
    return transport


class AirframesPoller:
    def __init__(self, on_message):
        self.on_message = on_message
        self.status = "disabled" if not AIRFRAMES_API_KEY else "starting"
        self.last_error = None

    async def run(self):
        if not AIRFRAMES_API_KEY:
            return
        headers = {AIRFRAMES_KEY_HEADER: AIRFRAMES_API_KEY, "User-Agent": "atc-live/1.0"}
        async with httpx.AsyncClient(timeout=15, headers=headers) as client:
            while True:
                try:
                    r = await client.get(AIRFRAMES_URL)
                    r.raise_for_status()
                    body = r.json()
                    rows = body if isinstance(body, list) else body.get("messages") or body.get("data") or []
                    for raw in rows:
                        self.on_message(normalize(raw, source="airframes"))
                    self.status, self.last_error = "live", None
                except (httpx.HTTPError, ValueError) as e:
                    self.status, self.last_error = "error", str(e)
                    log.warning("airframes poll failed: %s", e)
                await asyncio.sleep(AIRFRAMES_POLL_S)


class Headliner:
    """Uses Claude to title crew messages, like a news card, and hide names.

    Optional: runs only when Anthropic credentials are configured
    (ANTHROPIC_API_KEY or an `ant auth login` profile) and HEADLINES=claude.
    """

    MODEL = env("HEADLINE_MODEL", "claude-opus-5-5")
    SCHEMA = {
        "type": "object",
        "properties": {
            "interesting": {"type": "boolean"},
            "headline": {"type": "string"},
            "redacted_text": {"type": "string"},
        },
        "required": ["interesting", "headline", "redacted_text"],
        "additionalProperties": False,
    }
    PROMPT = (
        "This is an ACARS datalink message between an airliner and its airline.\n"
        "Return JSON:\n"
        "- interesting: true if a person wrote it about something happening on the "
        "flight (passengers, crew, medical, security, delays, diversions, maintenance "
        "problems); false for routine or automated content.\n"
        "- headline: 2-5 words in sentence case summarizing it like a news card, "
        "e.g. \"Cocaine found onboard\", \"Unruly passenger in 9D\".\n"
        "- redacted_text: the message unchanged except every person's name replaced "
        "with [NAME].\n\nMessage:\n"
    )

    def __init__(self):
        self.enabled = env("HEADLINES") == "claude"
        self._client = None
        self._sem = asyncio.Semaphore(4)

    def _get_client(self):
        if self._client is None:
            import anthropic
            # strip the key for the same reason as env(); None falls back to
            # the SDK's usual credential lookup
            self._client = anthropic.AsyncAnthropic(api_key=env("ANTHROPIC_API_KEY"))
        return self._client

    async def headline(self, text):
        """Return {"interesting", "headline", "redacted_text"} or None on failure."""
        if not self.enabled:
            return None
        import anthropic
        async with self._sem:
            try:
                response = await self._get_client().beta.messages.create(
                    model=self.MODEL,
                    max_tokens=2000,
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                    output_config={"effort": "low",
                                   "format": {"type": "json_schema", "schema": self.SCHEMA}},
                    messages=[{"role": "user", "content": self.PROMPT + text}],
                )
            except anthropic.RateLimitError:
                log.warning("headline rate limited")
                return None
            except anthropic.APIStatusError as e:
                log.warning("headline API error %s: %s", e.status_code, e.message)
                return None
            except anthropic.APIConnectionError:
                log.warning("headline: cannot reach the Claude API")
                return None
        if response.stop_reason != "end_turn":
            return None
        text_block = next((b.text for b in response.content if b.type == "text"), None)
        try:
            return json.loads(text_block) if text_block else None
        except ValueError:
            return None
