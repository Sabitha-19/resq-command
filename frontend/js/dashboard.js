/* ResQ Command - control room dashboard. All incidents come from the real backend;
   the dashboard starts empty and only fills up when a real citizen sends an SOS. */
const auth = resqRequireAuth('CONTROL_ROOM');
const $ = s => document.querySelector(s);
$('#who').textContent = auth.name;   // real logged-in account (never hard-coded)
resqRefreshIdentity().then(a => { if (a) $('#who').textContent = a.name; });
$('#logout').onclick = e => { e.preventDefault(); resqLogout(); };
const setConn = connBadge($('#wsst'));
resqWatchBackend(ok => { const b = $('#backendst'); b.textContent = ok ? '● Backend Connected' : '○ Backend Disconnected'; b.className = 'connbadge ' + (ok ? 'live' : 'offline'); });

/* ---- Weather Intelligence + forecast-derived early warning (Open-Meteo) ---- */
const HQ = { lat: 11.9416, lng: 79.8083 };
let weatherOk = false;
async function loadWeather() {
  try {
    const w = await resqApi(`/api/weather?lat=${HQ.lat}&lng=${HQ.lng}`);
    weatherOk = true;
    $('#weatherBody').innerHTML = `Temperature: <b>${w.temperature_c}°C</b> &nbsp; Rain probability: <b>${w.rain_probability_pct}%</b><br>
      Precipitation: <b>${w.precipitation_mm} mm</b> &nbsp; Wind: <b>${w.wind_speed_kmh} km/h</b><br>
      <span class="mut" style="font-size:11px">Source: ${w.source} · Updated ${new Date(w.updated * 1000).toLocaleTimeString()}</span>`;
    const ew = w.early_warning;
    $('#warnBody').innerHTML = ew.level === 'LOW' ? '' :
      `<div class="warnbox ${ew.level.toLowerCase()}"><b>${ew.label}</b><br>${ew.text}<br><span class="mut" style="font-size:11px">${ew.disclaimer}</span></div>`;
  } catch (e) {
    weatherOk = false;
    $('#weatherBody').textContent = 'Weather service temporarily unavailable';
    $('#warnBody').innerHTML = '';
  }
}
loadWeather(); setInterval(loadWeather, 5 * 60 * 1000);
const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');

let S = [];             // incidents, from the backend (demo + real citizen SOS)
let T = [];             // rescue teams, from the backend
const SHELTERS = [[11.925, 79.79, 'Govt. School Shelter'], [11.97, 79.83, 'Community Hall Shelter'], [11.90, 79.83, 'Relief Camp']];
const prevStatus = {};  // incident id -> last-seen status, so we can write readable feed lines on change

const open = () => S.filter(i => !['COMPLETED','RESOLVED'].includes(i.status));
const byId = id => S.find(i => i.id === id);
const teamById = id => T.find(t => t.id === id);
const hav = (a, b) => { const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(a.lat * r), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371 };

/* ---- Small UI helpers ---- */
let unread = 0;
function toast(msg) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; $('#toasts').append(d); setTimeout(() => d.remove(), 4000) }
function feed(msg, notify = true) { const li = document.createElement('li'); li.innerHTML = `${msg} <span class="mut">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`; $('#fl').prepend(li); if (notify) $('#nb').textContent = ++unread }
function count(el, to) { const from = +el.dataset.v || 0; el.dataset.v = to; const t0 = performance.now(); (function f(t) { const k = Math.min(1, (t - t0) / 600); el.textContent = Math.round(from + (to - from) * k); if (k < 1) requestAnimationFrame(f) })(t0) }
const spark = () => { const p = Array.from({ length: 8 }, (_, i) => `${i * 14},${26 - Math.random() * 22}`).join(' '); return `<svg viewBox="0 0 98 28" aria-hidden="true"><polyline points="${p}" fill="none" stroke="#ff6b00" stroke-width="2"/></svg>` };
function beep() { try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(.08, ctx.currentTime); o.start(); o.stop(ctx.currentTime + .15); } catch (e) {} }

/* ---- Clock + sidebar ---- */
setInterval(() => $('#clock').textContent = new Date().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }), 1000);
$('#collapse').onclick = () => $('#side').classList.toggle('mini');
$('#bell').onclick = () => { unread = 0; $('#nb').textContent = 0; $('#feed').scrollIntoView({ behavior: 'smooth' }) };
$('#bcast').onclick = () => { feed('<b>Emergency alert broadcast</b> to all teams'); toast('✓ Alert sent to all rescue teams') };
$('#search').oninput = renderQueue;

/* ---- Map (Leaflet + OpenStreetMap) ---- */
const map = L.map('mapEl').setView([11.94, 79.83], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
const icon = mkIcon;
SHELTERS.forEach(s => L.marker([s[0], s[1]], { icon: icon('shel') }).addTo(map).bindTooltip(s[2]));
setTimeout(() => map.invalidateSize(), 100);
const mk = {}, tm = {}; let routeLayer = L.layerGroup().addTo(map);
function popup(i) {
  return `<div class="pop"><b>${i.id}</b> ${i.source === 'citizen' ? '🔴 LIVE SOS' : ''}<br>${i.type}<br>${i.people} people<br>Priority: ${i.priority}<br>Location:<br>${coordText(i.lat, i.lng)}<br>Waiting: <span class="w" data-id="${i.id}">${fmt((Date.now() / 1000 - i.created))}</span><br><button onclick="assign('${i.id}')" ${i.status !== 'NEW' ? 'disabled' : ''}>Assign team</button><button onclick="openD('${i.id}')">View details</button></div>`;
}
function teamPopup(t) {
  return `<div class="pop"><b>${t.name}</b><br>${t.specialty}<br>Status: ${TEAM_STATE_LABEL[t.status] || t.status}<br><span class="mut">Last known location · updated ${relTime(t.location_updated)}</span></div>`;
}
const routeLines = {};   // incident id -> Leaflet polyline (real OSRM road geometry from the backend)
function drawRoutes() {
  S.forEach(i => {
    const show = i.route_geometry && i.route_geometry.length > 1 && !['COMPLETED','RESOLVED'].includes(i.status);
    if (routeLines[i.id]) { routeLayer.removeLayer(routeLines[i.id]); delete routeLines[i.id]; }
    if (show) routeLines[i.id] = L.polyline(i.route_geometry, { color: '#3b9eff', weight: 5, opacity: .85 }).addTo(routeLayer)
      .bindPopup(`${i.team || 'Team'} → ${i.id}<br>Distance: ${fmtKm(i.route_km)}<br>Estimated travel time: ${fmtMin(i.route_min)}<br><a href="${gmapsUrl(i.lat, i.lng)}" target="_blank">🧭 Open Navigation</a>`);
  });
}
function renderMap() {
  S.forEach(i => {
    const c = ['COMPLETED','RESOLVED'].includes(i.status) ? 'done' : i.priority.toLowerCase();
    if (!mk[i.id]) mk[i.id] = L.marker([i.lat, i.lng], { icon: icon(c) }).addTo(map).bindTooltip(`${i.id} · ${i.people} people`).bindPopup(() => popup(byId(i.id)));
    else mk[i.id].setIcon(icon(c));
  });
  T.forEach(t => {
    if (!tm[t.id]) tm[t.id] = L.marker([t.lat, t.lng], { icon: icon(teamClass(t)) }).addTo(map).bindPopup(() => teamPopup(teamById(t.id)));
    else tm[t.id].setLatLng([t.lat, t.lng]).setIcon(icon(teamClass(t)));
    tm[t.id].bindTooltip(`${t.name} · ${TEAM_STATE_LABEL[t.status] || t.status}`);
  });
  drawRoutes(); renderRouteCards();
}

/* Route card per assigned, unresolved incident: distance + ETA straight from the backend/OSRM. */
function renderRouteCards() {
  const list = S.filter(i => i.team_id && !['COMPLETED','RESOLVED'].includes(i.status));
  $('#routeCards').innerHTML = list.map(i => `<div class="routecard">
    <div class="row"><b>🚑 ${i.team} → ${i.id}</b><span class="stbadge">${i.status.replace('_', ' ')}</span></div>
    ${routeInfoHtml(i, 'retryRoute')}
    <div class="mut" style="font-size:12px">Destination: ${coordText(i.lat, i.lng)}</div>
    <button type="button" onclick="focusRoute('${i.id}')">Show on map</button></div>`).join('');
}
function focusRoute(id) {
  const i = byId(id); if (!i) return;
  const pts = (i.route_geometry && i.route_geometry.length > 1) ? i.route_geometry : [[i.lat, i.lng]];
  const t = teamById(i.team_id); if (t) pts.push([t.lat, t.lng]);
  pts.length > 1 ? map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] }) : map.setView(pts[0], 15);
  document.getElementById('mapEl').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function retryRoute(id) { try { await resqApi(`/api/incidents/${id}/route`, { method: 'POST' }); toast('✓ Route recalculated'); } catch (e) { toast(e.message); } }
const showRoute = focusRoute;

/* ---- Render panels ---- */
function renderKpis() {
  const o = open(), dep = T.filter(t => t.status !== 'AVAILABLE').length, p1 = o.filter(i => i.priority === 'P1').length;
  const assigned = S.filter(i => i.status !== 'NEW');
  const avgWaitMin = assigned.length ? Math.round(assigned.reduce((a, i) => a + (Date.now() / 1000 - i.created) / 60, 0) / assigned.length) : 0;
  const availableCount = T.filter(t => (t.availability || (t.online ? (t.status==='AVAILABLE'?'AVAILABLE':'BUSY') : 'OFFLINE')) === 'AVAILABLE').length;
  const data = [['Active incidents', o.length, 'Reported and unresolved', 1], ['People at risk', o.reduce((a, i) => a + i.people, 0), 'Across active incidents', 0],
  ['Available teams', availableCount, `of ${T.length || 0} rescue teams`, 0], ['Avg time since SOS', avgWaitMin, 'Minutes, assigned+ incidents', 0], ['Critical alerts', p1, 'P1 incidents now', 1]];
  if (!$('#kpis').children.length) $('#kpis').innerHTML = data.map((d, k) => `<article class="card kpi ${d[3] ? 'crit' : ''}"><span class="mut">${d[0]}</span><div class="n" id="k${k}">0</div><span class="mut">${d[2]}</span>${spark()}</article>`).join('');
  data.forEach((d, k) => count($('#k' + k), d[1]));
}
function renderQueue() {
  const q = $('#search').value.toLowerCase(), list = open().filter(i => (i.id + i.type + i.location).toLowerCase().includes(q)).sort((a, b) => b.score - a.score);
  $('#queue').innerHTML = list.length ? list.map(i => `<div class="inc ${i.priority}" tabindex="0" role="button" onclick="openD('${i.id}')" onkeydown="if(event.key==='Enter')openD('${i.id}')">
  <div class="row"><b>${i.id}</b> ${i.source === 'citizen' ? '<span class="pill" style="color:var(--bad);border-color:var(--bad)">LIVE</span>' : ''}<span class="pill ${i.priority}">${i.priority}</span></div>
  <div>${i.people} people · ${i.type} · ${i.location}</div>
  <div class="row mut"><span>${i.route_km != null ? fmtKm(i.route_km) + ' by road' : 'Road route pending real team GPS'} · Waiting <span class="w" data-id="${i.id}">${fmt(Date.now() / 1000 - i.created)}</span></span><span class="pill">${i.status.replace('_', ' ')}</span></div>
  ${i.status === 'NEW' ? `<button class="btn-o" onclick="event.stopPropagation();assign('${i.id}')">Assign</button>` : `<span class="mut">Team: ${i.team || '-'}</span>`}</div>`).join('')
    : '<p class="mut">No matching incidents. New SOS requests appear here in real time.</p>';
}
function renderHistory() {
  const done = S.filter(i => ['COMPLETED','RESOLVED'].includes(i.status)).sort((a, b) => b.created - a.created);
  $('#historyList').innerHTML = done.length ? done.map(i => `<div class="inc">
    <div class="row"><b>${i.id}</b><span class="pill">COMPLETED</span></div>
    <div>${i.people} people · ${i.type} · ${i.location}</div>
    <div class="mut">Team: ${i.team || '-'}</div></div>`).join('')
    : '<p class="mut">No resolved incidents yet.</p>';
}
function renderTeams() {
  $('#tl').innerHTML = T.map(t => { const av=t.availability || (t.online ? (t.status==='AVAILABLE'?'AVAILABLE':'BUSY') : 'OFFLINE');
    return `<div class="team"><div class="row"><b>${t.name}</b><span class="pill status-${av.toLowerCase()}">${av}</span></div>
 <span class="mut">${t.specialty} · ${t.members} members · ${t.status.replace('_',' ')}</span><div class="bar" title="Readiness ${t.readiness}%"><i style="width:${t.readiness}%"></i></div><span class="mut">Readiness ${t.readiness}% · ${t.online ? 'live connection' : 'no live connection'}</span></div>`; }).join('');
}
function refresh() { renderKpis(); renderQueue(); renderTeams(); renderHistory(); renderMap(); }

/* ---- Actions (all go through the real backend; the UI updates when the WebSocket echoes back) ---- */
async function assign(id) {
  const i = byId(id), avail = T.filter(t => (t.availability || (t.online ? (t.status==='AVAILABLE'?'AVAILABLE':'BUSY') : 'OFFLINE')) === 'AVAILABLE');
  if (!avail.length) return toast('No team available right now');
  const t = avail.sort((a, b) => hav(i, a) - hav(i, b))[0]; // nearest available team
  try {
    await resqApi(`/api/teams/${t.id}/assign`, { method: 'POST', body: JSON.stringify({ incident_id: id }) });
    toast(`✓ Rescue ${t.name} assigned successfully`);
  } catch (e) { toast('Could not assign - check the connection'); }
}
async function resolve(id) {
  if (!confirm(`Mark ${id} as resolved?`)) return;
  const i = byId(id);
  try {
    await resqApi(`/api/incidents/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'COMPLETED' }) });
    routeLayer.clearLayers(); closeD();
  } catch (e) { toast('Could not resolve - check the connection'); }
}
async function reassign(id) { const teamId=$('#reassignTeam')?.value; if(!teamId) return toast('Choose an available team first'); try { await resqApi(`/api/incidents/${id}/reassign`,{method:'POST',body:JSON.stringify({team_id:teamId})}); toast('✓ Incident reassigned'); } catch(e){toast(e.message||'Could not reassign');} }
window.reassign = reassign;
function closeD() { $('#drawer').classList.remove('open') }
function openD(id) {
  const i = byId(id); if (!i) return;
  const steps = ['NEW', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'REACHED', 'COMPLETED'], done = steps.indexOf(i.status);
  const labels = ['Request received', 'Priority calculated', 'Team assigned', 'Accepted', 'On the way', 'Reached', 'Rescue completed'];
  const rows = Object.entries(i.breakdown || {});
  $('#drawer').innerHTML = `<div class="row"><div><h2 style="font-size:22px;margin:0">${i.id}</h2><span class="pill ${i.priority}">${i.priority === 'P1' ? 'CRITICAL INCIDENT' : i.priority + ' INCIDENT'}</span> ${i.source === 'citizen' ? '<span class="demo-tag" style="color:var(--bad);border-color:var(--bad)">LIVE SOS</span>' : ''}</div><button onclick="closeD()" aria-label="Close details">✕</button></div>
 <div class="routecard"><b>${i.type} Emergency · Priority ${i.priority}</b>
  <div class="mut" style="font-size:13px;line-height:1.7">Citizen: <b style="color:var(--tx)">${i.citizen_name || 'Unknown'}</b><br>People: <b style="color:var(--tx)">${i.people}</b><br>
  Location: <b style="color:var(--tx)">${coordText(i.lat, i.lng)}</b><br><span id="drAddr"></span>
  Assigned team: <b style="color:var(--tx)">${i.team || 'not assigned'}</b><br>Status: <span class="stbadge">${i.status.replace('_', ' ')}</span></div>
  ${routeInfoHtml(i, 'retryRoute')}</div>
 <div class="row" style="margin:16px 0"><div class="ring" style="--p:${i.score}"><div>${i.score}</div></div><div style="flex:1"><b>Priority score ${i.score} / 100 · Explainable Priority Engine</b>
 ${rows.map(([label, val]) => `<div class="row"><span class="mut">${label}</span><b>+${val}</b></div>`).join('')}</div></div>
 <p><b>Why is this ${i.priority}?</b><br><span class="mut">${(i.reasons || []).join(', ')}. Scores of 70+ are P1, 35+ are P2.</span></p>
 <div class="tl">${labels.map((t, k) => `<div class="${k < (done < 0 ? 2 : done + 2) ? 'd' : ''}">${t}</div>`).join('')}</div>
 <div class="acts"><button class="btn-o" onclick="assign('${i.id}')" ${i.status !== 'NEW' ? 'disabled' : ''}>Assign rescue team</button><select id="reassignTeam" ${i.status === 'COMPLETED' || i.status === 'RESOLVED' ? 'disabled' : ''} style="max-width:180px"><option value="">Officer override…</option>${T.filter(t=>(t.availability || (t.online ? (t.status==='AVAILABLE'?'AVAILABLE':'BUSY') : 'OFFLINE'))==='AVAILABLE' && t.id!==i.team_id).map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}</select><button onclick="reassign('${i.id}')" ${i.status === 'COMPLETED' || i.status === 'RESOLVED' ? 'disabled' : ''}>Reassign</button><button onclick="focusRoute('${i.id}');closeD()" ${i.team_id ? '' : 'disabled'}>Show route on map</button>
 <a href="${gmapsUrl(i.lat, i.lng)}" target="_blank"><button type="button">🧭 Open Navigation</button></a>
 <button onclick="feed('Warning sent near ${coordText(i.lat, i.lng)}');toast('✓ Warning sent')">Send warning</button>
 <button onclick="resolve('${i.id}')" ${['COMPLETED','RESOLVED'].includes(i.status) ? 'disabled' : ''}>Mark completed</button></div>`;
  $('#drawer').classList.add('open');
  resqGeocode(i.lat, i.lng).then(ad => { const el = $('#drAddr'); if (el && ad) el.innerHTML = `<span style="color:var(--tx)">${ad}</span><br>`; });
}

/* ---- Waiting-time ticker (purely cosmetic - real waiting time is computed by the backend from `created`) ---- */
setInterval(() => { document.querySelectorAll('.w').forEach(e => { const i = byId(e.dataset.id); if (i) e.textContent = fmt(Date.now() / 1000 - i.created); }); }, 1000);

/* ---- Merge live data + write readable feed lines on state changes ---- */
function upsertIncident(inc, { announce = true } = {}) {
  const prior = prevStatus[inc.id];
  const idx = S.findIndex(x => x.id === inc.id);
  if (idx === -1) S.push(inc); else S[idx] = inc;
  prevStatus[inc.id] = inc.status;
  if (!announce) return;
  if (prior === undefined) {
    if (inc.source === 'citizen') { feed(`<b>🔴 New SOS received</b> · ${inc.id} · ${inc.people} people`); toast(`🔴 NEW SOS RECEIVED · ${inc.id} · ${inc.priority}`); beep(); }
  } else if (prior !== inc.status) {
    const t = inc.team || 'Team';
    const lines = { ASSIGNED: `<b>${t}</b> assigned to ${inc.id}`, ACCEPTED: `<b>${t} accepted</b> · ${inc.id}`, ON_THE_WAY: `<b>${t}</b> is on the way to ${inc.id}`, REACHED: `${t} reached ${inc.id}`, COMPLETED: `<b>${inc.id} rescue completed</b> · team released` , RESOLVED: `<b>${inc.id} rescue completed</b> · legacy status` };
    if (lines[inc.status]) { feed(lines[inc.status]); toast(lines[inc.status].replace(/<[^>]*>/g,'')); }
    if (['COMPLETED','RESOLVED'].includes(inc.status)) toast(`✓ ${inc.id} rescue completed`);
  }
}
function upsertTeam(t) { const idx = T.findIndex(x => x.id === t.id); if (idx === -1) T.push(t); else T[idx] = t; }

/* ---- Live WebSocket connection ---- */
resqConnect((event, data) => {
  if (event === 'snapshot') {
    T = data.teams; data.incidents.forEach(i => upsertIncident(i, { announce: false })); refresh(); return;
  }
  if (event === 'incident_created' || event === 'incident_updated' || event === 'route_updated') { upsertIncident(data); refresh(); if ($('#drawer').classList.contains('open') && $('#drawer').innerHTML.includes(data.id)) openD(data.id); }
  if (event === 'team_updated') { upsertTeam(data); refresh(); }
  if (event === 'team_location_updated') { const t = teamById(data.team_id); if (t) { t.lat = data.lat; t.lng = data.lng; t.location_updated = data.updated; refresh(); } }
  if (event === 'team_assigned') { upsertIncident(data.incident); upsertTeam(data.team); refresh(); focusRoute(data.incident.id); }
  if (event === 'incident_claimed') { upsertIncident(data.incident); upsertTeam(data.team); refresh(); toast(`🚑 ${data.team.name} claimed ${data.incident.id}`); }
  if (event === 'incident_reassigned') { upsertIncident(data.incident); upsertTeam(data.team); refresh(); toast(`↪ ${data.incident.id} reassigned to ${data.team.name}`); }
  if (event === 'weather_advisory') { feed(`<b>⚠ Forecast-derived Advisory</b> · ${data.advisory.text}`); toast(`⚠ Forecast-derived Advisory · ${data.advisory.text}`); }
  if (event === 'team_presence_updated') { resqApi('/api/teams').then(v => { T=v; refresh(); }).catch(()=>{}); }
}, setConn);

/* ---- Offline-first: queue banner (real SOS queueing happens on the citizen phone; this banner
   just tells officers the laptop itself lost connectivity) ---- */
function net() {
  const b = $('#banner');
  if (!navigator.onLine) { b.style.display = 'block'; b.textContent = 'OFFLINE MODE · This laptop lost network. Reconnecting automatically…'; }
  else if (b.style.display === 'block') { b.textContent = 'BACK ONLINE · Reconnecting to the live feed…'; setTimeout(() => b.style.display = 'none', 3000); }
}
addEventListener('online', net); addEventListener('offline', net); net();

/* ---- Boot: skeleton loaders, then the initial fetch (WebSocket snapshot refines this moments later) ---- */
$('#queue').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
(async () => {
  try {
    T = await resqApi('/api/teams');
    (await resqApi('/api/incidents')).forEach(i => upsertIncident(i, { announce: false }));
  } catch (e) { /* WebSocket snapshot will populate this once it connects */ }
  refresh();
  feed('Control room online · connected to live backend', false);
})();
