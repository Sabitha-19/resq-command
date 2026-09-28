"""ResQ Command API.

Real backend: SQLite (via SQLAlchemy) persists users, rescue teams, incidents and
incident events across restarts. No incidents are preloaded - the dashboard starts
at "Active Incidents: 0" and only fills up when a real citizen sends an SOS.

Run:  cd backend && uvicorn main:app --reload --host 0.0.0.0 --port 8000
The same server serves the frontend AND the /citizen and /rescue phone pages,
so this is the only process you need to start. See README.md for the full
multi-device (laptop + 2 phones) test walkthrough and test accounts.
"""
import asyncio, base64, hashlib, hmac, json, math, os, random, time
from typing import List, Optional

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import update

try:
    from .database import init_db, get_session, User, RescueTeam, Incident, IncidentEvent
except ImportError:
    from database import init_db, get_session, User, RescueTeam, Incident, IncidentEvent
app = FastAPI(title="ResQ Command API")
# Wide-open CORS on purpose: this is a LAN hackathon demo reached from phone
# browsers on IPs the server can't predict in advance (see README "multi-device").
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
SECRET = os.getenv("RESQ_SECRET", "change-me-in-.env").encode()

init_db()

# ================================================================================
# Auth: real credential check against the users table, signed opaque token
# (HMAC over a base64 JSON body). Not JWT-format, but the same idea - a JWT
# library (python-jose / PyJWT) is a drop-in swap later if needed.
# ================================================================================
def hash_pw(pw: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), SECRET, 100_000).hex()


def make_token(email: str) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"sub": email, "exp": time.time() + 12 * 3600}).encode()).decode()
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_token(token: str) -> Optional[str]:
    try:
        body, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(sig, hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body.encode()))
        if payload["exp"] < time.time():
            return None
        return payload["sub"]
    except Exception:
        return None


def db_dep():
    db = get_session()
    try:
        yield db
    finally:
        db.close()


def get_current_user(authorization: Optional[str] = Header(None), db: Session = Depends(db_dep)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    email = verify_token(authorization.split(" ", 1)[1])
    if not email:
        raise HTTPException(401, "Session expired - please log in again")
    user = db.get(User, email)
    if not user:
        raise HTTPException(401, "Account no longer exists")
    return user


def require_roles(*roles):
    def _dep(user: User = Depends(get_current_user)):
        if user.role not in roles:
            raise HTTPException(403, f"This action requires role: {' or '.join(roles)}")
        return user
    return _dep


# ================================================================================
# Pydantic I/O models
# ================================================================================
class RegisterIn(BaseModel):
    name: str
    email: str
    password: str


class LoginIn(BaseModel):
    email: str
    password: str


class ScoreIn(BaseModel):
    people: int = 1
    children: int = 0
    elderly: int = 0
    injured: int = 0
    severity: int = 2
    distance_km: Optional[float] = None
    waiting_min: float = 0.0


class IncidentIn(BaseModel):
    type: str
    lat: float
    lng: float
    people: int = 1
    children: int = 0
    elderly: int = 0
    injured: int = 0
    description: Optional[str] = ""


class IncidentPatch(BaseModel):
    status: Optional[str] = None


class TeamPatch(BaseModel):
    status: Optional[str] = None
    readiness: Optional[int] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


class AssignIn(BaseModel):
    incident_id: str


class ReassignIn(BaseModel):
    team_id: str


# ================================================================================
# Explainable priority engine - deterministic, not a trained model.
# ================================================================================
SEVERITY_BY_TYPE = {"Flood": 3, "Cyclone": 3, "Earthquake": 3, "Landslide": 2, "Fire": 2, "Medical": 2}


def haversine_km(a_lat, a_lng, b_lat, b_lng):
    r = 6371
    dlat, dlng = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    aa = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(dlng / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(aa), math.sqrt(1 - aa))


def nearest_team(db: Session, lat: float, lng: float):
    teams = [t for t in db.query(RescueTeam).all() if t.status == "AVAILABLE" and t.location_source == "GPS" and t.location_updated]
    if not teams:
        return None, 0.0
    best = min(teams, key=lambda t: haversine_km(lat, lng, t.lat, t.lng))
    return best, round(haversine_km(lat, lng, best.lat, best.lng), 1)


def compute_priority(s: ScoreIn) -> dict:
    sev = max(1, min(3, s.severity))
    breakdown = {
        f"{s.people} people affected": min(20, s.people * 3),
        f"{s.children} children": min(10, s.children * 10),
        f"{s.elderly} elderly": min(10, s.elderly * 10),
        f"{s.injured} injured": min(15, s.injured * 8),
        ["Low", "Medium", "High"][sev - 1] + " hazard severity": sev * 7,
        **({f"{round(s.distance_km, 1)} km from nearest team": max(0, round(12 - s.distance_km * 3))} if s.distance_km is not None else {}),
        f"Waiting {round(s.waiting_min, 1)} min": min(16, round(s.waiting_min * 2)),
    }
    score = min(100, sum(breakdown.values()))
    priority = "P1" if score >= 70 else "P2" if score >= 35 else "P3"
    return {"priority": priority, "score": score, "breakdown": breakdown,
            "reasons": [k for k, v in breakdown.items() if v > 0], "engine": "Explainable Priority Engine"}


def enrich(i: Incident) -> dict:
    p = compute_priority(ScoreIn(people=i.people, children=i.children, elderly=i.elderly, injured=i.injured,
                                  severity=i.severity, distance_km=i.distance_km,
                                  waiting_min=(time.time() - i.created) / 60))
    d = {c.name: getattr(i, c.name) for c in i.__table__.columns}
    try:
        d["route_geometry"] = json.loads(i.route_geometry) if i.route_geometry else None
    except Exception:
        d["route_geometry"] = None
    team = None
    citizen_name = None
    db = get_session()
    try:
        if i.team_id:
            t = db.get(RescueTeam, i.team_id)
            if t:
                team = t.name
                d.update(team_specialty=t.specialty, team_lat=t.lat, team_lng=t.lng,
                         team_location_updated=t.location_updated, team_status=t.status)
        if i.citizen_email:
            u = db.get(User, i.citizen_email)
            citizen_name = u.name if u else None
    finally:
        db.close()
    d.update(priority=p["priority"], score=p["score"], breakdown=p["breakdown"], reasons=p["reasons"],
             team=team, citizen_name=citizen_name)
    return d


# ================================================================================
# Road routing (OSRM public demo server) - computed on the BACKEND and stored on the
# incident, so the control room, rescue phone and citizen phone all show the SAME route,
# distance and ETA. OSRM = road routing + route-based duration. It has NO live-traffic data.
# ================================================================================
OSRM_URL = os.getenv("OSRM_URL", "https://router.project-osrm.org")
ROUTE_MIN_MOVE_KM = 0.15      # recalculate only after the team moved at least this far...
ROUTE_MIN_INTERVAL_S = 15     # ...and not more often than this


async def osrm_route(a_lat, a_lng, b_lat, b_lng):
    """Returns (km, minutes, [[lat,lng],...]) or None if the routing service fails.
    NOTE: OSRM wants lng,lat order (not lat,lng)."""
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(f"{OSRM_URL}/route/v1/driving/{a_lng},{a_lat};{b_lng},{b_lat}",
                                 params={"overview": "full", "geometries": "geojson"})
            r.raise_for_status()
            rt = r.json()["routes"][0]
        pts = [[c[1], c[0]] for c in rt["geometry"]["coordinates"]]
        return round(rt["distance"] / 1000, 1), max(1, round(rt["duration"] / 60)), pts
    except Exception:
        return None


async def recalc_route(db: Session, inc: Incident, team: RescueTeam) -> bool:
    """Calculate + persist a road route only from a real GPS team position."""
    if team.location_source != "GPS" or not team.location_updated:
        inc.route_updated = time.time()
        inc.route_km = inc.route_min = None
        inc.route_geometry = None
        db.commit()
        return False
    res = await osrm_route(team.lat, team.lng, inc.lat, inc.lng)
    inc.route_updated = time.time()
    if not res:
        if inc.route_geometry is None:
            inc.route_km = inc.route_min = None
        db.commit()
        return False
    inc.route_km, inc.route_min, inc.route_geometry = res[0], res[1], json.dumps(res[2])
    inc.distance_km = res[0]
    db.commit()
    return True


def log_event(db: Session, incident_id: str, status: str, actor: Optional[str], note: Optional[str] = None):
    db.add(IncidentEvent(incident_id=incident_id, status=status, actor=actor, note=note))


# ================================================================================
# Bootstrap accounts + rescue teams (NOT incidents). Teams are operational
# infrastructure - they must exist for assignment to be possible - not demo
# incident data, so they are safe to create once on first run.
# ================================================================================
def bootstrap(db: Session):
    if not db.get(User, "control@resq.demo"):
        db.add(User(email="control@resq.demo", password_hash=hash_pw("resq123"), role="CONTROL_ROOM", name="Control Room Officer"))
    default_teams = [
        ("T1", "Alpha Rescue", "Flood & Water Rescue", 11.935, 79.82, "alpha@resq.demo"),
        ("T2", "Bravo Rescue", "Landslide & Search", 11.99, 79.85, "bravo@resq.demo"),
        ("T3", "Charlie Rescue", "Cyclone Response", 11.92, 79.84, "charlie@resq.demo"),
        ("T4", "Delta Rescue", "Medical Evacuation", 11.95, 79.80, "delta@resq.demo"),
    ]
    for tid, name, spec, lat, lng, email in default_teams:
        if not db.get(RescueTeam, tid):
            db.add(RescueTeam(id=tid, name=name, specialty=spec, readiness=90, lat=lat, lng=lng, location_source="CONFIGURED_BASE", location_updated=None))
        if not db.get(User, email):
            db.add(User(email=email, password_hash=hash_pw("resq123"), role="RESCUE_TEAM",
                        name=name.split()[0] + " Team Lead", team_id=tid))
    db.commit()


_b = get_session()
bootstrap(_b)
_b.close()

# ================================================================================
# WebSocket hub - every connected client gets every event; each frontend
# filters by incident id / team id it cares about. Simple and easy to demo.
# ================================================================================
clients: List[WebSocket] = []
client_meta = {}
PRESENCE_TTL = 25


def team_online(team_id: Optional[str]) -> bool:
    if not team_id:
        return False
    now = time.time()
    return any(m.get("team_id") == team_id and now - m.get("seen", 0) <= PRESENCE_TTL for m in client_meta.values())


def team_payload(t: RescueTeam) -> dict:
    out = {c.name: getattr(t, c.name) for c in t.__table__.columns}
    online = team_online(t.id)
    out["online"] = online
    out["availability"] = "OFFLINE" if not online else ("AVAILABLE" if t.status == "AVAILABLE" else "BUSY")
    return out


async def broadcast(event: str, data: dict):
    for ws in list(clients):
        try:
            await ws.send_json({"event": event, "data": data})
        except Exception:
            if ws in clients:
                clients.remove(ws)


def snapshot(db: Session) -> dict:
    return {"incidents": [enrich(i) for i in db.query(Incident).all()],
            "teams": [team_payload(t) for t in db.query(RescueTeam).all()]}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.append(ws)
    client_meta[ws] = {"role": None, "team_id": None, "seen": time.time()}
    db = get_session()
    try:
        await ws.send_json({"event": "snapshot", "data": snapshot(db)})
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
                try:
                    msg = json.loads(raw)
                except Exception:
                    msg = {}
                meta = client_meta.get(ws)
                if meta is not None:
                    meta["seen"] = time.time()
                    if msg.get("type") == "hello":
                        meta["role"] = msg.get("role")
                        meta["team_id"] = msg.get("team_id")
                        await ws.send_json({"event": "presence_ack", "data": {"role": meta["role"], "team_id": meta["team_id"]}})
                        await broadcast("team_presence_updated", {"team_id": meta["team_id"]})
            except asyncio.TimeoutError:
                if ws in client_meta:
                    client_meta[ws]["seen"] = time.time()
                await ws.send_json({"event": "heartbeat", "data": {"t": time.time()}})
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        db.close()
        if ws in clients:
            clients.remove(ws)
        client_meta.pop(ws, None)
        try:
            await broadcast("team_presence_updated", {"team_id": None})
        except Exception:
            pass


# ================================================================================
# Auth routes
# ================================================================================
def user_out(u: User) -> dict:
    out = {"token": make_token(u.email), "role": u.role, "name": u.name, "email": u.email}
    if u.role == "RESCUE_TEAM" and u.team_id:
        db = get_session()
        try:
            t = db.get(RescueTeam, u.team_id)
            out["team_id"] = u.team_id
            out["team_name"] = t.name if t else None
            out["team_specialty"] = t.specialty if t else None
        finally:
            db.close()
    return out


@app.post("/api/auth/register")
def register(b: RegisterIn, db: Session = Depends(db_dep)):
    """Citizens self-register. Control Room / Rescue Team accounts are provisioned
    ahead of time (see README test accounts) since they represent real personnel."""
    if db.get(User, b.email):
        raise HTTPException(400, "An account with this email already exists")
    if len(b.password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters")
    u = User(email=b.email, password_hash=hash_pw(b.password), role="CITIZEN", name=b.name)
    db.add(u)
    db.commit()
    return user_out(u)


@app.post("/api/auth/login")
def login(b: LoginIn, db: Session = Depends(db_dep)):
    u = db.get(User, b.email)
    if not u or not hmac.compare_digest(u.password_hash, hash_pw(b.password)):
        raise HTTPException(401, "Email or password is incorrect")
    return user_out(u)


@app.get("/api/me")
def me(user: User = Depends(get_current_user)):
    return user_out(user)


@app.get("/api/health")
def health():
    return {"status": "ok", "time": time.time(), "clients_connected": len(clients)}


# ================================================================================
# Weather (Open-Meteo, no API key) + forecast-derived early warning.
# Small in-memory cache so a busy dashboard doesn't hammer the upstream API.
# ================================================================================
_weather_cache: dict = {}
_weather_advisories_sent = set()


@app.get("/api/weather")
async def weather(lat: float = 11.9416, lng: float = 79.8083):
    key = (round(lat, 2), round(lng, 2))
    cached = _weather_cache.get(key)
    if cached and time.time() - cached["_t"] < 300:
        return cached["_data"]
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": lat, "longitude": lng,
                "current": "temperature_2m,precipitation,weather_code,wind_speed_10m",
                "hourly": "precipitation,precipitation_probability,wind_speed_10m",
                "forecast_hours": 12,
                "timezone": "auto",
            })
            r.raise_for_status()
            j = r.json()
        cur = j.get("current", {})
        hourly = j.get("hourly", {})
        probs = [float(x or 0) for x in hourly.get("precipitation_probability", [])[:12]]
        precip = [float(x or 0) for x in hourly.get("precipitation", [])[:12]]
        winds = [float(x or 0) for x in hourly.get("wind_speed_10m", [])[:12]]
        rain_prob = max(probs, default=0)
        max_hourly_rain = max(precip, default=0)
        forecast_rain_total = round(sum(precip), 1)
        max_wind = max(winds, default=float(cur.get("wind_speed_10m") or 0))
        # Prototype thresholds are deliberately described as advisory rules, not official alerts.
        triggers = []
        if rain_prob >= 70:
            triggers.append(f"rain probability up to {round(rain_prob)}%")
        if max_hourly_rain >= 10 or forecast_rain_total >= 25:
            triggers.append(f"forecast rainfall up to {max_hourly_rain:.1f} mm/h ({forecast_rain_total:.1f} mm/12h)")
        if max_wind >= 50:
            triggers.append(f"wind up to {max_wind:.0f} km/h")
        if len(triggers) >= 2 or max_hourly_rain >= 20 or max_wind >= 65:
            risk = "HIGH"
        elif triggers:
            risk = "MODERATE"
        else:
            risk = "LOW"
        data = {
            "temperature_c": cur.get("temperature_2m"),
            "precipitation_mm": cur.get("precipitation", 0),
            "rain_probability_pct": round(rain_prob),
            "forecast_rain_12h_mm": forecast_rain_total,
            "forecast_max_hourly_rain_mm": max_hourly_rain,
            "forecast_max_wind_kmh": round(max_wind, 1),
            "wind_speed_kmh": cur.get("wind_speed_10m"),
            "source": "Open-Meteo", "updated": time.time(),
            "forecast_window_hours": 12,
            "early_warning": {
                "level": risk,
                "label": "Forecast-derived Advisory" if risk != "LOW" else "Forecast conditions normal",
                "text": ("Multiple forecast risk indicators detected: " + "; ".join(triggers) if triggers
                         else "No configured rain or wind advisory threshold is currently met."),
                "triggers": triggers,
                "disclaimer": "Forecast-derived advisory, not an official warning. Thresholds are prototype rules; no government warning source is integrated.",
            },
        }
        _weather_cache[key] = {"_t": time.time(), "_data": data}
        if risk != "LOW":
            advisory_key = (key, risk, tuple(triggers))
            if advisory_key not in _weather_advisories_sent:
                _weather_advisories_sent.add(advisory_key)
                await broadcast("weather_advisory", {"location": {"lat": lat, "lng": lng}, "advisory": data["early_warning"], "weather": data})
        return data
    except Exception:
        raise HTTPException(503, "Weather service temporarily unavailable")


# ================================================================================
# Incidents
# ================================================================================
@app.get("/api/incidents")
def list_incidents(user: User = Depends(get_current_user), db: Session = Depends(db_dep)):
    q = db.query(Incident)
    if user.role == "CITIZEN":
        q = q.filter(Incident.citizen_email == user.email)
    return [enrich(i) for i in q.all()]


@app.post("/api/incidents", status_code=201)
async def add_incident(body: IncidentIn, user: User = Depends(require_roles("CITIZEN")), db: Session = Depends(db_dep)):
    """A real citizen SOS. Generates a unique SOS-XXXXXX id, computes real distance
    to the nearest team, persists it, and broadcasts it to every connected client."""
    iid = f"SOS-{random.randint(0, 0xFFFFF):05X}"
    while db.get(Incident, iid):
        iid = f"SOS-{random.randint(0, 0xFFFFF):05X}"
    _, dist = nearest_team(db, body.lat, body.lng)
    i = Incident(
        id=iid, citizen_email=user.email, type=body.type, lat=body.lat, lng=body.lng,
        location=f"{body.lat:.4f}°N, {body.lng:.4f}°E", people=max(1, body.people),
        children=max(0, body.children), elderly=max(0, body.elderly), injured=max(0, body.injured),
        severity=SEVERITY_BY_TYPE.get(body.type, 2), distance_km=dist if dist > 0 else None,
        description=body.description or "", source="citizen", status="NEW",
    )
    db.add(i)
    log_event(db, iid, "NEW", user.email, "SOS submitted by citizen")
    db.commit()
    payload = enrich(i)
    await broadcast("incident_created", payload)
    await broadcast("new_sos", {"incident": payload, "recipient": "AVAILABLE_RESCUE_TEAMS"})
    return payload


@app.get("/api/incidents/{iid}")
def get_incident(iid: str, user: User = Depends(get_current_user), db: Session = Depends(db_dep)):
    i = db.get(Incident, iid)
    if not i:
        raise HTTPException(404, "Incident not found")
    if user.role == "CITIZEN" and i.citizen_email != user.email:
        raise HTTPException(403, "Not your incident")
    return enrich(i)


@app.get("/api/incidents/{iid}/events")
def get_incident_events(iid: str, user: User = Depends(get_current_user), db: Session = Depends(db_dep)):
    if not db.get(Incident, iid):
        raise HTTPException(404, "Incident not found")
    evs = db.query(IncidentEvent).filter(IncidentEvent.incident_id == iid).order_by(IncidentEvent.timestamp).all()
    return [{"status": e.status, "actor": e.actor, "note": e.note, "timestamp": e.timestamp} for e in evs]


VALID_NEXT = {
    "NEW": {"ASSIGNED"},
    "ASSIGNED": {"ACCEPTED"},
    "ACCEPTED": {"ON_THE_WAY"},
    "ON_THE_WAY": {"REACHED"},
    "REACHED": {"COMPLETED", "RESOLVED"},
}


def _team_dict(t: RescueTeam) -> dict:
    return team_payload(t)


async def _complete_incident(db: Session, i: Incident, actor: str):
    """Persist completion and return the team to AVAILABLE only after completion."""
    i.status = "COMPLETED"
    log_event(db, i.id, "COMPLETED", actor, "Rescue completed")
    team = db.get(RescueTeam, i.team_id) if i.team_id else None
    if team:
        team.status = "COMPLETED"
    db.commit()
    payload = enrich(i)
    if team:
        await broadcast("team_updated", _team_dict(team))
    await broadcast("incident_updated", payload)
    await broadcast("incident_status_updated", payload)
    if team:
        team.status = "AVAILABLE"
        team.assigned_incident = None
        db.commit()
        await broadcast("team_updated", _team_dict(team))
        await broadcast("team_became_available", _team_dict(team))
    return payload


@app.patch("/api/incidents/{iid}")
async def patch_incident(iid: str, p: IncidentPatch, user: User = Depends(require_roles("RESCUE_TEAM", "CONTROL_ROOM")),
                          db: Session = Depends(db_dep)):
    """Advance an assigned incident through the operational state machine.
    Rescue teams may only update their own incident; control room may override.
    COMPLETED is the new canonical final state; RESOLVED remains accepted for legacy DB data."""
    i = db.get(Incident, iid)
    if not i:
        raise HTTPException(404, "Incident not found")
    if user.role == "RESCUE_TEAM" and i.team_id != user.team_id:
        raise HTTPException(403, "This incident is not assigned to your team")
    if not p.status:
        return enrich(i)
    target = "COMPLETED" if p.status == "RESOLVED" else p.status
    if user.role != "CONTROL_ROOM" and target not in VALID_NEXT.get(i.status, set()):
        raise HTTPException(400, f"Cannot move status from {i.status} to {target}")
    if i.status in ("COMPLETED", "RESOLVED"):
        raise HTTPException(409, "Incident is already completed")
    i.status = target
    team = db.get(RescueTeam, i.team_id) if i.team_id else None
    if target != "COMPLETED":
        log_event(db, iid, target, user.email)
    if team:
        if target == "ASSIGNED":
            team.status = "ASSIGNED"
        elif target == "ACCEPTED":
            team.status = "ACCEPTED"
        elif target == "ON_THE_WAY":
            team.status = "ON_THE_WAY"
        elif target == "REACHED":
            team.status = "REACHED"
    db.commit()
    if target == "COMPLETED":
        return await _complete_incident(db, i, user.email)
    payload = enrich(i)
    if team:
        await broadcast("team_updated", _team_dict(team))
    await broadcast("incident_updated", payload)
    await broadcast("incident_status_updated", payload)
    return payload


# ================================================================================
# Rescue teams
# ================================================================================
@app.get("/api/teams")
def list_teams(user: User = Depends(get_current_user), db: Session = Depends(db_dep)):
    return [team_payload(t) for t in db.query(RescueTeam).all()]


@app.patch("/api/teams/{tid}")
async def patch_team(tid: str, p: TeamPatch, user: User = Depends(require_roles("RESCUE_TEAM", "CONTROL_ROOM")),
                      db: Session = Depends(db_dep)):
    t = db.get(RescueTeam, tid)
    if not t:
        raise HTTPException(404, "Team not found")
    if user.role == "RESCUE_TEAM" and user.team_id != tid:
        raise HTTPException(403, "Not your team")
    if p.status is not None:
        allowed = {"AVAILABLE", "ASSIGNED", "ACCEPTED", "ON_THE_WAY", "REACHED", "COMPLETED"}
        if p.status not in allowed:
            raise HTTPException(400, "Invalid team status")
        if p.status == "AVAILABLE" and t.assigned_incident:
            raise HTTPException(409, "Complete or reassign the assigned incident before becoming available")
    for k, v in p.model_dump(exclude_none=True).items():
        setattr(t, k, v)
    if p.lat is not None or p.lng is not None:
        t.location_updated = time.time()
        t.location_source = "GPS"
    db.commit()
    out = _team_dict(t)
    await broadcast("team_updated", out)
    return out


@app.post("/api/incidents/{iid}/accept")
async def accept_incident(iid: str, user: User = Depends(require_roles("RESCUE_TEAM")),
                           db: Session = Depends(db_dep)):
    """Atomic first-team claim. SQLite's write transaction plus conditional UPDATEs prevents
    two rescue phones from claiming the same NEW incident or a second incident while busy."""
    team_id = user.team_id
    if not team_id:
        raise HTTPException(403, "Rescue account is not linked to a team")
    inc = db.get(Incident, iid)
    team = db.get(RescueTeam, team_id)
    if not inc or not team:
        raise HTTPException(404, "Incident or team not found")
    if team.status != "AVAILABLE" or team.assigned_incident:
        raise HTTPException(409, "Your team is busy and cannot accept another SOS")
    if inc.status != "NEW" or inc.team_id:
        raise HTTPException(409, "Already claimed")
    # Conditional updates are evaluated inside the same SQLite write transaction.
    team_result = db.execute(update(RescueTeam).where(
        RescueTeam.id == team_id, RescueTeam.status == "AVAILABLE", RescueTeam.assigned_incident.is_(None)
    ).values(status="ASSIGNED", assigned_incident=iid))
    if team_result.rowcount != 1:
        db.rollback()
        raise HTTPException(409, "Your team is no longer available")
    inc_result = db.execute(update(Incident).where(
        Incident.id == iid, Incident.status == "NEW", Incident.team_id.is_(None)
    ).values(team_id=team_id, status="ASSIGNED"))
    if inc_result.rowcount != 1:
        db.rollback()
        raise HTTPException(409, "Already claimed")
    log_event(db, iid, "ASSIGNED", user.email, f"Claimed by {team.name}")
    db.commit()
    inc = db.get(Incident, iid)
    team = db.get(RescueTeam, team_id)
    routed = False
    if team.location_source == "GPS" and team.location_updated:
        routed = await recalc_route(db, inc, team)
    payload = enrich(inc)
    team_out = _team_dict(team)
    await broadcast("team_updated", team_out)
    await broadcast("incident_claimed", {"incident": payload, "team": team_out})
    await broadcast("incident_updated", payload)
    await broadcast("route_updated", payload)
    return {"incident": payload, "team": team_out, "route_ok": routed}


@app.post("/api/incidents/{iid}/reassign")
async def reassign_incident(iid: str, b: ReassignIn, user: User = Depends(require_roles("CONTROL_ROOM")), db: Session = Depends(db_dep)):
    """Control-room override: move an active incident to an available team."""
    inc = db.get(Incident, iid)
    new_team = db.get(RescueTeam, b.team_id)
    if not inc:
        raise HTTPException(404, "Incident not found")
    if not new_team:
        raise HTTPException(404, "Target team not found")
    old_team = db.get(RescueTeam, inc.team_id) if inc.team_id else None
    if old_team and old_team.id == new_team.id:
        raise HTTPException(400, "Incident is already assigned to that team")
    if new_team.status != "AVAILABLE" or new_team.assigned_incident or not team_online(new_team.id):
        raise HTTPException(409, "Target team is not currently available/online")
    if inc.status in ("COMPLETED", "RESOLVED"):
        raise HTTPException(409, "Completed incident cannot be reassigned")
    if old_team:
        old_team.status, old_team.assigned_incident = "AVAILABLE", None
    new_team.status, new_team.assigned_incident = "ASSIGNED", inc.id
    inc.team_id, inc.status = new_team.id, "ASSIGNED"
    if new_team.location_source == "GPS" and new_team.location_updated:
        inc.distance_km = round(haversine_km(inc.lat, inc.lng, new_team.lat, new_team.lng), 1)
    log_event(db, inc.id, "ASSIGNED", user.email, f"Officer reassigned to {new_team.name}")
    db.commit()
    routed = False
    if new_team.location_source == "GPS" and new_team.location_updated:
        routed = await recalc_route(db, inc, new_team)
    payload = enrich(inc)
    if old_team:
        await broadcast("team_updated", _team_dict(old_team))
    await broadcast("team_updated", _team_dict(new_team))
    await broadcast("incident_reassigned", {"incident": payload, "team": _team_dict(new_team)})
    await broadcast("incident_updated", payload)
    await broadcast("route_updated", payload)
    return {"incident": payload, "team": _team_dict(new_team), "route_ok": routed}


@app.post("/api/teams/{tid}/assign")
async def assign_team(tid: str, b: AssignIn, user: User = Depends(require_roles("CONTROL_ROOM")), db: Session = Depends(db_dep)):
    """Legacy officer assignment endpoint, retained for compatibility."""
    team, inc = db.get(RescueTeam, tid), db.get(Incident, b.incident_id)
    if not team or not inc:
        raise HTTPException(404, "Team or incident not found")
    if team.status != "AVAILABLE" or team.assigned_incident or not team_online(team.id):
        raise HTTPException(409, "That team is not currently available/online")
    if inc.status != "NEW" or inc.team_id:
        raise HTTPException(409, "Incident is already claimed")
    team.status, team.assigned_incident = "ASSIGNED", inc.id
    inc.team_id, inc.status = team.id, "ASSIGNED"
    if team.location_source == "GPS" and team.location_updated:
        inc.distance_km = round(haversine_km(inc.lat, inc.lng, team.lat, team.lng), 1)
    log_event(db, inc.id, "ASSIGNED", user.email, f"Assigned to {team.name}")
    db.commit()
    routed = False
    if team.location_source == "GPS" and team.location_updated:
        routed = await recalc_route(db, inc, team)
    team_out = _team_dict(team)
    inc_payload = enrich(inc)
    await broadcast("team_updated", team_out)
    await broadcast("team_assigned", {"incident": inc_payload, "team": team_out})
    await broadcast("incident_assigned", {"incident": inc_payload, "team": team_out})
    await broadcast("incident_updated", inc_payload)
    await broadcast("route_updated", inc_payload)
    return {"team": team_out, "incident": inc_payload, "route_ok": routed}


class LocationIn(BaseModel):
    lat: float
    lng: float


@app.post("/api/teams/{tid}/location")
async def team_location(tid: str, b: LocationIn, user: User = Depends(require_roles("RESCUE_TEAM")),
                        db: Session = Depends(db_dep)):
    """A rescue phone reports its real GPS position. Stored, broadcast live, and - only after
    meaningful movement (>150 m, at most every 15 s) - the road route + ETA are recalculated."""
    t = db.get(RescueTeam, tid)
    if not t:
        raise HTTPException(404, "Team not found")
    if user.team_id != tid:
        raise HTTPException(403, "Not your team")
    if not (-90 <= b.lat <= 90 and -180 <= b.lng <= 180):
        raise HTTPException(400, "Invalid coordinates")
    t.lat, t.lng, t.location_updated, t.location_source = b.lat, b.lng, time.time(), "GPS"
    inc = db.get(Incident, t.assigned_incident) if t.assigned_incident else None
    db.commit()
    await broadcast("team_location_updated", {"team_id": t.id, "lat": t.lat, "lng": t.lng,
                                              "incident_id": inc.id if inc else None, "updated": t.location_updated})
    route_changed = False
    if inc and inc.status in ("ASSIGNED", "ACCEPTED", "ON_THE_WAY", "REACHED"):
        stale = inc.route_updated is None or time.time() - inc.route_updated >= ROUTE_MIN_INTERVAL_S
        origin = None
        try:
            g = json.loads(inc.route_geometry) if inc.route_geometry else None
            origin = g[0] if g else None
        except Exception:
            pass
        moved = origin is None or haversine_km(origin[0], origin[1], t.lat, t.lng) >= ROUTE_MIN_MOVE_KM
        if stale and moved:
            route_changed = await recalc_route(db, inc, t)
            await broadcast("route_updated", enrich(inc))
    return {"ok": True, "route_recalculated": route_changed}


@app.post("/api/incidents/{iid}/route")
async def retry_route(iid: str, user: User = Depends(require_roles("CONTROL_ROOM", "RESCUE_TEAM")),
                      db: Session = Depends(db_dep)):
    """Manual retry when OSRM was unreachable at assignment time."""
    inc = db.get(Incident, iid)
    if not inc or not inc.team_id:
        raise HTTPException(404, "Incident not found or no team assigned yet")
    if user.role == "RESCUE_TEAM" and inc.team_id != user.team_id:
        raise HTTPException(403, "This incident is not assigned to your team")
    ok = await recalc_route(db, inc, db.get(RescueTeam, inc.team_id))
    payload = enrich(inc)
    await broadcast("route_updated", payload)
    if not ok:
        raise HTTPException(503, "Route unavailable - unable to calculate road route right now")
    return payload


_geo_cache: dict = {}


@app.get("/api/geocode")
async def reverse_geocode(lat: float, lng: float, user: User = Depends(get_current_user)):
    """Reverse geocoding via OpenStreetMap Nominatim (cached, low volume). Returns
    {"address": null} on any failure - the UI then shows coordinates only. Never invents text."""
    key = (round(lat, 4), round(lng, 4))
    if key in _geo_cache:
        return {"address": _geo_cache[key]}
    try:
        async with httpx.AsyncClient(timeout=5, headers={"User-Agent": "ResQ-Command-student-prototype/1.0"}) as client:
            r = await client.get("https://nominatim.openstreetmap.org/reverse",
                                 params={"lat": lat, "lon": lng, "format": "jsonv2", "zoom": 16})
            r.raise_for_status()
            addr = r.json().get("display_name")
        _geo_cache[key] = addr
        return {"address": addr}
    except Exception:
        return {"address": None}


@app.get("/api/statistics")
def statistics(user: User = Depends(require_roles("CONTROL_ROOM")), db: Session = Depends(db_dep)):
    incidents, teams = db.query(Incident).all(), db.query(RescueTeam).all()
    open_ = [i for i in incidents if i.status not in ("COMPLETED", "RESOLVED")]
    return {
        "active_incidents": len(open_),
        "people_at_risk": sum(i.people for i in open_),
        "available_teams": sum(team_payload(t)["availability"] == "AVAILABLE" for t in teams),
        "teams_total": len(teams),
        "critical_incidents": sum(1 for i in open_ if enrich(i)["priority"] == "P1"),
    }


@app.post("/api/priority-score")
def priority_score(s: ScoreIn):
    return compute_priority(s)


# ================================================================================
# Phone-friendly pages (clean URLs, same static files)
# ================================================================================
@app.get("/citizen")
def citizen_page():
    return FileResponse(os.path.join(FRONTEND_DIR, "citizen.html"))


@app.get("/rescue")
def rescue_page():
    return FileResponse(os.path.join(FRONTEND_DIR, "rescue.html"))


@app.get("/dashboard")
def dashboard_page():
    return FileResponse(os.path.join(FRONTEND_DIR, "dashboard.html"))


# Serve the rest of the frontend last so /api, /ws, /citizen, /rescue take precedence
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="web")
