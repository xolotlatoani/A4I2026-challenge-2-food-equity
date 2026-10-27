#!/usr/bin/env python3
"""Geocode every recipient's street address to the 2020 census tract it actually sits in.

The notebook places each organization at its ZIP centroid, and 118 organizations share just 35
of them, so neighbors across a ZIP get the same tract and the same need. This sends each street
address to the Census Bureau's batch geocoder (public domain, no key needed), loads the result
into a4i_food.recipient_geocodes, then runs sql/04_build_recipient_tracts.sql to build
a4i_food.recipient_tracts: one row per recipient with its tract's ACS figures and need score.

    python3 scripts/geocode_recipients.py

Needs google-cloud-bigquery and application default credentials (Cloud Shell has both).
Safe to re-run: both tables are replaced. About a minute.
"""

from __future__ import annotations

import csv
import io
import os
from collections import Counter
from pathlib import Path

import requests
from google.cloud import bigquery

REPO = Path(__file__).resolve().parent.parent
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-ef48e08bc216")
DATASET = os.environ.get("BIGQUERY_DATASET", "a4i_food")

# "Current" tracts are the 2020 census tracts, which is what ACS 2016-2020 is published on.
GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/addressbatch"
BENCHMARK, VINTAGE = "Public_AR_Current", "Current_Current"

SCHEMA = [
    bigquery.SchemaField("recipient_id", "INT64"),
    bigquery.SchemaField("match_status", "STRING"),     # Match, No_Match or Tie
    bigquery.SchemaField("match_type", "STRING"),       # Exact or Non_Exact
    bigquery.SchemaField("matched_address", "STRING"),
    bigquery.SchemaField("latitude", "FLOAT64"),
    bigquery.SchemaField("longitude", "FLOAT64"),
    bigquery.SchemaField("tract_geo_id", "STRING"),     # 11 digits: state, county, tract
]


def geocode(addresses):
    """POST id,street,city,state,zip rows to the batch geocoder; return its rows by id."""
    buf = io.StringIO()
    csv.writer(buf).writerows(addresses)
    resp = requests.post(
        GEOCODER,
        files={"addressFile": ("addresses.csv", buf.getvalue(), "text/csv")},
        data={"benchmark": BENCHMARK, "vintage": VINTAGE},
        timeout=300,
    )
    resp.raise_for_status()
    return {row[0]: row for row in csv.reader(io.StringIO(resp.text)) if row}


def to_record(recipient_id, row):
    # Matched rows: id, input, status, type, matched address, "lon,lat", tiger id, side,
    # state, county, tract, block. Unmatched rows stop after the status.
    record = {"recipient_id": recipient_id, "match_status": row[2] if len(row) > 2 else None}
    if record["match_status"] == "Match" and len(row) >= 11:
        lon, lat = (float(v) for v in row[5].split(","))
        record.update(match_type=row[3], matched_address=row[4], latitude=lat, longitude=lon,
                      tract_geo_id=row[8] + row[9] + row[10])
    return record


def main():
    client = bigquery.Client(project=PROJECT)
    addresses = [
        [r["recipient_id"], r["street"], r["city"], r["state"], r["zip_code"]]
        for r in client.query(f"""
            SELECT recipient_id, street, city, state, zip_code
            FROM `{PROJECT}.{DATASET}.recipients`
            WHERE street != ''
            ORDER BY recipient_id""").result()
    ]
    print(f"Geocoding {len(addresses)} street addresses with the Census Bureau...")
    results = geocode(addresses)
    records = [to_record(a[0], results.get(str(a[0]), [])) for a in addresses]

    table = f"{PROJECT}.{DATASET}.recipient_geocodes"
    client.load_table_from_json(records, table, job_config=bigquery.LoadJobConfig(
        schema=SCHEMA, write_disposition="WRITE_TRUNCATE")).result()
    print(f"Loaded {table}: "
          + ", ".join(f"{k} {v}" for k, v in Counter(
              r.get("match_type") or r["match_status"] for r in records).items()))

    client.query((REPO / "sql" / "04_build_recipient_tracts.sql").read_text()).result()
    print(f"Built {PROJECT}.{DATASET}.recipient_tracts:")
    for row in client.query(f"""
            SELECT tract_source, COUNT(*) AS n, COUNT(DISTINCT tract_geo_id) AS tracts,
                   ROUND(AVG(need_score), 2) AS avg_need
            FROM `{PROJECT}.{DATASET}.recipient_tracts`
            GROUP BY tract_source ORDER BY n DESC""").result():
        print(f"  {row['tract_source']:<13} {row['n']:>4} recipients in {row['tracts']:>3} tracts, "
              f"average need {row['avg_need']}")


if __name__ == "__main__":
    main()
