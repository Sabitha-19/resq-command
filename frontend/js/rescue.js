/* ResQ Rescue - operational phone view. */
const $ = s => document.querySelector(s);
const auth = resqRequireAuth('RESCUE_TEAM');
$('#whoName').textContent = auth.name;
$('#teamLine').textContent = [auth.team_name, auth.team_specialty].filter(Boolean).join(' · ') || '—';
$('#logout').onclick = e => { e.preventDefault(); resqLogout(); };
resqRefreshIdentity().then(a => { if (a) { $('#whoName').textContent = a.name; $('#teamLine').textContent = [a.team_name, a.team_specialty].filter(Boolean).join(' · '); } });
resqWatchBackend(ok => { const b = $('#backendst'); b.textContent = ok ? '● Backend' : '○ Backend'; b.className = 'connbadge ' + (ok ? 'live' : 'offline'); });

const setConn = connBadge($('#conn'));
let teams = [], incidents = [], liveMap = null;
const teamId = auth.team_id;
const myTeam = () => teams.find(t => t.id === teamId);
const activeMine = () => incidents.filter(i => i.team_id === teamId && !['COMPLETED','RESOLVED'].includes(i.status)).sort((a,b) => (b.score||0)-(a.score||0));
const openRequests = () => incidents.filter(i => i.status === 'NEW' && !i.team_id).sort((a,b) => (b.score||0)-(a.score||0));
const NEXT = { ASSIGNED: 'ACCEPTED', ACCEPTED: 'ON_THE_WAY', ON_THE_WAY: 'REACHED', REACHED: 'COMPLETED' };
const BTN = { ACCEPTED: 'ACCEPT', ON_THE_WAY: 'ON THE WAY', REACHED: 'REACHED', COMPLETED: 'RESCUE COMPLETED' };

function toast(msg, kind='info') {
  const host = $('#toasts'); if (!host) return;
  const d = document.createElement('div'); d.className = 'toast ' + kind; d.textContent = msg; host.append(d);
  setTimeout(() => d.remove(), 4500);
}

async function loadWeather(){
  const t = myTeam();   // use the team's real GPS position when known, otherwise the server default forecast point
  const gps = t && t.location_source === 'GPS' && t.location_updated;
  await resqLoadWeather($('#weatherBody'), { full: false }, gps ? t.lat : null, gps ? t.lng : null);
  $('#warnBody').innerHTML = '';
}
loadWeather();setInterval(loadWeather,5*60*1000);

async function boot() {
  try { teams = await resqApi('/api/teams'); incidents = await resqApi('/api/incidents'); }
  catch (e) { $('#empty').style.display = 'block'; $('#empty').textContent = 'Could not reach the backend. Check the API address.'; return; }
  render(); loadWeather(); connect(); startGps();
}
function render() {
  const t = myTeam(), mine = activeMine(), a = mine[0], requests = openRequests();
  $('#empty').style.display = (!a && !requests.length) ? 'block' : 'none';
  if (!a && !requests.length) $('#empty').textContent = t?.status === 'AVAILABLE' ? 'Waiting for SOS requests. New emergencies appear here instantly.' : 'Team is busy. Finish the current incident before accepting another SOS.';
  $('#active').style.display = a ? 'grid' : 'none';
  if (a) renderActive(a, t);
  renderRequests(requests, t);
  const status = t ? `${t.status.replaceAll('_',' ')} · ${t.availability || (t.online ? 'ONLINE' : 'OFFLINE')}` : 'Team status unavailable';
  $('#teamLine').textContent = `${auth.team_name || 'Rescue Team'} · ${status}`;
}
function renderActive(a, t) {
  $('#activeHead').innerHTML = `<div class="rescue-card ${a.priority} ${['COMPLETED','RESOLVED'].includes(a.status)?'completed-pop':''}"><div class="row"><b>ACTIVE RESCUE · ${a.id}</b><span class="pill ${a.priority}">${a.priority}</span></div><div>${a.type} emergency · <span class="stbadge">${a.status.replaceAll('_',' ')}</span></div><div class="mut">👥 ${a.people} people${a.children ? ' · 👶 '+a.children+' children':''}${a.elderly ? ' · 👵 '+a.elderly+' elderly':''}${a.injured ? ' · 🩹 '+a.injured+' injured':''}${a.citizen_name ? ' · Citizen: '+a.citizen_name:''}</div></div>`;
  if (!liveMap) liveMap = LiveMap('resMap', { inc: 'SOS location', team: 'You' });
  liveMap.resize(); liveMap.update(a, t ? {lat:t.lat,lng:t.lng,status:t.status,name:t.name,location_updated:t.location_updated,online:t.online,availability:t.availability} : null);
  const next = NEXT[a.status];
  $('#activeInfo').innerHTML = `${routeInfoHtml(a, 'retryRoute')}<div class="mut" style="font-size:13px">Destination: ${coordText(a.lat, a.lng)}<br><span id="addr"></span></div><div class="acts">${next ? `<button class="btn-o" onclick="advance('${a.id}','${next}')">${BTN[next]}</button>` : ''}<a href="${gmapsUrl(a.lat,a.lng)}" target="_blank"><button type="button">🧭 Open Navigation</button></a></div>`;
  resqGeocode(a.lat,a.lng).then(ad => { const el=$('#addr'); if(el && ad) el.textContent=ad; });
}
function renderRequests(requests, t) {
  const host = $('#list');
  if (!requests.length) { host.innerHTML = ''; return; }
  const canAccept = t && t.status === 'AVAILABLE' && t.online !== false;
  host.innerHTML = `<div class="section-title"><b>LIVE SOS REQUESTS</b><span class="mut">${requests.length} unclaimed</span></div>` + requests.map(i => `<article class="request-card ${i.priority}"><div class="row"><b>${i.id}</b><span class="pill ${i.priority}">${i.priority}</span></div><div><b>${i.type}</b> · ${i.people} people</div><div class="mut">${i.location || coordText(i.lat,i.lng)} · Priority ${i.priority} · ${i.score}/100</div>${i.description ? `<div class="request-note">${escapeHtml(i.description)}</div>` : ''}<div class="acts"><button class="btn-o" ${canAccept ? '' : 'disabled'} onclick="acceptSos('${i.id}')">${canAccept ? 'ACCEPT SOS' : 'TEAM BUSY / OFFLINE'}</button><a href="${gmapsUrl(i.lat,i.lng)}" target="_blank"><button type="button">Destination</button></a></div></article>`).join('');
}
function escapeHtml(s){return String(s||'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
async function acceptSos(id) {
  try { const r=await resqApi(`/api/incidents/${id}/accept`,{method:'POST'}); upsertIncident(r.incident);upsertTeam(r.team);toast(`✓ ${id} accepted by ${r.team.name}`,'success');render(); }
  catch(e){ if(/already claimed/i.test(e.message)) toast(`Already claimed — another team accepted ${id}.`,'warn'); else toast(e.message||'Could not accept SOS','warn'); const latest=await resqApi('/api/incidents').catch(()=>null);if(latest)incidents=latest;render(); }
}
window.acceptSos=acceptSos;
async function advance(id,status){try{const inc=await resqApi(`/api/incidents/${id}`,{method:'PATCH',body:JSON.stringify({status})});upsertIncident(inc);render();}catch(e){toast('Could not update status: '+e.message,'warn');}}
async function retryRoute(id){try{const inc=await resqApi(`/api/incidents/${id}/route`,{method:'POST'});upsertIncident(inc);render();}catch(e){toast(e.message,'warn');}}
window.advance=advance;window.retryRoute=retryRoute;
function upsertIncident(inc){const i=incidents.findIndex(x=>x.id===inc.id);if(i===-1)incidents.push(inc);else incidents[i]=inc;}
function upsertTeam(t){const i=teams.findIndex(x=>x.id===t.id);if(i===-1)teams.push(t);else teams[i]=t;}
function connect(){
  resqConnect((event,data)=>{
    if(event==='snapshot'){incidents=data.incidents;teams=data.teams;render();return;}
    if(event==='incident_created'||event==='new_sos'){const inc=event==='new_sos'?data.incident:data;upsertIncident(inc);if(inc.source==='citizen'&&myTeam()?.status==='AVAILABLE')toast(`🚨 NEW SOS · ${inc.id} · Accept if you can respond`,'danger');render();return;}
    if(event==='incident_claimed'){upsertIncident(data.incident);upsertTeam(data.team);if(data.team.id!==teamId)toast(`Already claimed · ${data.incident.id} by ${data.team.name}`,'warn');render();return;}
    if(event==='incident_reassigned'||event==='team_assigned'){upsertIncident(data.incident);upsertTeam(data.team);render();return;}
    if(event==='incident_updated'||event==='incident_status_updated'||event==='route_updated'){const before=incidents.find(x=>x.id===data.id)?.status;upsertIncident(data);if(event!=='route_updated'&&before&&before!==data.status&&data.team_id===teamId)toast(`Status update · ${data.status.replaceAll('_',' ')}`,data.status==='COMPLETED'?'success':'info');render();return;}
    if(event==='team_updated'){upsertTeam(data);render();return;}
    if(event==='team_location_updated'){const t=teams.find(x=>x.id===data.team_id);if(t){t.lat=data.lat;t.lng=data.lng;t.location_updated=data.updated;if(data.team_id===teamId)render();}return;}
    if(event==='weather_advisory'){toast(`⚠ ${weatherToastText(data)}`,'warn');loadWeather();return;}
    if(event==='control_alert'){toast(`🚨 Control Room: ${data.message}`,'danger');return;}
    if(event==='team_presence_updated'){resqApi('/api/teams').then(v=>{teams=v;render();}).catch(()=>{});}
  },setConn);
}
let lastSent=0;
function startGps(){
  if(!('geolocation' in navigator)){ $('#gpsLine').textContent='📡 GPS unavailable on this device';return; }
  navigator.geolocation.watchPosition(async p=>{const now=Date.now();if(now-lastSent<5000)return;lastSent=now;try{await resqApi(`/api/teams/${teamId}/location`,{method:'POST',body:JSON.stringify({lat:p.coords.latitude,lng:p.coords.longitude})});$('#gpsLine').textContent=`📡 Live GPS · ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`;}catch(e){$('#gpsLine').textContent='📡 GPS captured, backend update failed — retrying';}},err=>{$('#gpsLine').textContent=err.code===1?'📡 Location permission required for live GPS.':'📡 Live GPS unavailable right now';},{enableHighAccuracy:true,maximumAge:3000,timeout:20000});
}
boot();
