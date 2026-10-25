(function(){
"use strict";
var $ = function(id){ return document.getElementById(id); };

/* ---------------- airline badges ---------------- */
var AIRLINES = Backend.AIRLINES;
var api = null;  // set once Backend.ready resolves
function airlineOf(cs){
  var m = /^([A-Z]{3})\d/.exec(cs || "");
  if (!m) return null;
  var a = AIRLINES[m[1]];
  if (a) return { code:a[0], color:a[1] };
  var h = 0; for (var i = 0; i < 3; i++) h = h * 31 + m[1].charCodeAt(i);
  return { code:m[1], color:"hsl(" + (h % 360) + ",45%,38%)" };
}
function badgeHtml(cs){
  var a = airlineOf(cs);
  return a ? '<span class="badge" style="background:' + a.color + '">' + a.code + '</span>' : "";
}

var PLANE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 1.6c.85 0 1.35.75 1.35 1.7v6.2l8.1 4.75v2.05l-8.1-2.55v4.75l2.35 1.7v1.6L12 20.7l-3.7 1.1v-1.6l2.35-1.7v-4.75l-8.1 2.55V14.25l8.1-4.75V3.3c0-.95.5-1.7 1.35-1.7z"/></svg>';

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function ago(t){
  var s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function clock(t){ return new Date(t * 1000).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }); }
function toast(msg, ms){
  var el = $("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(function(){ el.classList.remove("show"); }, ms || 3500);
}

/* ---------------- state ---------------- */
var state = {
  planes: {},        // hex -> plane from /api/traffic
  markers: {},       // hex -> L.marker
  trails: {},        // hex -> [[lat,lon], ...] seen this session
  sel: null,         // selected hex
  selMsgs: [],       // ACARS messages for selected aircraft
  msgIdx: 0,
  route: null,
  mode: "map",
  atcMentions: {},   // callsign -> [{t,text}]
  talking: {},       // callsign -> ms timestamp of last ATC mention
  fresh: {}          // hex -> ms timestamp of last new ACARS message
};

/* ---------------- map ---------------- */
var saved = null;
try { saved = JSON.parse(localStorage.getItem("atc-view")); } catch(e){}
var map = L.map("map", { zoomControl:false, worldCopyJump:true, minZoom:3 })
  .setView(saved ? [saved.lat, saved.lon] : [38.2, -84.9], saved ? saved.z : 8);
// Basemap: Esri's dark grey canvas (no API key needed). If its tiles fail,
// fall back to OpenStreetMap, darkened with CSS.
var ADSB_CREDIT = " · ADS-B: adsb.fi / adsb.lol";
var ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
map.createPane("labels");
map.getPane("labels").style.zIndex = 350;          // above tiles, below routes and planes
map.getPane("labels").style.pointerEvents = "none";
var basemap = [
  L.tileLayer(ESRI + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom:16, maxZoom:19,
    attribution:'Tiles &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors' + ADSB_CREDIT
  }),
  L.tileLayer(ESRI + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxNativeZoom:16, maxZoom:19, pane:"labels" })
];
basemap.forEach(function(l){ l.addTo(map); });
var tileStats = { ok:0, bad:0 };
basemap[0].on("tileload", function(){ tileStats.ok++; });
basemap[0].on("tileerror", function(){
  if (++tileStats.bad < 6 || tileStats.ok > tileStats.bad || !basemap.length) return;
  basemap.forEach(function(l){ map.removeLayer(l); });
  basemap = [];
  document.body.classList.add("osm");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' + ADSB_CREDIT
  }).addTo(map);
});
var routeLayer = L.layerGroup().addTo(map);

map.on("moveend", function(){
  var c = map.getCenter();
  try { localStorage.setItem("atc-view", JSON.stringify({ lat:c.lat, lon:c.lng, z:map.getZoom() })); } catch(e){}
  pollTraffic();
});
map.on("click", function(){ if (state.mode === "map") deselect(); });

function viewRadiusNm(){
  var b = map.getBounds(), c = map.getCenter();
  return Math.ceil(c.distanceTo(b.getNorthEast()) / 1852);
}

var pollTimer = null, pollSeq = 0;
function pollTraffic(){
  if (!api) return;
  clearTimeout(pollTimer);
  var seq = ++pollSeq, c = map.getCenter(), dist = viewRadiusNm();
  api.traffic(c.lat, c.lng, Math.min(dist, 250))
    .then(function(res){
      if (seq !== pollSeq) return;
      $("mapNote").textContent = res.aircraft.length + " aircraft" + (dist > 250 ? " near the centre · zoom in to see all" : "");
      applyTraffic(res.aircraft);
    })
    .catch(function(){ if (seq === pollSeq) $("mapNote").textContent = "Aircraft feed unreachable, retrying…"; })
    .finally(function(){ if (seq === pollSeq) pollTimer = setTimeout(pollTraffic, 5000); });
}

function applyTraffic(list){
  var seen = {};
  list.forEach(function(p){
    if (!p.hex) return;
    seen[p.hex] = true;
    var prev = state.planes[p.hex];
    state.planes[p.hex] = p;
    var trail = state.trails[p.hex] || (state.trails[p.hex] = []);
    var last = trail[trail.length - 1];
    if (!last || last[0] !== p.lat || last[1] !== p.lon) trail.push([p.lat, p.lon]);
    if (trail.length > 400) trail.shift();
    if (prev && p.msgs > prev.msgs) state.fresh[p.hex] = Date.now();
    upsertMarker(p);
  });
  Object.keys(state.markers).forEach(function(hex){
    if (!seen[hex] && hex !== state.sel){ map.removeLayer(state.markers[hex]); delete state.markers[hex]; }
  });
  if (state.sel && state.planes[state.sel]){
    var p = state.planes[state.sel];
    if (p.msgs !== state.selCount){ state.selCount = p.msgs; loadSelMessages(false); }
    renderSheetSub();
    drawRoute();
    keepSelVisible();
  }
}

// Keep the selected aircraft in the strip of map above the flight sheet.
function keepSelVisible(){
  var p = state.planes[state.sel];
  if (!p || state.mode === "feed" || state.mode === "mcdu") return;
  var pt = map.latLngToContainerPoint([p.lat, p.lon]);
  var top = 120, bottom = window.innerHeight - $("sheet").offsetHeight - 30;
  if (bottom - top < 60) return;
  if (pt.y < top || pt.y > bottom || pt.x < 30 || pt.x > window.innerWidth - 30){
    map.panBy([pt.x - window.innerWidth / 2, pt.y - (top + bottom) / 2], { animate:true });
  }
}

function labelOf(p){ return p.callsign || p.reg || p.hex.toUpperCase(); }

function markerHtml(p){
  var label = labelOf(p);
  var badge = p.callsign ? badgeHtml(p.callsign) : "";
  return '<div class="ac-plane" style="transform:rotate(' + (p.track || 0) + 'deg)">' + PLANE_SVG + '</div>' +
    '<div class="ac-tag' + (badge ? "" : " noBadge") + '">' + badge + esc(label) +
    (p.crew ? '<span class="count" title="Crew messages">' + p.crew + '</span>'
      : p.msgs ? '<span class="count auto" title="Automated reports">' + p.msgs + '</span>' : '') + '</div>';
}
function markerClass(p){
  var cs = p.callsign, now = Date.now();
  return "ac" + (p.msgs ? "" : " quiet") + (state.sel === p.hex ? " sel" : "") +
    (state.fresh[p.hex] && now - state.fresh[p.hex] < 6000 ? " fresh" : "") +
    (cs && state.talking[cs] && now - state.talking[cs] < 30000 ? " talking" : "");
}
function upsertMarker(p){
  var m = state.markers[p.hex];
  var key = labelOf(p) + "|" + p.msgs + "|" + p.crew;
  if (!m){
    m = L.marker([p.lat, p.lon], { icon:L.divIcon({ className:"", html:"", iconSize:[0,0] }), keyboard:false });
    m.on("click", function(e){ L.DomEvent.stopPropagation(e); select(p.hex); });
    m.addTo(map);
    state.markers[p.hex] = m;
  } else {
    m.setLatLng([p.lat, p.lon]);
  }
  var el = m.getElement();
  if (!el) return;
  if (m._key !== key){ el.innerHTML = '<div class="ac">' + markerHtml(p) + '</div>'; m._key = key; }
  var ac = el.firstChild;
  ac.className = markerClass(p);
  ac.querySelector(".ac-plane").style.transform = "rotate(" + (p.track || 0) + "deg)";
  m.setZIndexOffset(state.sel === p.hex ? 10000 : p.msgs ? 1000 : 0);
}
function refreshMarker(hex){ var p = state.planes[hex]; if (p) upsertMarker(p); }

/* ---------------- selection + sheet ---------------- */
function select(hex){
  var prev = state.sel;
  state.sel = hex; state.selMsgs = []; state.msgIdx = 0; state.route = null;
  state.selCount = state.planes[hex].msgs;
  if (prev) refreshMarker(prev);
  refreshMarker(hex);
  var p = state.planes[hex];
  $("shCallsign").textContent = labelOf(p);
  var al = airlineOf(p.callsign);
  $("shBadge").textContent = al ? al.code : "";
  $("shBadge").style.background = al ? al.color : "";
  $("shRoute").textContent = "";
  renderSheetSub();
  renderQuote(true);
  renderAtcMentions();
  renderListen();
  $("sheet").classList.add("show");
  setModesEnabled();
  setTimeout(keepSelVisible, 380);  // after the sheet slides up
  loadSelMessages(true);
  if (p.callsign){
    api.route(p.callsign).then(function(r){
      if (state.sel !== hex) return;
      state.route = r;
      var o = r.origin && (r.origin.icao || r.origin.iata), d = r.destination && (r.destination.icao || r.destination.iata);
      $("shRoute").textContent = o && d ? o + " → " + d : "";
      drawRoute();
    }).catch(function(){});
  }
  drawRoute();
}
function deselect(){
  var prev = state.sel;
  stopReplay();
  state.sel = null; state.selMsgs = []; routeLayer.clearLayers();
  if (prev) refreshMarker(prev);
  $("sheet").classList.remove("show");
  setModesEnabled();
  if (state.mode !== "map" && state.mode !== "feed") setMode("map");
}
$("sheetClose").onclick = deselect;

function loadSelMessages(resetIdx){
  var p = state.planes[state.sel];
  if (!p) return;
  var hex = state.sel;
  api.aircraftMessages(p)
    .then(function(msgs){
      if (state.sel !== hex) return;
      var wasDefault = state.msgIdx === defaultIdx(state.selMsgs);
      state.selMsgs = msgs;
      if (replay) return;  // don't jump while a replay is typing
      if (resetIdx || wasDefault) state.msgIdx = defaultIdx(msgs);
      renderQuote(false);
      setModesEnabled();
      if (state.mode === "mcdu") renderMcdu();
    }).catch(function(){});
}

function renderSheetSub(){
  var p = state.planes[state.sel];
  if (!p) return;
  var bits = [];
  if (p.desc || p.type) bits.push(p.desc || p.type);
  if (p.reg && p.reg !== labelOf(p)) bits.push(p.reg);
  if (p.alt === "ground") bits.push("On ground");
  else if (typeof p.alt === "number") bits.push(p.alt >= 18000 ? "FL" + String(Math.round(p.alt / 100)).padStart(3, "0") : p.alt.toLocaleString() + " ft");
  if (p.gs) bits.push(Math.round(p.gs) + " kt");
  if (p.squawk) bits.push("Squawk " + p.squawk);
  $("shSub").textContent = bits.join(" · ");
}

// Show the newest crew-written message first; automated reports only if
// that's all the plane has sent.
function defaultIdx(msgs){
  for (var i = msgs.length - 1; i >= 0; i--) if (msgs[i].interesting) return i;
  return Math.max(0, msgs.length - 1);
}

// Plain-English name for an automated report.
var AUTO_KINDS = { "80":"Position report", "15":"Position report", "44":"Position report", "16":"Position report",
  "10":"Gate, takeoff & landing times", "11":"Gate, takeoff & landing times", "12":"Gate, takeoff & landing times",
  "QA":"Gate, takeoff & landing times", "QB":"Gate, takeoff & landing times", "QC":"Gate, takeoff & landing times", "QD":"Gate, takeoff & landing times",
  "H2":"Weather data", "SA":"Datalink system status", "Q0":"Datalink link test", "_d":"Datalink keep-alive", "5U":"Weather request",
  "B9":"Airport info (ATIS) request", "MA":"Encrypted airline data" };
function autoKind(m){
  var t = m.text.toUpperCase();
  if (/^POS|POSN/.test(t)) return "Position report";
  if (/METAR|TAF\b/.test(t)) return "Weather data";
  return AUTO_KINDS[m.label] || "Aircraft systems data (engines, brakes, fuel…)";
}

function renderQuote(loading, typed){
  var q = $("shQuote"), msgs = state.selMsgs, n = msgs.length;
  var crew = msgs.filter(function(m){ return m.interesting; }).length;
  $("shLbl").textContent = !n ? "ACARS pilot messages" :
    "ACARS messages · " + (crew ? crew + " from the crew" : "none from the crew yet") + " · " + (n - crew) + " automated";
  if (!n){
    q.className = "empty";
    q.textContent = loading ? "Loading messages…" : "No ACARS messages from this aircraft yet. New ones appear here live.";
    $("shTime").textContent = ""; $("shPos").textContent = "";
    $("shPrev").disabled = $("shNext").disabled = true;
    return;
  }
  var m = msgs[state.msgIdx];
  if (m.interesting){
    q.className = "";
    if (typed != null) q.innerHTML = esc("“" + m.text.slice(0, typed)) + '<span class="caret"></span>';
    else q.textContent = "“" + m.text + "”";
  } else {
    // machine-to-airline data: show it as data, not as something a pilot said
    q.className = "auto";
    q.innerHTML = '<span class="auto-tag">Automated report · ' + esc(autoKind(m)) + '<small>Sent by the aircraft’s computers, not typed by the crew</small></span>' +
      '<span class="auto-text">' + esc(typed != null ? m.text.slice(0, typed) : m.text) + '</span>';
  }
  $("shTime").textContent = clock(m.t) + " · " + ago(m.t) + (m.label ? " · label " + m.label : "") + (m.source === "airframes" ? " · via airframes.io" : m.source === "receiver" ? " · own receiver" : "");
  $("shPos").textContent = (state.msgIdx + 1) + " / " + n;
  $("shPrev").disabled = state.msgIdx === 0;
  $("shNext").disabled = state.msgIdx >= n - 1;
}
$("shPrev").onclick = function(){ stopReplay(); state.msgIdx--; renderQuote(); };
$("shNext").onclick = function(){ stopReplay(); state.msgIdx++; renderQuote(); };

function renderAtcMentions(){
  var p = state.planes[state.sel], el = $("shAtc");
  if (!p){ el.innerHTML = ""; return; }
  var mine = (p.callsign && state.atcMentions[p.callsign]) || [];
  var following = tuner.followHex === p.hex && tuner.feed;
  var rows = following ? (tuner.recent || []).slice(-4) : mine.slice(-4);
  var title = following ? "On frequency now" : "Heard on ATC radio";
  el.innerHTML = rows.length ? '<div class="lbl" style="margin-top:0">' + title + '</div>' + rows.map(function(r){
    var me = p.callsign && r.callsigns.indexOf(p.callsign) >= 0;
    return '<div class="row' + (me ? " me" : "") + '"><small>' + clock(r.t) + '</small>' +
      (r.speaker ? '<span class="tag ' + r.speaker + '">' + r.speaker + '</span> ' : '') + esc(r.text) + '</div>';
  }).join("") : (following ? '<div class="row"><small>Waiting for the next radio call…</small></div>' : "");
}

/* route line: origin -> where it has been -> aircraft -> destination */
function drawRoute(){
  routeLayer.clearLayers();
  var p = state.planes[state.sel];
  if (!p) return;
  var r = state.route, pts = [];
  if (r && r.origin && r.origin.lat != null) pts.push([r.origin.lat, r.origin.lon]);
  pts = pts.concat(state.trails[p.hex] || []);
  pts.push([p.lat, p.lon]);
  L.polyline(pts, { color:"#ff3b30", weight:4, opacity:.95, interactive:false }).addTo(routeLayer);
  if (r && r.destination && r.destination.lat != null){
    var dst = [r.destination.lat, r.destination.lon];
    L.polyline([[p.lat, p.lon], dst], { color:"#ff3b30", weight:3, opacity:.45, dashArray:"6 9", interactive:false }).addTo(routeLayer);
    L.marker(dst, { icon:L.divIcon({ className:"", html:'<div class="target"></div>', iconSize:[0,0] }), interactive:false }).addTo(routeLayer);
    L.marker(dst, { icon:L.divIcon({ className:"", html:'<div class="apt-label">' + esc(r.destination.icao || "") + " " + esc(r.destination.city || "") + '</div>', iconSize:[0,0] }), interactive:false }).addTo(routeLayer);
  }
  if (r && r.origin && r.origin.lat != null){
    L.marker([r.origin.lat, r.origin.lon], { icon:L.divIcon({ className:"", html:'<div class="apt-label">' + esc(r.origin.icao || "") + " " + esc(r.origin.city || "") + '</div>', iconSize:[0,0] }), interactive:false }).addTo(routeLayer);
  }
}

/* ---------------- modes ---------------- */
function setModesEnabled(){
  var has = !!(state.sel && state.selMsgs.length);
  document.querySelector('[data-mode=replay]').disabled = !has;
  document.querySelector('[data-mode=mcdu]').disabled = !has;
}
document.querySelectorAll("#modes button").forEach(function(b){
  b.onclick = function(){ mcdu.fromFeed = false; setMode(b.getAttribute("data-mode")); };
});
function setMode(mode){
  state.mode = mode;
  document.querySelectorAll("#modes button").forEach(function(b){ b.classList.toggle("on", b.getAttribute("data-mode") === mode); });
  $("feed").classList.toggle("show", mode === "feed");
  $("mcdu").classList.toggle("show", mode === "mcdu");
  $("searchBox").style.display = mode === "map" ? "" : "none";
  if (mode !== "replay") stopReplay();
  if (mode === "feed") loadFeed();
  if (mode === "mcdu") renderMcdu();
  if (mode === "replay") startReplay();
}

/* Replay: fly to the aircraft and type out each of its messages in turn */
var replay = null;
function startReplay(){
  stopReplay();
  var p = state.planes[state.sel];
  if (!p || !state.selMsgs.length) return setMode("map");
  map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 9), { duration:1 });
  state.msgIdx = 0;
  var chars = 0;
  replay = setInterval(function(){
    var m = state.selMsgs[state.msgIdx];
    if (!m) return stopReplay();
    chars += 3;
    if (chars <= m.text.length){ renderQuote(false, chars); return; }
    renderQuote();
    if (chars > m.text.length + 120){  // hold the finished message ~4 s
      if (state.msgIdx >= state.selMsgs.length - 1){ stopReplay(); setMode("map"); return; }
      state.msgIdx++; chars = 0;
    }
  }, 33);
}
function stopReplay(){ if (replay){ clearInterval(replay); replay = null; renderQuote(); } }

/* ---------------- MCDU ---------------- */
var LABEL_TITLES = { H1:"CREW MESSAGE", C1:"FREE TEXT", AA:"FREE TEXT", "5Z":"AIRLINE MSG", SA:"MEDIA ADVISORY",
  "80":"POSITION RPT", "10":"OOOI", "15":"POSITION RPT", "44":"POSITION RPT", RA:"UPLINK MSG", H2:"WEATHER" };
var COLS = 24, BODY_ROWS = 9;
var mcdu = { msg:null, page:0, pages:1, fromFeed:false };

function wrap(text, cols){
  var out = [], line = "";
  String(text).toUpperCase().replace(/\s+/g, " ").trim().split(" ").forEach(function(w){
    while (w.length > cols){ if (line){ out.push(line); line = ""; } out.push(w.slice(0, cols)); w = w.slice(cols); }
    if (!w) return;
    if ((line ? line.length + 1 : 0) + w.length > cols){ out.push(line); line = w; }
    else line = line ? line + " " + w : w;
  });
  if (line) out.push(line);
  return out;
}
function openMcdu(msg){ mcdu.msg = msg; mcdu.page = 0; mcdu.fromFeed = true; setMode("mcdu"); }
function renderMcdu(){
  if (state.mode !== "mcdu") return;
  var m = mcdu.fromFeed ? mcdu.msg : state.selMsgs[state.msgIdx];
  if (!m) return setMode("map");
  if (m !== mcdu.msg){ mcdu.msg = m; mcdu.page = 0; }
  var lines = wrap(m.text, COLS), pages = Math.max(1, Math.ceil(lines.length / BODY_ROWS));
  mcdu.page = Math.min(mcdu.page, pages - 1);
  var title = m.callsign || m.flight || m.reg || "ACARS";
  var p = state.planes[state.sel];
  var route = state.route && state.route.origin && state.route.destination && p && (p.callsign === m.callsign)
    ? (state.route.origin.icao || "") + "/" + (state.route.destination.icao || "") : (m.reg || "");
  var kind = m.interesting ? (LABEL_TITLES[m.label] === "FREE TEXT" ? "FREE TEXT" : "CREW MESSAGE") : (LABEL_TITLES[m.label] || "ACARS MSG");
  var body = lines.slice(mcdu.page * BODY_ROWS, (mcdu.page + 1) * BODY_ROWS);
  var html = [];
  html.push('<div class="ln" style="justify-content:center"><span class="w">' + esc(title) + '</span></div>');
  html.push('<div class="ln s"><span class="a">' + esc(kind) + '</span><span class="a">' + esc(route) + '</span></div>');
  for (var i = 0; i < BODY_ROWS; i++) html.push('<div class="ln">' + esc(body[i] || "") + '</div>');
  var d = new Date(m.t * 1000), zulu = String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
  html.push('<div class="ln s"><span class="w">' + zulu + '</span><span class="w">' + esc(ago(m.t).toUpperCase()) + '</span></div>');
  html.push('<div class="ln">' + "-".repeat(COLS) + '</div>');
  html.push('<div class="ln"><span class="c" id="mcduReturn">&lt;RETURN</span><span class="c">' + (mcdu.page + 1) + "/" + pages + '</span></div>');
  var scr = $("mcduScreen");
  scr.innerHTML = html.join("");
  $("mcduReturn").onclick = mcduReturn;
  mcdu.pages = pages;
  sizeMcdu();
}
function sizeMcdu(){
  var scr = $("mcduScreen");
  if (!scr.clientWidth) return;
  var inner = scr.clientWidth * 0.93;
  scr.style.fontSize = (inner / COLS / 0.602) + "px";  // monospace glyph ≈ 0.6em wide
}
window.addEventListener("resize", sizeMcdu);
function mcduReturn(){ setMode(mcdu.fromFeed ? "feed" : "map"); }
function mcduPage(d){ var n = mcdu.page + d; if (n >= 0 && n < mcdu.pages){ mcdu.page = n; renderMcdu(); } }
function mcduMsg(d){
  if (mcdu.fromFeed){  // step through the feed, which is newest first
    var i = feedMsgs.indexOf(mcdu.msg) - d;
    if (i >= 0 && i < feedMsgs.length){ mcdu.msg = feedMsgs[i]; mcdu.page = 0; renderMcdu(); }
    return;
  }
  var n = state.msgIdx + d;
  if (n >= 0 && n < state.selMsgs.length){ state.msgIdx = n; renderQuote(); renderMcdu(); }
}
(function buildKeys(){
  var fn = [["DIR"],["PROG"],["PERF"],["INIT"],["DATA"],["BRT"],
            ["F-PLN"],["RAD NAV"],["FUEL PRED"],["SEC F-PLN"],["ATC COMM"],["MCDU MENU"],
            ["AIR PORT"],["←","prev"],["→","next"],["↑","up"],["↓","down"],["DIM"]];
  var html = fn.map(function(k){
    return '<div class="k"' + (k[1] ? ' data-act="' + k[1] + '"' : "") + '>' + k[0] + '</div>';
  }).join("");
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ/".split("").concat(["SP","CLR"]).forEach(function(c){ html += '<div class="k alpha">' + c + '</div>'; });
  "123456789.0".split("").concat(["+/-"]).forEach(function(c){ html += '<div class="k round">' + c + '</div>'; });
  $("mcduKeys").innerHTML = html;
  $("mcduKeys").addEventListener("click", function(e){
    var act = e.target.getAttribute("data-act");
    if (act === "prev") mcduMsg(-1);
    if (act === "next") mcduMsg(1);
    if (act === "up") mcduPage(-1);
    if (act === "down") mcduPage(1);
  });
  document.querySelector('.lsk[data-act=return]').onclick = mcduReturn;
})();
document.addEventListener("keydown", function(e){
  if (state.mode !== "mcdu") return;
  if (e.key === "Escape") mcduReturn();
  if (e.key === "ArrowLeft") mcduMsg(-1);
  if (e.key === "ArrowRight") mcduMsg(1);
  if (e.key === "ArrowUp") mcduPage(-1);
  if (e.key === "ArrowDown") mcduPage(1);
});

/* ---------------- pilot messages feed ---------------- */
var feedFilter = "crew", feedQuery = "", feedMsgs = [];
document.querySelectorAll(".chips button").forEach(function(b){
  b.onclick = function(){
    feedFilter = b.getAttribute("data-f");
    document.querySelectorAll(".chips button").forEach(function(x){ x.classList.toggle("on", x === b); });
    loadFeed();
  };
});
var feedSearchT = null;
$("feedSearch").oninput = function(){ clearTimeout(feedSearchT); var v = this.value; feedSearchT = setTimeout(function(){ feedQuery = v; loadFeed(); }, 250); };
$("feedSearchBox").onsubmit = function(e){ e.preventDefault(); };

var sourceStatus = null;
function loadFeed(){
  Promise.all([
    api.messages(feedQuery, feedFilter === "all"),
    api.status().catch(function(){ return null; })
  ]).then(function(res){
    feedMsgs = res[0]; sourceStatus = res[1];
    renderFeed();
  }).catch(function(){ $("cards").innerHTML = '<div class="empty-state">Could not reach the server.</div>'; });
}
function renderFeed(){
  var el = $("cards");
  if (!feedMsgs.length){
    var s = sourceStatus, help;
    if (s && s.mode === "browser"){
      help = "Pilot messages (ACARS) need the ATC Live server, which collects them from airframes.io or your own receiver. " +
        "This web version shows live aircraft and plays live ATC audio.<br><br>To get messages, run the app on a computer: see the README.";
    } else if (s && !s.messages){
      help = "No ACARS source is connected yet.<br><br>Set <code>AIRFRAMES_API_KEY</code> to pull messages from the airframes.io network, " +
        "or point acarsdec / dumpvdl2 / acars_router at <code>udp/" + (s.receiver.udp_port || 5550) + "</code>." +
        (s.airframes.status === "error" ? "<br><br>airframes.io error: " + esc(s.airframes.error) : "");
    } else {
      help = feedQuery ? "No messages match “" + esc(feedQuery) + "”." : "No crew-written messages yet. Automated reports are under “Everything”.";
    }
    el.innerHTML = '<div class="empty-state">' + help + '</div>';
    return;
  }
  el.innerHTML = feedMsgs.map(cardHtml).join("");
  feedMsgs.forEach(function(m){ if (m.hex) loadPhoto(m.hex); });
}
function cardHtml(m){
  var cs = m.callsign || m.flight || m.reg || "Unknown";
  var title = m.headline || (m.interesting ? "Crew message" : (LABEL_TITLES[m.label] || "ACARS message").toLowerCase().replace(/^./, function(c){ return c.toUpperCase(); }));
  return '<article class="card" data-id="' + esc(m.id) + '">' +
    '<div class="row1"><span class="cs">' + badgeHtml(m.callsign) + esc(cs) + '</span><span>' + ago(m.t) + '</span></div>' +
    '<h3>' + esc(title) + '</h3>' +
    '<div class="snippet">' + esc(m.text) + '</div>' +
    '<div class="photo" data-hex="' + esc(m.hex || "") + '">' + PLANE_SVG + '</div>' +
    '<div class="open"><span>Open message</span><span>›</span></div></article>';
}
var photos = {};
function loadPhoto(hex){
  if (photos[hex] === undefined){
    photos[hex] = api.photo(hex).catch(function(){ return null; });
  }
  photos[hex].then(function(ph){
    if (!ph || !ph.src) return;
    document.querySelectorAll('.photo[data-hex="' + hex + '"]').forEach(function(el){
      if (el.dataset.loaded) return;
      el.dataset.loaded = 1;
      el.style.backgroundImage = 'url("' + ph.src.replace(/"/g, "") + '")';
      el.innerHTML = ph.photographer ? '<span class="credit">© ' + esc(ph.photographer) + ' · planespotters.net</span>' : "";
    });
  });
}
$("cards").addEventListener("click", function(e){
  var card = e.target.closest(".card");
  if (!card) return;
  var m = feedMsgs.filter(function(x){ return x.id === card.getAttribute("data-id"); })[0];
  if (!m) return;
  var p = findPlaneFor(m);
  if (p){ map.setView([p.lat, p.lon], Math.max(map.getZoom(), 8)); select(p.hex); }
  openMcdu(m);
});
function findPlaneFor(m){
  return Object.values(state.planes).filter(function(p){
    return (m.hex && p.hex === m.hex) || (m.reg && p.reg && p.reg.toUpperCase() === m.reg) || (m.callsign && p.callsign === m.callsign);
  })[0] || null;
}

/* live: new ACARS messages */
function onLiveMessage(m){
    var p = findPlaneFor(m);
    if (p){ state.fresh[p.hex] = Date.now(); }
    if (p && p.hex === state.sel) loadSelMessages(false);
    if (state.mode === "feed" && !feedQuery){
      var i = feedMsgs.findIndex(function(x){ return x.id === m.id; });
      if (i >= 0) feedMsgs[i] = m;
      else if (feedFilter === "all" || m.interesting) feedMsgs.unshift(m);
      renderFeed();
    }
}

/* ---------------- map search ---------------- */
$("searchBox").onsubmit = function(e){
  e.preventDefault();
  var q = $("search").value.trim().toUpperCase().replace(/\s+/g, "");
  if (!q) return;
  var local = Object.values(state.planes).filter(function(p){
    return p.callsign === q || (p.reg || "").toUpperCase() === q || p.hex.toUpperCase() === q;
  })[0];
  if (local){ map.setView([local.lat, local.lon], Math.max(map.getZoom(), 9)); select(local.hex); return; }
  toast("Searching for " + q + "…");
  api.search(q).then(function(res){
    var p = res.aircraft[0];
    if (!p){ toast("No aircraft “" + q + "” is in the air right now."); return; }
    toast(labelOf(p) + " found", 1500);
    state.planes[p.hex] = p; upsertMarker(p);
    map.setView([p.lat, p.lon], 9);
    select(p.hex);
  }).catch(function(){ toast("Search failed. Is the server online?"); });
};

/* ---------------- ATC radio ---------------- */
// One tuner shared by the radio drawer and "Listen to this plane".
var audio = $("audio"), radioFeeds = [];
var tuner = { feed:null, es:null, followHex:null, manual:false, pending:null, timer:null };

$("radioBtn").onclick = function(){ $("radio").classList.add("show"); };
$("radioClose").onclick = function(){ $("radio").classList.remove("show"); };
function renderFeedSel(){
  var opts = radioFeeds.slice();
  if (tuner.feed && !opts.some(function(f){ return f.id === tuner.feed.id; })) opts.unshift(tuner.feed);
  $("feedSel").innerHTML = '<option value="">Choose a frequency…</option>' + opts.map(function(f){
    return '<option value="' + esc(f.id) + '"' + (tuner.feed && tuner.feed.id === f.id ? " selected" : "") + '>' +
      esc((f.airport ? f.airport + " · " : "") + f.name) + '</option>';
  }).join("");
}
$("feedSel").onchange = function(){
  var id = this.value, f = radioFeeds.filter(function(x){ return x.id === id; })[0];
  stopFollowing();
  if (!f){ tune(null); return; }
  map.setView([f.lat, f.lon], Math.max(map.getZoom(), 9));
  tune(f, { play:!audio.paused });
};

function tune(feed, opts){
  opts = opts || {};
  if (tuner.es){ tuner.es.close(); tuner.es = null; }
  var wasPlaying = !audio.paused;
  stopAudio();
  $("radioLog").innerHTML = "";
  tuner.feed = feed; tuner.recent = [];
  renderFeedSel();
  renderListen();
  if (!feed){ $("radioStatus").textContent = "Pick a frequency"; return; }
  $("radioStatus").textContent = "Connecting to " + feed.name + "…";
  var es = tuner.es = api.transcripts(feed);
  if (!es){
    $("radioStatus").textContent = feed.name + " · audio only (live transcripts need the ATC Live server)";
    if (opts.play || (opts.keepPlaying && wasPlaying)) playAudio();
    return;
  }
  es.addEventListener("status", function(e){
    var s = JSON.parse(e.data).status;
    $("radioStatus").textContent = s === "live" ? "Live · " + feed.name + " · transcribing every call" : s.charAt(0).toUpperCase() + s.slice(1) + "…";
  });
  es.addEventListener("error", function(e){ if (e.data) $("radioStatus").textContent = "Feed problem: " + JSON.parse(e.data).message.slice(0, 80); });
  es.addEventListener("message", function(e){ if (tuner.es === es) addRadioLine(JSON.parse(e.data)); });
  if (opts.play || (opts.keepPlaying && wasPlaying)) playAudio();
}

// Plays the first candidate URL that works (browser mode may have several).
function playAudio(){
  var feed = tuner.feed;
  if (!feed){ toast("Choose a frequency first."); return; }
  api.audioUrls(feed).then(function(urls){
    if (tuner.feed !== feed) return;
    tuner.urls = urls; tuner.urlIdx = 0;
    startUrl();
  });
}
function startUrl(){
  audio.src = tuner.urls[tuner.urlIdx];
  audio.play().then(function(){
    $("listen").textContent = "■ Stop"; $("listen").classList.add("on"); $("radioBtn").classList.add("live");
    renderListen();
  }).catch(function(e){
    if (e && e.name === "NotAllowedError"){ toast("Tap Listen again to start audio."); stopAudio(); }
    // other failures surface as an "error" event, handled below
  });
}
function stopAudio(){
  audio.pause(); audio.removeAttribute("src"); audio.load();
  $("listen").textContent = "▶ Listen"; $("listen").classList.remove("on"); $("radioBtn").classList.remove("live");
  renderListen();
}
$("listen").onclick = function(){ if (!audio.paused) stopAudio(); else playAudio(); };
audio.addEventListener("error", function(){
  if (!audio.getAttribute("src") || !tuner.urls) return;
  if (tuner.urlIdx < tuner.urls.length - 1){ tuner.urlIdx++; startUrl(); return; }
  if (audio.played.length === 0){  // nothing ever played: the feed is unreachable
    toast("This frequency's audio isn't available right now. Try another from the list.");
    stopAudio(); return;
  }
  toast("Lost the audio stream, reconnecting…");
  setTimeout(function(){ if (tuner.feed && audio.getAttribute("src")) playAudio(); }, 3000);
});

function addRadioLine(m){
  var log = $("radioLog");
  var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  var el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = '<div class="meta">' + clock(m.t) + (m.speaker ? ' <span class="tag ' + m.speaker + '">' + m.speaker + '</span>' : '') +
    m.callsigns.map(function(cs){ return ' <button class="cs-chip" data-cs="' + esc(cs) + '">' + esc(cs) + '</button>'; }).join("") +
    '</div>' + esc(m.text);
  log.appendChild(el);
  while (log.children.length > 200) log.removeChild(log.firstChild);
  if (atBottom) log.scrollTop = log.scrollHeight;
  tuner.recent = (tuner.recent || []).concat([m]).slice(-20);
  m.callsigns.forEach(function(cs){
    state.talking[cs] = Date.now();
    (state.atcMentions[cs] = state.atcMentions[cs] || []).push(m);
    var p = Object.values(state.planes).filter(function(x){ return x.callsign === cs; })[0];
    if (p) refreshMarker(p.hex);
  });
  renderAtcMentions();
}
$("radioLog").addEventListener("click", function(e){
  var cs = e.target.getAttribute && e.target.getAttribute("data-cs");
  if (!cs) return;
  var p = Object.values(state.planes).filter(function(x){ return x.callsign === cs; })[0];
  if (p){ map.setView([p.lat, p.lon]); select(p.hex); } else toast(cs + " isn't on the map right now.");
});

/* "Listen to this plane": find its frequency, play it, follow it as it flies */
function findFrequency(p){
  return api.listen(p);
}
function listenToPlane(hex){
  var p = state.planes[hex];
  if (!p) return;
  if (tuner.followHex === hex && !audio.paused){ stopFollowing(); stopAudio(); return; }
  $("lpBtn").disabled = true;
  setNote(hex, "Finding the frequency " + labelOf(p) + " is on…");
  findFrequency(p).then(function(r){
    $("lpBtn").disabled = false;
    if (!r.feed){ setNote(hex, r.reason); return; }
    tuner.choices = [r.feed].concat(r.alternatives);
    tuner.note = null;
    tuner.followHex = hex; tuner.manual = false; tuner.pending = null; tuner.reason = r.reason;
    tune(r.feed, { play:true });
    clearInterval(tuner.timer);
    tuner.timer = setInterval(followTick, 45000);
  }).catch(function(){
    $("lpBtn").disabled = false;
    setNote(hex, "Couldn't look up frequencies. Is the server online?");
  });
}
// Re-check as the plane flies; switch after two checks agree (avoids flapping).
function followTick(){
  var p = state.planes[tuner.followHex];
  if (!p || tuner.manual) return;
  findFrequency(p).then(function(r){
    if (!r.feed || !tuner.feed || r.feed.id === tuner.feed.id){ tuner.pending = null; return; }
    if (tuner.pending !== r.feed.id){ tuner.pending = r.feed.id; return; }
    tuner.pending = null; tuner.choices = [r.feed].concat(r.alternatives); tuner.reason = r.reason;
    toast(labelOf(p) + " handed off → " + r.feed.name);
    tune(r.feed, { keepPlaying:true });
  }).catch(function(){});
}
function setNote(hex, text){ tuner.note = { hex:hex, text:text }; renderListen(); }
function stopFollowing(){ tuner.followHex = null; clearInterval(tuner.timer); tuner.timer = null; renderListen(); }
$("lpBtn").onclick = function(){ if (state.sel) listenToPlane(state.sel); };
$("lpAlt").onchange = function(){
  var id = this.value, f = (tuner.choices || []).filter(function(x){ return x.id === id; })[0];
  if (!f) return;
  tuner.manual = true;
  tune(f, { play:true });
};

function renderListen(){
  var btn = $("lpBtn"), info = $("lpInfo"), alt = $("lpAlt");
  if (!btn) return;
  var mine = state.sel && tuner.followHex === state.sel && tuner.feed;
  var playing = !audio.paused;
  btn.classList.toggle("on", !!(mine && playing));
  btn.innerHTML = mine && playing ? "■ Stop listening" : "🎧 Listen to this plane";
  if (mine){
    var f = tuner.feed;
    info.innerHTML = (playing ? "Hearing " : "Tuned to ") + "<b>" + esc(f.name) + "</b>" +
      (f.freqs && f.freqs.length ? " · " + esc(f.freqs.slice(0, 3).join(" / ")) : "") +
      (f.airport ? " · via " + esc(f.airport) + (f.dist_nm != null ? " (" + Math.round(f.dist_nm) + " NM)" : "") : "") +
      "<br><small>" + (tuner.manual ? "Frequency picked by you" : "Auto-follow on: switches frequency as the plane is handed off") + "</small>";
    var choices = tuner.choices || [];
    alt.style.display = choices.length > 1 ? "" : "none";
    alt.innerHTML = choices.map(function(c){
      return '<option value="' + esc(c.id) + '"' + (c.id === f.id ? " selected" : "") + '>' + esc(c.airport + " · " + c.name) + '</option>';
    }).join("");
  } else {
    info.textContent = tuner.note && tuner.note.hex === state.sel ? tuner.note.text : "";
    alt.style.display = "none";
  }
}

Backend.ready.then(function(backend){
  api = backend;
  document.body.classList.add("mode-" + api.mode);
  pollTraffic();
  api.feeds().then(function(feeds){ radioFeeds = feeds; renderFeedSel(); }).catch(function(){});
  api.messageStream(onLiveMessage);
});
})();
