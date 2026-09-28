/* ResQ Citizen - sends a real SOS to the FastAPI backend and tracks it live via WebSocket. */
const $ = s => document.querySelector(s);
const auth = resqRequireAuth('CITIZEN');
$('#whoName').textContent = auth.name;   // real registered account name
resqRefreshIdentity().then(a => { if (a) $('#whoName').textContent = a.name; });
$('#logout').onclick = e => { e.preventDefault(); resqLogout(); };
resqWatchBackend(ok => { const b = $('#backendst'); b.textContent = ok ? '● Backend' : '○ Backend'; b.className = 'connbadge ' + (ok ? 'live' : 'offline'); });

const setConn = connBadge($('#conn'));
const DEMO_LOCATION = { lat: 11.9075, lng: 79.8100, label: 'DEMO LOCATION (not real GPS)' };
let loc = null, locIsDemo = false, currentMap = null, counts = { people: 1, children: 0, elderly: 0, injured: 0 };

/* ---- Weather Intelligence + forecast-derived early warning (Open-Meteo) ---- */
async function loadWeather() {
  await resqLoadWeather($('#weatherBody'), { full: false }, loc ? loc.lat : null, loc ? loc.lng : null);
  $('#warnBody').innerHTML = '';
}
loadWeather(); setInterval(loadWeather, 5 * 60 * 1000);

/* ---- Geolocation, with a demo fallback so GPS problems never block the demo ---- */
function useLocation(l, label, demo = false) { loc = l; locIsDemo = demo; $('#locTxt').textContent = `📍 ${label}`; updateSms(); loadWeather(); if(!currentMap) currentMap=LiveMap('citizenLiveMap',{inc:'Your GPS location',team:'Rescue team'}); currentMap.update({id:'CURRENT',lat:l.lat,lng:l.lng,priority:'P3'},null); currentMap.resize(); }
if ('geolocation' in navigator) {
  navigator.geolocation.getCurrentPosition(
    p => useLocation({ lat: p.coords.latitude, lng: p.coords.longitude }, `${p.coords.latitude.toFixed(4)}°N, ${p.coords.longitude.toFixed(4)}°E`),
    () => { $('#locTxt').textContent = '📍 Location permission is required for live tracking. Allow location in your browser, or use the testing-only demo location.'; }
  );
} else { $('#locTxt').textContent = '📍 GPS unavailable on this device. Use the testing-only demo location.'; }
$('#demoLoc').onclick = () => useLocation(DEMO_LOCATION, DEMO_LOCATION.label + ' 11.9075°N, 79.8100°E', true);

/* ---- People / children / elderly / injured counters ---- */
document.querySelectorAll('.counter button').forEach(b => b.onclick = () => {
  const k = b.dataset.k; counts[k] = Math.max(k === 'people' ? 1 : 0, counts[k] + (+b.dataset.d));
  $('#' + k).textContent = counts[k]; updateSms();
});

function updateSms() {
  const l = loc; if (!l) { $('#smsLink').href = '#'; return; }
  const body = encodeURIComponent(`EMERGENCY SOS - ${$('#etype').value}. ${counts.people} people (${counts.children} children, ${counts.elderly} elderly, ${counts.injured} injured). Location: ${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`);
  $('#smsLink').href = `sms:112?body=${body}`;
}
$('#etype').onchange = updateSms; updateSms();

/* ---- Offline-first queue: if the POST fails, save it and retry when back online ---- */
const QUEUE_KEY = 'resq_pending_sos';
function queueSos(payload) {
  const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); q.push(payload);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}
async function flushQueue() {
  let q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  if (!q.length) return;
  localStorage.removeItem(QUEUE_KEY);
  const note = document.createElement('div'); note.className = 'toast'; note.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%)'; note.textContent = 'SOS syncing…'; document.body.append(note); setTimeout(() => note.remove(), 3500);
  for (const payload of q) {
    try { const inc = await resqApi('/api/incidents', { method: 'POST', body: JSON.stringify(payload) }); showTracking(inc); note.textContent = 'SOS sent successfully'; }
    catch (e) { queueSos(payload); } // still offline - put it back and try again later
  }
}
addEventListener('online', flushQueue);
flushQueue(); // in case a previous visit left something queued

/* ---- Submit SOS ---- */
$('#sosForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const l = loc;
  if (!l) { $('#err').textContent = 'Location permission is required for live tracking. Allow GPS (or use the testing-only demo location).'; return; }
  if (!confirm(`Send SOS for ${counts.people} people at ${l.label || (l.lat.toFixed(4) + ', ' + l.lng.toFixed(4))}?`)) return;
  const photo = $('#photo').files[0];
  const payload = {
    type: $('#etype').value, lat: l.lat, lng: l.lng, people: counts.people,
    children: counts.children, elderly: counts.elderly, injured: counts.injured,
    description: (locIsDemo ? '[DEMO LOCATION] ' : '') + $('#desc').value + (photo ? ` [Photo attached: ${photo.name}]` : '')
  };
  $('#err').textContent = '';
  if (!navigator.onLine) { queueSos(payload); return showOfflineSaved(); }
  try { const inc = await resqApi('/api/incidents', { method: 'POST', body: JSON.stringify(payload) }); showTracking(inc); }
  catch (err) { queueSos(payload); showOfflineSaved(); }
});

function showOfflineSaved() {
  $('#formView').innerHTML = `<div class="offline-note"><b>SOS saved locally</b><br>Waiting for network… It has NOT reached the control room yet, and will sync automatically the moment the network returns.</div>` + $('#formView').innerHTML;
}

/* ---- Live tracking screen ---- */
const STEP_ORDER = ['NEW', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'REACHED', 'COMPLETED'];
let trackedId = null;

function renderSteps(status) {
  const done = STEP_ORDER.indexOf(status);
  const rows = [['SOS sent', 0], ['Control room received', 0], ['Rescue team assigned', 1],
    ['Rescue team accepted', 2], ['Rescue team on the way', 3], ['Team reached your location', 4], ['Rescue completed', 5]];
  $('#steps').innerHTML = rows.map(([label, need]) => {
    const cls = done > need ? 'd' : done === need ? 'now' : '';
    return `<div class="${cls}">${label}</div>`;
  }).join('');
}

let myInc = null, myTeam = null, liveMap = null;
const STATUS_TXT = { NEW: 'WAITING FOR TEAM', ASSIGNED: 'TEAM ASSIGNED', ACCEPTED: 'TEAM ACCEPTED', ON_THE_WAY: 'ON THE WAY', REACHED: 'TEAM REACHED', COMPLETED: 'RESCUE COMPLETED', RESOLVED: 'RESCUE COMPLETED' };

function showTracking(inc) {
  trackedId = inc.id; myInc = inc;
  $('#formView').style.display = 'none'; $('#trackView').style.display = 'block';
  $('#trackId').textContent = inc.id;
  $('#trackType').textContent = `${inc.type} · ${coordText(inc.lat, inc.lng)}`;
  if (!liveMap) liveMap = LiveMap('citMap', { inc: 'Your SOS location', team: 'Rescue team' });
  liveMap.resize();
  applyIncident(inc);
  connect();
}

/* One place that repaints the whole tracking screen from the latest backend data. */
function applyIncident(inc) {
  myInc = inc;
  renderSteps(inc.status);
  $('#trackStatus').textContent = STATUS_TXT[inc.status] || inc.status; $('#trackView').classList.toggle('completed-pop', ['COMPLETED','RESOLVED'].includes(inc.status));
  if (inc.team_id && inc.team_lat != null) myTeam = Object.assign({}, myTeam || {}, { lat: inc.team_lat, lng: inc.team_lng, status: inc.team_status, name: inc.team, location_updated: inc.team_location_updated });
  if (!inc.team_id) myTeam = null;
  showTeam(inc);
  liveMap && liveMap.update(inc, ['COMPLETED','RESOLVED'].includes(inc.status) ? null : myTeam);
}

function showTeam(inc) {
  if (!inc.team_id) { $('#teamCard').style.display = 'none'; $('#mapNote').style.display = 'block'; return; }
  $('#mapNote').style.display = 'none';
  $('#teamCard').style.display = 'block';
  $('#teamName').textContent = inc.team;
  const arrive = { REACHED: 'Team has reached your location', COMPLETED: 'Rescue completed', RESOLVED: 'Rescue completed' }[inc.status];
  $('#teamInfo').innerHTML = (arrive ? `<b>${arrive}</b>` : `<span class="mut">Status:</span> <b>${STATUS_TXT[inc.status]}</b>`)
    + (arrive ? '' : routeInfoHtml(inc))
    + `<span class="mut" style="font-size:11px;display:block">Team location: last known, updated ${relTime(inc.team_location_updated)}</span>`
    + `<div class="acts" style="margin-top:8px"><a href="${gmapsUrl(inc.lat, inc.lng)}" target="_blank"><button type="button">🧭 Open Navigation</button></a></div>`;
}

function showStatusToast(status) { const labels={ASSIGNED:'🚑 Team claimed your SOS',ACCEPTED:'✓ Rescue team accepted',ON_THE_WAY:'🚑 Team is on the way',REACHED:'📍 Rescue team reached you',COMPLETED:'✅ Rescue completed'}; if(labels[status]) showWeatherToast(labels[status]); }
function showWeatherToast(msg) { const host=$('#toasts'); if(!host)return; const d=document.createElement('div'); d.className='toast warn'; d.textContent=msg; host.append(d); setTimeout(()=>d.remove(),5000); }
let ws;
function connect() {
  if (ws) return;
  ws = resqConnect((event, data) => {
    if (event === 'snapshot') { const mine = data.incidents.find(i => i.id === trackedId); if (mine) applyIncident(mine); return; }
    if (event === 'weather_advisory') { showWeatherToast('⚠ ' + weatherToastText(data)); loadWeather(); return; }
    if (event === 'control_alert') { showWeatherToast('🚨 Control Room: ' + data.message); return; }
    if (!trackedId) return;
    if ((event === 'incident_updated' || event === 'route_updated' || event === 'incident_status_updated') && data.id === trackedId) { const old=myInc?.status; applyIncident(data); if(event!=='route_updated'&&old&&old!==data.status) showStatusToast(data.status); }
    if (event === 'team_assigned' && data.incident && data.incident.id === trackedId) applyIncident(data.incident);
    if (event === 'team_location_updated' && myInc && data.team_id === myInc.team_id && myTeam) {   // rescue team moved
      myTeam.lat = data.lat; myTeam.lng = data.lng; myTeam.location_updated = data.updated;
      liveMap && liveMap.update(myInc, ['COMPLETED','RESOLVED'].includes(myInc.status) ? null : myTeam); showTeam(myInc);
    }
  }, setConn);
}
connect();

/* Restore tracking after a reload / re-login: pick up this citizen's latest unresolved SOS from the backend. */
(async () => {
  try {
    const mine = (await resqApi('/api/incidents')).filter(i => !['COMPLETED','RESOLVED'].includes(i.status)).sort((a, b) => b.created - a.created)[0];
    if (mine && !trackedId) showTracking(mine);
  } catch (e) {}
})();
