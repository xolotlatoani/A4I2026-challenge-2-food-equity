"""Create or update the offer-state tables, then let the service's IAM user use them.

Runs as the built-in postgres user, because on Postgres 15+ only the schema owner can create
tables in `public`. setup_cloudsql.sh calls it; run it again after editing schema.sql:

    DB_ADMIN_PASSWORD=... INSTANCE_CONNECTION_NAME=... DB_IAM_USER=... python apply_schema.py

Locally, with DATABASE_URL set, it just runs schema.sql there.
"""

from __future__ import annotations

import os

from sqlalchemy import text

from db import make_engine, schema_statements


def main() -> None:
    if os.environ.get("DATABASE_URL"):
        engine = make_engine()
    else:
        engine = make_engine(user="postgres", password=os.environ["DB_ADMIN_PASSWORD"])
    iam_user = os.environ.get("DB_IAM_USER")

    with engine.begin() as conn:
        for statement in schema_statements():
            conn.execute(text(statement))
        if iam_user and not os.environ.get("DATABASE_URL"):
            # The service reads and writes; it never changes the schema or deletes history.
            conn.execute(text(f'GRANT USAGE ON SCHEMA public TO "{iam_user}"'))
            conn.execute(text(
                f'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO "{iam_user}"'))
            conn.execute(text(f'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "{iam_user}"'))
    print(f"Applied {len(schema_statements())} statements"
          + (f" and granted access to {iam_user}" if iam_user else ""))


if __name__ == "__main__":
    main()
