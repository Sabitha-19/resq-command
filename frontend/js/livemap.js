/* ResQ Command - shared live-map helpers used by dashboard / rescue / citizen.
   Leaflet + OpenStreetMap tiles. Road routes/distance/ETA come from the BACKEND (OSRM),
   stored on the incident, so every page draws exactly the same data.
   OSRM gives road routing + route-based duration only - there is NO live-traffic data. */

const mkIcon = c => L.divIcon({ className: '', html: `<div class="mk ${c}"></div>`, iconSize: [18, 18] });

/* Team marker colour by real team status. */
function teamClass(t) {
  if (t.availability === 'OFFLINE' || t.online === false) return 'team-off';
  return ({ AVAILABLE: 'team', ASSIGNED: 'team-assigned', ACCEPTED: 'team-assigned', ON_THE_WAY: 'team-onway', REACHED: 'team-reached', COMPLETED: 'team-reached', AT_SCENE: 'team-reached' })[t.status] || 'team-off';
}
const TEAM_STATE_LABEL = { AVAILABLE: 'Available', ASSIGNED: 'Assigned', ACCEPTED: 'Accepted', ON_THE_WAY: 'On the way', REACHED: 'Reached', COMPLETED: 'Completed', AT_SCENE: 'Reached', };

const fmtKm = km => (km == null ? '—' : (+km).toFixed(1) + ' km');
const fmtMin = m => (m == null ? '—' : m + ' min');
function relTime(ts) {
  if (!ts) return 'unknown';
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 60 ? Math.round(s) + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
}
const coordText = (lat, lng) => `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;

/* Distance + ETA card. Shows "Route unavailable" (never made-up numbers) if OSRM failed. */
function routeInfoHtml(inc, retryFn) {
  if (!inc || !inc.team_id || ['COMPLETED','RESOLVED'].includes(inc.status)) return '';
  if (inc.route_km == null) {
    return `<div class="routebox err"><b>Route unavailable</b><br>Unable to calculate road route right now.<br>Please use the navigation option or retry.
      ${retryFn ? `<br><button type="button" onclick="${retryFn}('${inc.id}')">Retry route</button>` : ''}</div>`;
  }
  return `<div class="routebox"><div class="rb"><span class="mut">Distance</span><b>${fmtKm(inc.route_km)}</b></div>
    <div class="rb"><span class="mut">Estimated travel time</span><b>${fmtMin(inc.route_min)}</b></div></div>
    <span class="mut" style="font-size:11px">Route-based ETA (OSRM road routing, no live traffic) · route updated ${relTime(inc.route_updated)}</span>`;
}

/* Reverse geocoding through the backend (Nominatim). Falls back to null -> caller shows coordinates. */
const _geo = {};
async function resqGeocode(lat, lng) {
  const k = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (k in _geo) return _geo[k];
  try { _geo[k] = (await resqApi(`/api/geocode?lat=${lat}&lng=${lng}`)).address || null; } catch (e) { _geo[k] = null; }
  return _geo[k];
}

/* Refresh the identity shown in the UI from the backend session (/api/me) so it always
   reflects the real account, even if localStorage is stale. */
async function resqRefreshIdentity() {
  try {
    const me = await resqApi('/api/me');
    const cur = resqAuth() || {};
    resqSetAuth(Object.assign({}, cur, me));
    return resqAuth();
  } catch (e) { return resqAuth(); }
}

function animateMarker(marker, target, duration=700) {
  const from = marker.getLatLng();
  const start = performance.now();
  function step(now) {
    const p = Math.min(1, (now-start)/duration);
    const e = p < .5 ? 2*p*p : 1-Math.pow(-2*p+2,2)/2;
    marker.setLatLng([from.lat+(target[0]-from.lat)*e, from.lng+(target[1]-from.lng)*e]);
    if(p<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* Single-incident map for the citizen and rescue phones:
   incident marker + team marker + road-route polyline, all driven by one incident payload. */
function LiveMap(elId, labels) {
  labels = Object.assign({ inc: 'SOS location', team: 'Rescue team' }, labels || {});
  const map = L.map(elId).setView([11.94, 79.83], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
  let incM = null, teamM = null, routeL = null, fitKey = null;
  return {
    map,
    /* inc: incident payload; team: {lat,lng,status,name,location_updated} or null */
    update(inc, team) {
      if (!inc) return;
      const ic = mkIcon((inc.priority || 'P1').toLowerCase());
      if (!incM) incM = L.marker([inc.lat, inc.lng], { icon: ic }).addTo(map);
      incM.setIcon(ic).setLatLng([inc.lat, inc.lng]).bindTooltip(`${labels.inc} · ${inc.id}`);
      if (team) {
        if (!teamM) teamM = L.marker([team.lat, team.lng], { icon: mkIcon(teamClass(team)) }).addTo(map);
        animateMarker(teamM, [team.lat, team.lng], 700);
        teamM.setIcon(mkIcon(teamClass(team)))
          .bindTooltip(`${labels.team}${team.name ? ' · ' + team.name : ''} — last known location, updated ${relTime(team.location_updated)}`);
      } else if (teamM) { map.removeLayer(teamM); teamM = null; }
      const geo = inc.route_geometry;
      if (routeL) { map.removeLayer(routeL); routeL = null; }
      if (geo && geo.length > 1 && !['COMPLETED','RESOLVED'].includes(inc.status)) routeL = L.polyline(geo, { color: '#3b9eff', weight: 5, opacity: .85 }).addTo(map);
      const key = inc.id + (team ? 't' : '') + (routeL ? 'r' : '');
      if (key !== fitKey) {   // re-fit only when something new appears, so the map doesn't jump every update
        fitKey = key;
        const pts = [[inc.lat, inc.lng]]; if (team) pts.push([team.lat, team.lng]); if (geo) pts.push(...geo);
        pts.length > 1 ? map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 }) : map.setView(pts[0], 15);
      }
    },
    resize() { setTimeout(() => map.invalidateSize(), 50); },
  };
}
