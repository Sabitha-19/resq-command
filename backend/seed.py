"""OPTIONAL dev-only seed script - NOT run automatically by the server.

Loads a couple of clearly-fake incidents so you can eyeball the dashboard UI
without doing a real SOS every time. Never run this before a real demo -
judges should see "Active Incidents: 0" until a real citizen sends an SOS.

Usage:
    cd backend
    python seed.py
"""
import time
from database import init_db, get_session, User, Incident

SEED_INCIDENTS = [
    dict(id="SOS-SEED1", citizen_email=None, type="Flood", location="Ariyankuppam Riverside (SEED)",
         lat=11.9075, lng=79.81, people=8, children=1, elderly=1, injured=0, severity=3,
         distance_km=1.2, description="Seed data for UI development only.", source="seed", status="NEW",
         created=time.time()),
    dict(id="SOS-SEED2", citizen_email=None, type="Landslide", location="Kalapet Hillside (SEED)",
         lat=12.008, lng=79.8552, people=3, children=0, elderly=1, injured=0, severity=2,
         distance_km=3.4, description="Seed data for UI development only.", source="seed", status="NEW",
         created=time.time()),
]


def main():
    init_db()
    db = get_session()
    try:
        if not db.get(User, "citizen@resq.demo"):
            from main import hash_pw  # reuse the same hashing as the API
            db.add(User(email="citizen@resq.demo", password_hash=hash_pw("resq123"),
                        role="CITIZEN", name="Lobasri (seed citizen)"))
        for row in SEED_INCIDENTS:
            if not db.get(Incident, row["id"]):
                db.add(Incident(**row))
        db.commit()
        print(f"Seeded {len(SEED_INCIDENTS)} demo incidents (source='seed'). "
              "Remove them by deleting backend/resq.db before a real demo.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
