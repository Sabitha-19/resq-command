"""ResQ Command - SQLite + SQLAlchemy persistence layer.

Deliberately minimal: 4 tables (users, rescue_teams, incidents, incident_events),
no migrations framework. Good enough for a hackathon prototype where data must
survive a server restart, but doesn't need to survive a schema change.
"""
import os
import time
from sqlalchemy import (create_engine, Column, String, Integer, Float, ForeignKey, Text, inspect, text)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

DB_PATH = os.getenv("RESQ_DB_PATH", os.path.join(os.path.dirname(__file__), "resq.db"))
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    email = Column(String, primary_key=True)
    password_hash = Column(String, nullable=False)
    role = Column(String, nullable=False)          # CITIZEN | CONTROL_ROOM | RESCUE_TEAM
    name = Column(String, nullable=False)
    team_id = Column(String, ForeignKey("rescue_teams.id"), nullable=True)  # only for RESCUE_TEAM
    created = Column(Float, default=time.time)

    team = relationship("RescueTeam", backref="members_list")


class RescueTeam(Base):
    __tablename__ = "rescue_teams"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    specialty = Column(String, default="General Rescue")
    status = Column(String, default="AVAILABLE")    # AVAILABLE | ASSIGNED | ACCEPTED | ON_THE_WAY | REACHED | COMPLETED
    members = Column(Integer, default=4)
    readiness = Column(Integer, default=90)
    lat = Column(Float, default=11.93)
    lng = Column(Float, default=79.83)
    location_updated = Column(Float, nullable=True, default=None)
    location_source = Column(String, default="CONFIGURED_BASE")  # CONFIGURED_BASE | GPS
    assigned_incident = Column(String, nullable=True)


class Incident(Base):
    __tablename__ = "incidents"
    id = Column(String, primary_key=True)
    citizen_email = Column(String, ForeignKey("users.email"), nullable=True)
    type = Column(String, nullable=False)
    location = Column(String, nullable=True)
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    people = Column(Integer, default=1)
    children = Column(Integer, default=0)
    elderly = Column(Integer, default=0)
    injured = Column(Integer, default=0)
    severity = Column(Integer, default=2)
    distance_km = Column(Float, nullable=True, default=None)
    description = Column(String, default="")
    source = Column(String, default="citizen")      # "citizen" (real) or "seed" (dev-only fixture)
    status = Column(String, default="NEW")           # NEW>ASSIGNED>ACCEPTED>ON_THE_WAY>REACHED>COMPLETED
    team_id = Column(String, ForeignKey("rescue_teams.id"), nullable=True)
    created = Column(Float, default=time.time)
    # Road route from the assigned team to the citizen (OSRM). NULL until a route has
    # actually been calculated - nothing here is ever hand-typed or estimated.
    route_km = Column(Float, nullable=True)
    route_min = Column(Integer, nullable=True)
    route_geometry = Column(Text, nullable=True)      # JSON list of [lat, lng]
    route_updated = Column(Float, nullable=True)


class IncidentEvent(Base):
    __tablename__ = "incident_events"
    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(String, ForeignKey("incidents.id"), nullable=False)
    status = Column(String, nullable=False)
    actor = Column(String, nullable=True)            # email of whoever caused the event, or "system"
    note = Column(String, nullable=True)
    timestamp = Column(Float, default=time.time)


def init_db():
    Base.metadata.create_all(engine)
    _add_missing_columns()


def _add_missing_columns():
    """Safe, additive migration so an existing resq.db keeps working: any column that
    the models define but the table lacks is added with ALTER TABLE ADD COLUMN."""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in existing:
                    ctype = col.type.compile(engine.dialect)
                    conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN {col.name} {ctype}'))


def get_session():
    return SessionLocal()
