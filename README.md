# ResQ Command — Live Rescue Coordination Prototype

ResQ Command is a **hackathon/demo prototype** built around the existing FastAPI + SQLite + WebSocket architecture. The flow is designed for a live multi-device demonstration:

**Citizen sends SOS → all connected available rescue teams receive it → first team claims it atomically → live GPS → OSRM road route → distance + route-based ETA → team reaches → rescue completed → team becomes available.**

## Stack preserved

- FastAPI + Uvicorn
- SQLite + SQLAlchemy
- Existing signed bearer authentication
- WebSockets for live events
- Leaflet + OpenStreetMap tiles
- OSRM public routing service
- Open-Meteo forecast integration
- Citizen offline SOS queue + SMS fallback
- Existing explainable priority calculation + incident history

No new frontend framework or unnecessary API has been added.

## Run

```bash
pip install -r requirements.txt
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

The server serves the three existing interfaces:

- `http://localhost:8000` — login
- `http://localhost:8000/dashboard` — Control Room
- `http://localhost:8000/rescue` — Rescue Team
- `http://localhost:8000/citizen` — Citizen

For a phone on the same Wi-Fi, use `http://<LAPTOP-IP>:8000/?api=http://<LAPTOP-IP>:8000`. The browser remembers the API address.

### Demo accounts

- Control Room: `control@resq.demo` / `resq123`
- Rescue Team Alpha: `alpha@resq.demo` / `resq123`
- Rescue Team Bravo: `bravo@resq.demo` / `resq123`
- Rescue Team Charlie: `charlie@resq.demo` / `resq123`
- Rescue Team Delta: `delta@resq.demo` / `resq123`
- Citizen: create a normal account from the login page.

The UI displays the **actual authenticated account name** returned by `/api/me`; it does not hard-code an officer name.

## Live maps and GPS

All three pages load Leaflet + OpenStreetMap. The Control Room map uses `#mapEl` and explicitly invalidates its size after load, fixing the previous collapsed-map issue.

Rescue-team GPS is taken from the browser's `navigator.geolocation.watchPosition()` and sent to:

`POST /api/teams/{team_id}/location`

The backend marks that position as `location_source=GPS` and broadcasts `team_location_updated`. All three maps update the marker, and the marker movement is animated smoothly.

Configured team coordinates are retained only as operational base coordinates. They are **not treated as GPS** and are not used to fabricate a route. Until a rescue phone supplies GPS, route distance/ETA remains unavailable.

## Road routing

After a team has real GPS, the backend requests an OSRM driving route from the team's current GPS position to the citizen's SOS coordinates. It stores:

- road distance in km
- route-based duration in minutes
- GeoJSON-derived route geometry

The same stored route is sent to Control Room, Citizen and Rescue Team. If OSRM fails, the UI says **Route unavailable** instead of inventing a distance or ETA.

The UI explicitly calls this **Route-based ETA (OSRM road routing, no live traffic)**.

**Open Navigation** opens a Google Maps directions URL for the SOS destination.

## SOS claim and team state machine

A citizen SOS is broadcast through WebSocket as `new_sos` to connected clients. Rescue pages show the request when their team is available.

The first rescue team to call:

`POST /api/incidents/{incident_id}/accept`

wins through conditional SQLite updates in one transaction. A second simultaneous claim receives HTTP `409 Already claimed`.

Team lifecycle:

`AVAILABLE → ASSIGNED → ACCEPTED → ON_THE_WAY → REACHED → COMPLETED → AVAILABLE`

A team cannot accept another incident while it has an assigned incident. The backend, not the browser, controls the state transition and releases the team only after completion.

The legacy `RESOLVED` value is still understood so an older SQLite database does not break, but new completion uses `COMPLETED`.

## Control Room

The dashboard receives all incidents and team events live. It shows:

- priority queue
- claimed team
- live team markers
- route cards with OSRM distance/ETA
- incident history
- team availability: `AVAILABLE`, `BUSY`, `OFFLINE`
- live WebSocket + backend connection indicators

The officer can still manually assign an unclaimed SOS using the existing control-room action. A separate reassign endpoint is available for an officer override when an active incident needs another available team:

`POST /api/incidents/{incident_id}/reassign` with `{ "team_id": "T2" }`

## Weather advisory

The existing Open-Meteo integration now checks a **12-hour hourly forecast**, not only current conditions. The prototype looks for:

- high forecast rain probability
- significant forecast rainfall
- strong forecast wind

When configured thresholds are met, the server emits one deduplicated `weather_advisory` WebSocket event for that forecast condition. Control Room, Citizen and Rescue pages show a toast/banner labelled:

**Forecast-derived Advisory**

It is **not** called an official warning because no official warning feed is integrated.

If Open-Meteo is unavailable, the UI reports the service failure and does not invent weather values.

## Notifications

Live toast/feed events cover:

- New SOS
- Team claimed SOS
- Team accepted / on the way / reached
- Rescue completed
- Forecast-derived weather advisory

The dashboard also keeps its activity history.

## Offline SOS

The existing citizen offline-first behavior is preserved. If an SOS POST cannot reach the backend, the request is stored in browser `localStorage` and retried when connectivity returns. The UI clearly says the SOS has **not yet reached the control room** while offline.

SMS fallback is preserved.

## Browser GPS limitation for a phone demo

Mobile browsers normally require HTTPS or a secure context for geolocation. `localhost` works as a secure development origin, but `http://<laptop-ip>:8000` may be blocked by the browser. For a real phone demo, use an HTTPS tunnel or another secure LAN setup that your browser accepts.

Do not use the demo-location button as evidence of live GPS; it remains explicitly labelled testing-only.

## Files changed

- `backend/main.py` — atomic SOS claims, presence/availability, forecast advisory, GPS-only routing, reassignment, status state machine, live broadcasts
- `backend/database.py` — additive team GPS-source field and updated status/distance model comments/defaults
- `frontend/js/ws.js` — WebSocket identity/presence handshake
- `frontend/js/livemap.js` — team availability states and smooth GPS marker movement
- `frontend/js/rescue.js` — all-team SOS queue, atomic accept flow, operational notifications, GPS, weather
- `frontend/js/citizen.js` — live current-location map, forecast display, status/weather notifications, completion states
- `frontend/js/dashboard.js` — team availability, live claim/status/weather notifications, completion states, map sizing/animation
- `frontend/css/style.css` — `#mapEl` sizing fix, command/rescue/citizen visual differentiation, request cards and toast states
- `frontend/citizen.html` — always-visible live GPS map + notification host
- `frontend/rescue.html` — weather card + notification host
- `frontend/dashboard.html` — Control Room visual class

## Prototype limitations

1. **OSRM public demo service:** no SLA and no live traffic. ETA is route-based only.
2. **OpenStreetMap/Nominatim:** public services can be rate-limited. Reverse geocoding is best-effort; coordinates remain available if address lookup fails.
3. **Browser GPS:** depends on device permissions and browser secure-context rules. Indoor GPS may drift.
4. **SQLite:** suitable for this supervised prototype, not a multi-instance production deployment.
5. **WebSocket fan-out:** the simple demo hub broadcasts events to connected clients; clients filter what they display. This is intentionally simple for a hackathon LAN demo.
6. **Weather advisory:** thresholds are prototype rules, not official emergency warnings.
7. **External services require internet:** Leaflet tiles, OSRM, Nominatim and Open-Meteo are external services. If unavailable, the project shows an honest unavailable state instead of fabricating live data.
