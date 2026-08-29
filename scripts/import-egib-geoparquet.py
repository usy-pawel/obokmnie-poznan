from __future__ import annotations

import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path

import duckdb


PROJECT = Path(__file__).resolve().parents[1]
STAGE_PATH = Path(os.environ.get("OBOKMNIE_STAGE", PROJECT / ".cache" / "poland-stage.sqlite"))
PARQUET_PATH = Path(os.environ.get(
    "OBOKMNIE_EGIB_PARQUET",
    PROJECT.parent / "work" / "obokmnie" / "egib" / "0_dzialki.parquet",
))
DUCKDB_TEMP = PROJECT.parent / "work" / "obokmnie" / "duckdb-temp"


def sql_path(path):
    return str(path.resolve()).replace("\\", "/").replace("'", "''")


def ensure_cache(database):
    database.execute("""
      CREATE TABLE IF NOT EXISTS parcel_cache (
        requested_id TEXT PRIMARY KEY, returned_id TEXT, geom_wkt TEXT,
        geometry_json TEXT, datasource TEXT, error TEXT, updated_at TEXT NOT NULL
      )
    """)
    database.commit()


def main():
    started = time.perf_counter()
    if not STAGE_PATH.exists():
        raise RuntimeError(f"Brak etapu SQLite: {STAGE_PATH}")
    if not PARQUET_PATH.exists():
        raise RuntimeError(f"Brak krajowego GeoParquet: {PARQUET_PATH}")
    DUCKDB_TEMP.mkdir(parents=True, exist_ok=True)

    stage = sqlite3.connect(STAGE_PATH)
    ensure_cache(stage)
    requested = stage.execute(
        "SELECT count(DISTINCT parcel_id) FROM source_rows WHERE parcel_id<>''"
    ).fetchone()[0]
    stage.close()

    analytical = duckdb.connect()
    analytical.install_extension("spatial")
    analytical.load_extension("spatial")
    analytical.execute(f"SET temp_directory='{sql_path(DUCKDB_TEMP)}'")
    analytical.execute("SET memory_limit='8GB'")
    analytical.execute("SET preserve_insertion_order=false")
    analytical.execute(f"ATTACH '{sql_path(STAGE_PATH)}' AS stage (TYPE sqlite, READ_ONLY)")
    print(f"Preparing variants for {requested} requested parcel ids", flush=True)
    analytical.execute("""
      CREATE TEMP TABLE wanted AS
      WITH ids AS (
        SELECT DISTINCT parcel_id AS requested_id
        FROM stage.source_rows WHERE parcel_id<>''
      ), variants AS (
        SELECT requested_id, requested_id AS lookup_id, 1 AS variant_rank FROM ids
        UNION ALL
        SELECT requested_id,
               regexp_replace(requested_id, '\\.AR_0+([0-9]+)\\.', '.AR_\\1.'), 2
        FROM ids WHERE regexp_matches(requested_id, '\\.AR_0+[0-9]+\\.')
        UNION ALL
        SELECT requested_id,
               regexp_replace(requested_id, '\\s+(część|cz\\.).*$', '', 'i'), 3
        FROM ids WHERE regexp_matches(requested_id, '\\s+(część|cz\\.).*$', 'i')
        UNION ALL
        SELECT requested_id,
               regexp_replace(
                 regexp_replace(requested_id, '\\s+(część|cz\\.).*$', '', 'i'),
                 '\\.AR_[^.]+\\.', '.', 'i'
               ), 4
        FROM ids WHERE regexp_matches(requested_id, '\\.AR_[^.]+\\.', 'i')
      )
      SELECT DISTINCT requested_id, lookup_id, variant_rank
      FROM variants WHERE lookup_id<>''
    """)
    analytical.execute("ANALYZE wanted")
    variant_count = analytical.execute("SELECT count(*) FROM wanted").fetchone()[0]
    print(f"Prepared {variant_count} exact lookup variants", flush=True)

    parquet = sql_path(PARQUET_PATH)
    analytical.execute(f"""
      CREATE TEMP TABLE matched AS
      SELECT requested_id, id_dzialki AS returned_id,
             ST_AsText(ST_Transform(geometry, 'EPSG:2180', 'EPSG:4326', always_xy := true)) AS geom_wkt
      FROM (
        SELECT w.requested_id, w.variant_rank, e.id_dzialki, e.geometry,
               row_number() OVER (
                 PARTITION BY w.requested_id ORDER BY w.variant_rank, e.id_dzialki
               ) AS match_rank
        FROM wanted w
        JOIN read_parquet('{parquet}') e ON upper(e.id_dzialki)=upper(w.lookup_id)
        WHERE e.geometry IS NOT NULL
      ) matches
      WHERE match_rank=1
    """)
    analytical.execute("DETACH stage")
    matched = analytical.execute("SELECT count(*) FROM matched").fetchone()[0]
    print(f"Matched {matched}/{requested} parcel ids", flush=True)

    stage = sqlite3.connect(STAGE_PATH)
    ensure_cache(stage)
    cursor = analytical.execute("SELECT requested_id,returned_id,geom_wkt FROM matched ORDER BY requested_id")
    stored = 0
    now = datetime.now().isoformat()
    while True:
        rows = cursor.fetchmany(1000)
        if not rows:
            break
        stage.executemany(
            "INSERT OR REPLACE INTO parcel_cache VALUES (?,?,?,?,?,?,?)",
            [(requested_id, returned_id, geom_wkt, None, "GUGiK EGiB GeoParquet", None, now)
             for requested_id, returned_id, geom_wkt in rows],
        )
        stage.commit()
        stored += len(rows)
        if stored % 10000 == 0 or stored == matched:
            print(f"Stored {stored}/{matched} matched parcels", flush=True)

    total_cached = stage.execute("SELECT count(*) FROM parcel_cache").fetchone()[0]
    usable_cached = stage.execute(
        "SELECT count(*) FROM parcel_cache WHERE geom_wkt IS NOT NULL OR geometry_json IS NOT NULL"
    ).fetchone()[0]
    stage.close()
    analytical.close()
    print({
        "requested_parcels": requested,
        "matched_geoparquet": matched,
        "cache_rows": total_cached,
        "usable_cache_rows": usable_cached,
        "elapsed_seconds": round(time.perf_counter() - started, 2),
    })


if __name__ == "__main__":
    main()
