// node --test tests/finder.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const F = require("../static/finder.js");

const AIRPORTS = F.toAirports(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "airports.json"), "utf8")));

test("nearest airports worldwide", () => {
  assert.equal(F.nearestAirports(AIRPORTS, 40.64, -73.78)[0].icao, "KJFK");
  assert.equal(F.nearestAirports(AIRPORTS, 19.09, 72.87)[0].icao, "VABB");   // Mumbai
  assert.equal(F.nearestAirports(AIRPORTS, 51.47, -0.46)[0].icao, "EGLL");   // Heathrow
  assert.deepEqual(F.nearestAirports(AIRPORTS, 0, -30), []);                 // mid-Atlantic
});

test("flight phase", () => {
  assert.equal(F.flightPhase("ground", 10, 0.5), "ground");
  assert.equal(F.flightPhase(1500, 150, 4), "tower");
  assert.equal(F.flightPhase(9000, 280, 30), "terminal");
  assert.equal(F.flightPhase(36000, 460, 30), "enroute");
  assert.equal(F.flightPhase(5300, 30, 1, 5280), "ground");  // Denver-style high field
});

test("suggest: taxiing at JFK points at JFK's page and Ground/Tower feeds", () => {
  const s = F.suggest(AIRPORTS, { lat: 40.6413, lon: -73.7781, alt: "ground", gs: 12 });
  assert.equal(s.phase, "ground");
  assert.equal(s.airports[0].icao, "KJFK");
  assert.equal(s.airports[0].url, "https://www.liveatc.net/search/?icao=KJFK");
  assert.match(s.look.feeds, /Ground/);
});

test("suggest: cruising points at Center feeds and big airports", () => {
  const s = F.suggest(AIRPORTS, { lat: 40.9, lon: -74.3, alt: 36000, gs: 470 });
  assert.equal(s.phase, "enroute");
  assert.match(s.look.feeds, /Center/);
  assert.ok(s.airports.length >= 2 && s.airports.length <= 4);
});

test("suggest: cruising over Kentucky leads with the nearest big airport, not a small one", () => {
  const s = F.suggest(AIRPORTS, { lat: 38.05, lon: -84.78, alt: 34000, gs: 452 });
  assert.equal(s.phase, "enroute");
  assert.equal(s.airports[0].icao, "KSDF");  // Louisville (large), not Lexington (8 NM, medium)
});

test("suggest: over the ocean there is nothing to open", () => {
  assert.deepEqual(F.suggest(AIRPORTS, { lat: 0, lon: -30, alt: 37000, gs: 480 }), { phase: null, airports: [] });
});
