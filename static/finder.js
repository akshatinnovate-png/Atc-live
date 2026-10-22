/* Browser port of atc_finder.py, used when the app runs without its server
   (e.g. on GitHub Pages). Keep the two in step: tests/finder.test.js runs
   this file against the same LiveATC fixture as tests/test_atc_finder.py. */
(function(root){
"use strict";

var MOUNT_RE = /^[a-z0-9_]{2,40}$/;
var PHASE_WORDS = {
  ground: ["gnd", "ground", "del", "delivery", "clnc", "clearance", "ramp", "twr", "tower"],
  tower: ["twr", "tower", "local", "gnd", "ground"],
  terminal: ["app", "approach", "dep", "departure", "tracon", "radar", "final", "director", "arr", "arrival", "terminal"],
  enroute: ["ctr", "center", "centre", "artcc", "control", "area", "acc", "radar", "oceanic"]
};

function rad(d){ return d * Math.PI / 180; }
function distanceNm(lat1, lon1, lat2, lon2){
  var p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
  var a = Math.pow(Math.sin(dp / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

// airports: rows of the bundled data/airports.json ("fields" order)
function toAirports(data){
  return data.airports.map(function(r){
    var o = {}; data.fields.forEach(function(f, i){ o[f] = r[i]; }); return o;
  });
}

function nearestAirports(airports, lat, lon, limit, maxNm){
  limit = limit || 8; maxNm = maxNm || 200;
  var box = maxNm / 60 + 1, near = [];
  airports.forEach(function(a){
    if (Math.abs(a.lat - lat) > box) return;
    var d = distanceNm(lat, lon, a.lat, a.lon);
    if (d <= maxNm) near.push([d, a]);
  });
  near.sort(function(x, y){ return (x[0] - (x[1].large ? 8 : 0)) - (y[0] - (y[1].large ? 8 : 0)); });
  return near.slice(0, limit).map(function(x){
    var o = Object.assign({}, x[1]); o.dist_nm = Math.round(x[0] * 10) / 10; return o;
  });
}

function flightPhase(alt, gs, distToAirportNm, elev){
  elev = elev || 0;
  if (alt === "ground" || (typeof alt === "number" && alt - elev < 300 && (gs || 0) < 60)) return "ground";
  if (typeof alt !== "number") return "terminal";
  var agl = alt - elev;
  if (agl < 3000 && distToAirportNm < 10) return "tower";
  if (alt < 18000 && distToAirportNm < 60) return "terminal";
  return "enroute";
}

function unescapeHtml(s){
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function text(fragment){ return unescapeHtml(fragment.replace(/<[^>]+>/g, " ")).trim(); }

function parseLiveatcSearch(page){
  var first = {}, ordered = [], m;
  var linkRe = /(?:mount=|\/play\/)([a-z0-9_]+)(?:\.pls)?/g;
  while ((m = linkRe.exec(page))){
    if (MOUNT_RE.test(m[1]) && !(m[1] in first)){ first[m[1]] = m.index; ordered.push([m[1], m.index]); }
  }
  var titles = [], titleRe = /<strong>([\s\S]*?)<\/strong>/gi;
  while ((m = titleRe.exec(page))){
    var t = text(m[1]);
    if (t && ["UP", "DOWN"].indexOf(t.toUpperCase()) < 0 && t.length < 90) titles.push([m.index, t]);
  }
  return ordered.map(function(entry, i){
    var mount = entry[0], pos = entry[1];
    var before = titles.filter(function(t){ return t[0] < pos; });
    var title = before.length ? before[before.length - 1] : [0, mount];
    var end = i + 1 < ordered.length ? ordered[i + 1][1] : page.length;
    var after = titles.filter(function(t){ return t[0] > pos; });
    var nextTitle = after.length ? after[0][0] : page.length;
    var win = text(page.slice(title[0], nextTitle > pos ? Math.min(end, nextTitle) : end));
    var st = /\b(UP|DOWN)\b/.exec(win);
    var freqs = {}, fr = /\b(1[1-3]\d\.\d{2,3})\b/g, f;
    while ((f = fr.exec(win))){ if (+f[1] >= 108 && +f[1] < 137) freqs[f[1]] = 1; }
    return { mount: mount, name: title[1], status: st ? st[1].toLowerCase() : "unknown", freqs: Object.keys(freqs).sort() };
  });
}

function parsePls(t){ var m = /^File\d+=(\S+)/im.exec(t); return m ? m[1].trim() : null; }

function scoreFeed(feed, phase, distNm){
  if (feed.status === "down") return null;
  var name = feed.name.toLowerCase(), words = {};
  (name.match(/[a-z]+/g) || []).forEach(function(w){ words[w] = 1; });
  var score = 0;
  PHASE_WORDS[phase].forEach(function(w, rank){
    if (words[w] || (w.length > 4 && name.indexOf(w) >= 0)) score = Math.max(score, 10 - rank * 0.5);
  });
  if (!score){
    Object.keys(PHASE_WORDS).some(function(other){
      if (other !== phase && PHASE_WORDS[other].some(function(w){ return words[w]; })){ score = 3; return true; }
      return false;
    });
  }
  if (feed.status === "up") score += 2;
  return score - distNm / 25;
}

function choose(feedsByAirport, phase){
  var ranked = [];
  feedsByAirport.forEach(function(pair){
    var apt = pair[0];
    pair[1].forEach(function(f){
      var s = scoreFeed(f, phase, apt.dist_nm);
      if (s !== null) ranked.push([s, apt, f]);
    });
  });
  ranked.sort(function(a, b){ return b[0] - a[0]; });
  var seen = {}, out = [];
  ranked.forEach(function(r){
    var s = r[0], apt = r[1], f = r[2];
    if (seen[f.mount]) return;
    seen[f.mount] = 1;
    out.push({ mount: f.mount, name: f.name, status: f.status, freqs: f.freqs, airport: apt.icao,
      airport_name: apt.name, city: apt.city, dist_nm: apt.dist_nm, lat: apt.lat, lon: apt.lon,
      score: Math.round(s * 100) / 100 });
  });
  return out;
}

var api = { MOUNT_RE: MOUNT_RE, distanceNm: distanceNm, toAirports: toAirports, nearestAirports: nearestAirports,
  flightPhase: flightPhase, parseLiveatcSearch: parseLiveatcSearch, parsePls: parsePls, scoreFeed: scoreFeed, choose: choose };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.Finder = api;
})(this);
