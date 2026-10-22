// node --test tests/finder.test.js — same cases as test_atc_finder.py, for the browser port.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const F = require("../static/finder.js");

const PAGE = fs.readFileSync(path.join(__dirname, "fixtures", "liveatc_search_kjfk.html"), "utf8");
const AIRPORTS = F.toAirports(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "airports.json"), "utf8")));

test("parse search page", () => {
  const feeds = F.parseLiveatcSearch(PAGE);
  assert.deepEqual(feeds.map(f => f.mount), ["kjfk9_s", "kjfk_app_final", "kjfk_dep", "zny_34"]);
  assert.deepEqual(feeds[0], { mount: "kjfk9_s", name: "KJFK Ground/Tower", status: "up", freqs: ["119.100", "121.900"] });
  assert.equal(feeds[1].status, "down");
  assert.equal(feeds[3].name, "ZNY New York Center (Sector 34)");
  assert.deepEqual(F.parseLiveatcSearch("<html>No results</html>"), []);
});

test("parse pls", () => {
  assert.equal(F.parsePls("[playlist]\nFile1=http://d.liveatc.net/kjfk9_s\n"), "http://d.liveatc.net/kjfk9_s");
  assert.equal(F.parsePls("garbage"), null);
});

test("nearest airports worldwide", () => {
  assert.equal(F.nearestAirports(AIRPORTS, 40.64, -73.78)[0].icao, "KJFK");
  assert.equal(F.nearestAirports(AIRPORTS, 19.09, 72.87)[0].icao, "VABB");
  assert.equal(F.nearestAirports(AIRPORTS, 51.47, -0.46)[0].icao, "EGLL");
  assert.deepEqual(F.nearestAirports(AIRPORTS, 0, -30), []);
});

test("flight phase", () => {
  assert.equal(F.flightPhase("ground", 10, 0.5), "ground");
  assert.equal(F.flightPhase(1500, 150, 4), "tower");
  assert.equal(F.flightPhase(9000, 280, 30), "terminal");
  assert.equal(F.flightPhase(36000, 460, 30), "enroute");
  assert.equal(F.flightPhase(5300, 30, 1, 5280), "ground");
});

test("choose by phase, skip down feeds", () => {
  const apt = { icao: "KJFK", name: "JFK", city: "New York", dist_nm: 3, lat: 40.6, lon: -73.8 };
  const ranked = phase => F.choose([[apt, F.parseLiveatcSearch(PAGE)]], phase).map(f => f.mount);
  assert.equal(ranked("ground")[0], "kjfk9_s");
  assert.equal(ranked("tower")[0], "kjfk9_s");
  assert.equal(ranked("terminal")[0], "kjfk_dep");
  assert.equal(ranked("enroute")[0], "zny_34");
  assert.ok(!ranked("terminal").includes("kjfk_app_final"));
});
