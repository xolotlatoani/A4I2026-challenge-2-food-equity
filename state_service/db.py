"""Connections to the offer-state database.

On Cloud Run the service signs in to Cloud SQL as its own service account (IAM database
login), through the Cloud SQL Python Connector, so there is no password to keep anywhere.
Locally, set DATABASE_URL to any Postgres instead, e.g.
postgresql+pg8000://postgres@localhost:5432/food_rescue.

Environment:
  DATABASE_URL              a SQLAlchemy URL; when set, the Cloud SQL settings are ignored
  INSTANCE_CONNECTION_NAME  project:region:instance
  DB_NAME                   database name (default food_rescue)
  DB_IAM_USER               the service account's database user: its email without
                            ".gserviceaccount.com"
  DB_PRIVATE_IP             set to 1 to reach the instance on its private IP
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import sqlalchemy
from sqlalchemy.engine import Engine

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def make_engine(user: str | None = None, password: str | None = None) -> Engine:
    """An engine for DATABASE_URL, or for the Cloud SQL instance.

    With no password the connection signs in with IAM as `user` (default DB_IAM_USER).
    apply_schema.py passes the built-in postgres user and its password instead.
    """
    url = os.environ.get("DATABASE_URL")
    if url:
        return sqlalchemy.create_engine(url, pool_pre_ping=True)

    from google.cloud.sql.connector import Connector, IPTypes

    instance = os.environ["INSTANCE_CONNECTION_NAME"]
    db_name = os.environ.get("DB_NAME", "food_rescue")
    db_user = user or os.environ["DB_IAM_USER"]
    ip_type = IPTypes.PRIVATE if os.environ.get("DB_PRIVATE_IP") else IPTypes.PUBLIC
    # Lazy refresh: Cloud Run throttles CPU between requests, which starves background refresh.
    connector = Connector(refresh_strategy="lazy")

    sign_in = {"password": password} if password else {"enable_iam_auth": True}

    def getconn():
        return connector.connect(
            instance, "pg8000", user=db_user, db=db_name, ip_type=ip_type, **sign_in)

    return sqlalchemy.create_engine(
        "postgresql+pg8000://", creator=getconn,
        pool_size=5, max_overflow=2, pool_recycle=1800, pool_pre_ping=True,
    )


def schema_statements() -> list[str]:
    """schema.sql split into statements. It has no string literals holding ';' or '--'."""
    sql = re.sub(r"--[^\n]*", "", SCHEMA_PATH.read_text())
    return [s.strip() for s in sql.split(";") if s.strip()]
