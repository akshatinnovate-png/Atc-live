/* Where the page gets its data.

   Server mode: the ATC Live Python server (`/api/...`). Everything works,
   including ACARS messages and live Whisper transcripts.

   Browser mode: no server, e.g. hosted on GitHub Pages. The page calls the
   public services directly: ADS-B, routes and photos from their open APIs,
   and LiveATC through public CORS proxies (LiveATC sends no CORS headers).
   Audio plays straight from LiveATC. ACARS and transcripts need the server,
   so they're unavailable here and the page says so. */
(function(){
"use strict";

// ICAO prefix -> [IATA code, brand colour]; also used for IATA -> ICAO search
var AIRLINES = {
  AAL:["AA","#0078d2"], DAL:["DL","#c8102e"], UAL:["UA","#005daa"], SWA:["WN","#304cb2"], JBU:["B6","#0033a0"],
  ASA:["AS","#01426a"], NKS:["NK","#b5a300"], FFT:["F9","#248168"], HAL:["HA","#6a2c91"], AAY:["G4","#f58025"],
  SCX:["SY","#e35205"], MXY:["MX","#1a3c8f"], EDV:["9E","#c8102e"], SKW:["OO","#1e3765"], ENY:["MQ","#0078d2"],
  RPA:["YX","#2e3b55"], JIA:["OH","#0078d2"], PDT:["PT","#0078d2"], FDX:["FX","#4d148c"], UPS:["5X","#5f3c18"],
  GTI:["5Y","#00205b"], ACA:["AC","#d22630"], JZA:["QK","#d22630"], WJA:["WS","#00a7b5"], BAW:["BA","#075aaa"],
  EIN:["EI","#00845a"], DLH:["LH","#05164d"], AFR:["AF","#002157"], KLM:["KL","#00a1de"], SWR:["LX","#e2001a"],
  IBE:["IB","#d7192d"], VIR:["VS","#e10a0a"], EZY:["U2","#ff6600"], RYR:["FR","#073590"], UAE:["EK","#d71921"],
  QTR:["QR","#5c0632"], ETD:["EY","#bd8b13"], THY:["TK","#c70a0c"], AIC:["AI","#da251d"], AXB:["IX","#e4002b"],
  IGO:["6E","#22228a"], VTI:["UK","#5f2758"], AKJ:["QP","#ff6b00"], SEJ:["SG","#d11e1e"], SIA:["SQ","#1d2b5e"],
  CPA:["CX","#006564"], QFA:["QF","#e40000"], JAL:["JL","#cc0000"], ANA:["NH","#13448f"], KAL:["KE","#00256c"],
  AAR:["OZ","#a1824a"], CES:["MU","#1a3e8c"], CCA:["CA","#d71920"], CSN:["CZ","#005dab"], AMX:["AM","#0b2343"],
  VOI:["Y4","#a6007e"], CMP:["CM","#00529b"], AVA:["AV","#da291c"], LAN:["LA","#1b0088"], SAS:["SK","#000f9f"],
  FIN:["AY","#0b1560"], TAP:["TP","#d6001c"], AUA:["OS","#d81e05"], BEL:["SN","#00235f"], LOT:["LO","#11397e"], WZZ:["W6","#c6007e"]
};
var IATA_TO_ICAO = {};
Object.keys(AIRLINES).forEach(function(icao){ IATA_TO_ICAO[AIRLINES[icao][0]] = IATA_TO_ICAO[AIRLINES[icao][0]] || icao; });
function flightToCallsign(q){
  var m = /^([A-Z0-9]{2})0*(\d{1,4}[A-Z]{0,2})$/.exec(q);
  return m && IATA_TO_ICAO[m[1]] ? IATA_TO_ICAO[m[1]] + m[2] : q;
}

function fetchText(url, ms){
  var ctrl = new AbortController(), t = setTimeout(function(){ ctrl.abort(); }, ms || 10000);
  return fetch(url, { signal:ctrl.signal, cache:"no-store" }).then(function(r){
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).finally(function(){ clearTimeout(t); });
}
function fetchJSON(url, ms){ return fetchText(url, ms).then(JSON.parse); }
function anyOf(promises){
  return new Promise(function(resolve, reject){
    var left = promises.length, errs = [];
    if (!left) reject(new Error("nothing to try"));
    promises.forEach(function(p){ p.then(resolve, function(e){ errs.push(e); if (!--left) reject(errs[0]); }); });
  });
}

/* ---------- server mode ---------- */
function ServerBackend(){
  this.mode = "server";
}
ServerBackend.prototype = {
  traffic: function(lat, lon, dist){ return fetchJSON("/api/traffic?lat=" + lat.toFixed(3) + "&lon=" + lon.toFixed(3) + "&dist=" + dist); },
  search: function(q){ return fetchJSON("/api/search?q=" + encodeURIComponent(q), 20000); },
  route: function(cs){ return fetchJSON("/api/route/" + encodeURIComponent(cs)); },
  photo: function(hex){ return fetchJSON("/api/photo/" + hex); },
  aircraftMessages: function(p){
    return fetchJSON("/api/messages/aircraft?hex=" + p.hex + "&reg=" + encodeURIComponent(p.reg || "") + "&callsign=" + encodeURIComponent(p.callsign || ""));
  },
  messages: function(q, all){ return fetchJSON("/api/messages?limit=60&q=" + encodeURIComponent(q) + (all ? "&all=true" : "")); },
  status: function(){ return fetchJSON("/api/status").then(function(s){ s.mode = "server"; return s; }); },
  messageStream: function(onMessage){
    new EventSource("/api/messages/stream").addEventListener("message", function(e){ onMessage(JSON.parse(e.data)); });
  },
  feeds: function(){ return fetchJSON("/api/feeds"); },
  listen: function(p){
    return fetchJSON("/api/listen?lat=" + p.lat + "&lon=" + p.lon + "&alt=" + encodeURIComponent(p.alt == null ? "" : p.alt) + "&gs=" + (p.gs || 0), 30000);
  },
  transcripts: function(feed){ return new EventSource("/api/transcripts/" + encodeURIComponent(feed.id)); },
  audioUrls: function(feed){ return Promise.resolve(["/api/audio/" + encodeURIComponent(feed.id) + "?t=" + Date.now()]); }
};

/* ---------- browser mode ---------- */
var ADSB = [
  { name:"adsb.lol", base:"https://api.adsb.lol/v2", point:"/point/{lat}/{lon}/{dist}", callsign:"/callsign/{q}", reg:"/reg/{q}", hex:"/hex/{q}" },
  { name:"adsb.fi", base:"https://opendata.adsb.fi/api/v2", point:"/lat/{lat}/lon/{lon}/dist/{dist}", callsign:"/callsign/{q}", reg:"/registration/{q}", hex:"/hex/{q}" }
];
var PROXIES = [
  { name:"direct", wrap:function(u){ return u; } },
  { name:"allorigins", wrap:function(u){ return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u); } },
  { name:"corsproxy", wrap:function(u){ return "https://corsproxy.io/?url=" + encodeURIComponent(u); } },
  { name:"codetabs", wrap:function(u){ return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u); } }
];
var LIVEATC = "https://www.liveatc.net";

function BrowserBackend(base){
  this.mode = "browser";
  this.base = base;          // URL of the app's folder (for data files)
  this.good = {};            // host -> proxy that last worked for it
  this.cache = {};
  this._airports = null;
}
BrowserBackend.prototype = {
  // Try the last proxy that worked for this host first, then race the rest.
  _get: function(url, ms){
    var self = this, host = new URL(url).host, order = PROXIES.slice();
    var g = self.good[host];
    if (g) order.sort(function(a, b){ return (b.name === g) - (a.name === g); });
    var first = order[0];
    var attempt = function(px){
      return fetchText(px.wrap(url), ms).then(function(t){ self.good[host] = px.name; return t; });
    };
    return attempt(first).catch(function(){ return anyOf(order.slice(1).map(attempt)); });
  },
  _cached: function(key, ttlMs, fn){
    var self = this, hit = self.cache[key];
    if (hit && Date.now() - hit.t < ttlMs) return hit.p;
    var p = fn();
    self.cache[key] = { t:Date.now(), p:p };
    p.catch(function(){ delete self.cache[key]; });
    return p;
  },
  _adsb: function(kind, params){
    var self = this;
    var tryOne = function(i){
      var src = ADSB[i], path = src[kind].replace(/\{(\w+)\}/g, function(_, k){ return params[k]; });
      return self._get(src.base + path, 9000).then(function(t){
        var body = JSON.parse(t);
        return { source:src.name, rows:body.ac || body.aircraft || [] };
      });
    };
    return tryOne(0).catch(function(){ return tryOne(1); });
  },
  _plane: function(a){
    return { hex:(a.hex || "").toLowerCase(), callsign:(a.flight || "").trim().toUpperCase(), reg:a.r || null,
      type:a.t || null, desc:a.desc || null, lat:a.lat, lon:a.lon, alt:a.alt_baro, gs:a.gs,
      track:a.track != null ? a.track : (a.true_heading || 0), squawk:a.squawk || null, msgs:0, lastMsg:null };
  },
  _planes: function(rows){
    var self = this;
    return rows.filter(function(a){ return a.lat != null && a.lon != null; }).map(function(a){ return self._plane(a); });
  },
  traffic: function(lat, lon, dist){
    var self = this, key = ["pt", lat.toFixed(2), lon.toFixed(2), dist].join();
    return self._cached(key, 4000, function(){
      return self._adsb("point", { lat:lat.toFixed(4), lon:lon.toFixed(4), dist:dist });
    }).then(function(r){ return { source:r.source, aircraft:self._planes(r.rows) }; });
  },
  search: function(q){
    var self = this;
    q = q.trim().toUpperCase().replace(/\s+/g, "");
    var tries = [["callsign", flightToCallsign(q)], ["callsign", q], ["reg", q]];
    if (/^[0-9A-F]{6}$/.test(q)) tries.unshift(["hex", q.toLowerCase()]);
    var i = 0;
    var next = function(){
      if (i >= tries.length) return { aircraft:[] };
      var t = tries[i++];
      return self._adsb(t[0], { q:encodeURIComponent(t[1]) }).then(function(r){
        var planes = self._planes(r.rows);
        return planes.length ? { aircraft:planes } : next();
      }, next);
    };
    return Promise.resolve().then(next);
  },
  route: function(cs){
    return this._cached("route" + cs, 3600e3, function(){
      return fetchJSON("https://api.adsbdb.com/v0/callsign/" + encodeURIComponent(cs)).then(function(body){
        var fr = (body.response || {}).flightroute;
        if (!fr) throw new Error("route unknown");
        var apt = function(a){ return a && { icao:a.icao_code, iata:a.iata_code, name:a.name, city:a.municipality, lat:a.latitude, lon:a.longitude }; };
        return { origin:apt(fr.origin), destination:apt(fr.destination), airline:(fr.airline || {}).name };
      });
    });
  },
  photo: function(hex){
    return this._cached("photo" + hex, 86400e3, function(){
      return fetchJSON("https://api.planespotters.net/pub/photos/hex/" + hex).then(function(body){
        var ph = (body.photos || [])[0];
        if (!ph) throw new Error("no photo");
        return { src:(ph.thumbnail_large || ph.thumbnail || {}).src, link:ph.link, photographer:ph.photographer };
      });
    });
  },
  aircraftMessages: function(){ return Promise.resolve([]); },
  messages: function(){ return Promise.resolve([]); },
  status: function(){ return Promise.resolve({ mode:"browser", messages:0 }); },
  messageStream: function(){},
  feeds: function(){
    return fetchJSON(new URL("../feeds.json", this.base).href).then(function(list){
      return list.map(function(f){ return Object.assign({}, f, { mount:f.url.split("/").pop() }); });
    });
  },
  _airportList: function(){
    if (!this._airports){
      this._airports = fetchJSON(new URL("../data/airports.json", this.base).href, 20000).then(Finder.toAirports);
      this._airports.catch(function(){ this._airports = null; }.bind(this));
    }
    return this._airports;
  },
  _airportFeeds: function(icao){
    var self = this;
    return self._cached("la" + icao, 6 * 3600e3, function(){
      return self._get(LIVEATC + "/search/?icao=" + icao, 12000).then(Finder.parseLiveatcSearch);
    }).catch(function(){ return null; });
  },
  listen: function(p){
    var self = this;
    return self._airportList().then(function(airports){
      var near = Finder.nearestAirports(airports, p.lat, p.lon, 8, 200);
      if (!near.length){
        return { phase:null, feed:null, alternatives:[], airports:[],
          reason:"No airports within 200 NM, so there's no ATC radio to hear here (likely over the ocean)." };
      }
      var closest = near.reduce(function(a, b){ return b.dist_nm < a.dist_nm ? b : a; });
      var alt = p.alt === "ground" ? "ground" : (typeof p.alt === "number" ? p.alt : null);
      var phase = Finder.flightPhase(alt, p.gs || 0, closest.dist_nm, closest.elev_ft);
      return Promise.all(near.map(function(a){ return self._airportFeeds(a.icao); })).then(function(results){
        var ranked = Finder.choose(near.map(function(a, i){ return [a, results[i] || []]; }), phase);
        ranked.forEach(function(f){ f.id = "la-" + f.mount; });
        var unreachable = results.every(function(r){ return r === null; });
        var reason = ranked.length
          ? phase.charAt(0).toUpperCase() + phase.slice(1) + " phase, nearest airport " + closest.icao + " (" + Math.round(closest.dist_nm) + " NM)"
          : unreachable ? "Couldn't reach liveatc.net to look up frequencies. Try again in a moment."
          : "No volunteer is streaming ATC near this aircraft right now (checked " + near.slice(0, 5).map(function(a){ return a.icao; }).join(", ") + ").";
        return { phase:phase, feed:ranked[0] || null, alternatives:ranked.slice(1, 8), airports:near.map(function(a){ return a.icao; }), reason:reason };
      });
    });
  },
  transcripts: function(){ return null; },
  // Candidate stream URLs, best first. An https page can't play http audio.
  audioUrls: function(feed){
    var self = this, mount = feed.mount || feed.id.replace(/^la-/, "");
    var secure = location.protocol === "https:";
    var fallback = ["https://s1-fmt2.liveatc.net/" + mount, "https://d.liveatc.net/" + mount];
    if (!secure) fallback.push("http://d.liveatc.net/" + mount);
    return self._cached("pls" + mount, 6 * 3600e3, function(){
      return self._get(LIVEATC + "/play/" + mount + ".pls", 8000).then(Finder.parsePls);
    }).catch(function(){ return null; }).then(function(url){
      var list = [];
      if (url && /^https?:\/\/([a-z0-9-]+\.)*liveatc\.net\//i.test(url)){
        list.push(url.replace(/^http:/, secure ? "https:" : "http:"));
      }
      return list.concat(fallback.filter(function(u){ return list.indexOf(u) < 0; }));
    });
  }
};

/* ---------- pick a mode ---------- */
function detect(){
  var base = new URL(".", location.href).href;
  var forced = new URLSearchParams(location.search).get("mode");
  if (forced === "browser" || /\.github\.io$/.test(location.hostname) || location.protocol === "file:"){
    return Promise.resolve(new BrowserBackend(base));
  }
  return fetchJSON("/api/status", 2500).then(function(){ return new ServerBackend(); },
    function(){ return new BrowserBackend(base); });
}

window.Backend = { ready:detect(), AIRLINES:AIRLINES };
})();
