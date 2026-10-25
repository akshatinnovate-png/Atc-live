/* Works out which airport and which kind of ATC frequency a plane is most
   likely talking to, so "Listen on LiveATC" can open the right page and
   say what to look for there. Runs in the browser; tests/finder.test.js
   runs it under Node. */
(function(root){
"use strict";

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

// Nearest airports, with big airports favoured (they're the ones with feeds).
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

// What a listener should look for on LiveATC's airport page.
var LOOK_FOR = {
  ground: { label:"On the ground", feeds:"Ground, Clearance Delivery or Tower" },
  tower: { label:"Taking off or landing", feeds:"Tower" },
  terminal: { label:"Climbing or descending near the airport", feeds:"Approach or Departure" },
  enroute: { label:"Cruising", feeds:"Center or Control (en-route)" }
};

function liveatcUrl(icao){ return "https://www.liveatc.net/search/?icao=" + encodeURIComponent(icao); }

// Everything the flight sheet needs to show.
function suggest(airports, plane){
  var near = nearestAirports(airports, plane.lat, plane.lon, 8, 200);
  if (!near.length) return { phase:null, airports:[] };
  var closest = near.reduce(function(a, b){ return b.dist_nm < a.dist_nm ? b : a; });
  var alt = plane.alt === "ground" ? "ground" : (typeof plane.alt === "number" ? plane.alt : null);
  var phase = flightPhase(alt, plane.gs || 0, closest.dist_nm, closest.elev_ft);
  // On the ground or near the runway, the closest airport is the one.
  // Cruising, Center feeds are listed under big airports: lead with those.
  var ordered;
  if (phase === "ground" || phase === "tower"){
    ordered = [closest].concat(near.filter(function(a){ return a !== closest; }));
  } else if (phase === "enroute"){
    var byDist = near.slice().sort(function(x, y){ return x.dist_nm - y.dist_nm; });
    ordered = byDist.filter(function(a){ return a.large; }).concat(byDist.filter(function(a){ return !a.large; }));
  } else {
    ordered = near;
  }
  return { phase:phase, look:LOOK_FOR[phase], airports:ordered.slice(0, 4).map(function(a){
    return { icao:a.icao, name:a.name, city:a.city, dist_nm:a.dist_nm, url:liveatcUrl(a.icao) };
  }) };
}

var api = { distanceNm:distanceNm, toAirports:toAirports, nearestAirports:nearestAirports,
  flightPhase:flightPhase, liveatcUrl:liveatcUrl, suggest:suggest, LOOK_FOR:LOOK_FOR };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.Finder = api;
})(this);
