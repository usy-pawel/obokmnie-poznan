from __future__ import annotations

import concurrent.futures
import csv
import io
import json
import os
import re
import sqlite3
import threading
import time
import zipfile
from collections import Counter
from datetime import date, datetime
from pathlib import Path

try:
    import psycopg
except ImportError:
    psycopg = None

try:
    import requests
except ImportError:
    requests = None


PROJECT = Path(__file__).resolve().parents[1]
ZIP_DIR = Path(os.environ.get("OBOKMNIE_ZIP_DIR", PROJECT.parent / "work" / "obokmnie" / "poland-zips"))
STAGE_PATH = Path(os.environ.get("OBOKMNIE_STAGE", PROJECT / ".cache" / "poland-stage.sqlite"))
LEGACY_CACHE = PROJECT / ".cache" / "wielkopolska-uldk-geometries.json"
MAX_WORKERS = int(os.environ.get("OBOKMNIE_WORKERS", "48"))
FETCH_BATCH = int(os.environ.get("OBOKMNIE_FETCH_BATCH", "250"))
FETCH_LIMIT = int(os.environ.get("OBOKMNIE_FETCH_LIMIT", "-1"))
STAGE_ONLY = os.environ.get("OBOKMNIE_STAGE_ONLY") == "1"
REUSE_STAGE = os.environ.get("OBOKMNIE_REUSE_STAGE") == "1"
PERIOD_END = os.environ.get("OBOKMNIE_PERIOD_END")
PERIOD_START = os.environ.get("OBOKMNIE_PERIOD_START")
RETRY_ERRORS = os.environ.get("OBOKMNIE_RETRY_ERRORS") == "1"
FETCH_ONLY = os.environ.get("OBOKMNIE_FETCH_ONLY") == "1"
SKIP_ULDK = os.environ.get("OBOKMNIE_SKIP_ULDK") == "1"
DOWNLOAD_ARCHIVES = os.environ.get("OBOKMNIE_DOWNLOAD_ARCHIVES") == "1"
MIN_STAGE_CASES = int(os.environ.get("OBOKMNIE_MIN_STAGE_CASES", "100000"))
MIN_STAGE_RATIO = float(os.environ.get("OBOKMNIE_MIN_STAGE_RATIO", "0.75"))
MAX_STAGE_RATIO = float(os.environ.get("OBOKMNIE_MAX_STAGE_RATIO", "1.5"))
MIN_PUBLISHED_RATIO = float(os.environ.get("OBOKMNIE_MIN_PUBLISHED_RATIO", "0.45"))
POLAND_BOUNDS = (14.0, 48.8, 24.3, 55.3)
THREAD_LOCAL = threading.local()
ACTIVE_IMPORT_ID = None


def clean(value):
    return (value or "").replace("[object Object]", "").strip().strip('"').strip()


def unique_header(header):
    seen = Counter()
    result = []
    for name in header:
        seen[name] += 1
        result.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return result


def iter_archive(path):
    with zipfile.ZipFile(path) as archive:
        csv_name = next(name for name in archive.namelist() if name.lower().endswith(".csv"))
        with archive.open(csv_name) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as text:
            reader = csv.reader(text, delimiter=";")
            header = unique_header(next(reader))
            for values in reader:
                if len(values) == len(header):
                    yield dict(zip(header, values))


def parse_date(value):
    try:
        return datetime.strptime(clean(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def subtract_year(value):
    try:
        return value.replace(year=value.year - 1)
    except ValueError:
        return value.replace(year=value.year - 1, day=28)


def street_name(row):
    return re.sub(r"\s+", " ", f"{clean(row.get('ulica_dalej'))} {clean(row.get('ulica'))}").strip()


def address_for(row):
    street = street_name(row)
    house = clean(row.get("nr_domu"))
    city = clean(row.get("miasto"))
    address = " ".join(part for part in [street, house] if part)
    return ", ".join(part for part in [address, city] if part) or city


def parcel_ids(row, unit_field):
    unit = clean(row.get(unit_field))
    district = clean(row.get("obreb_numer"))
    sheet = clean(row.get("numer_arkusza_dzialki"))
    parcels = clean(row.get("numer_dzialki"))
    if not unit or not district or not parcels:
        return []
    result = []
    for parcel in re.split(r"\s*,\s*", parcels):
        parcel = clean(parcel)
        if parcel:
            result.append(f"{unit}.{district}.AR_{sheet}.{parcel}" if sheet else f"{unit}.{district}.{parcel}")
    return result


def normalize(row, source_type, fallback_voivodeship):
    if source_type == "wniosek_decyzja":
        received = parse_date(row.get("data_wplywu_wniosku"))
        return {
            "source_type": source_type,
            "external_id": clean(row.get("numer_gunb")),
            "received_date": received,
            "decision_date": parse_date(row.get("data_wydania_decyzji")),
            "status": "decyzja wydana" if clean(row.get("numer_decyzji_urzedu")) else "wniosek",
            "office": clean(row.get("nazwa_organu")),
            "voivodeship": clean(row.get("wojewodztwo")) or fallback_voivodeship,
            "city": clean(row.get("miasto")),
            "address": address_for(row),
            "case_kind": clean(row.get("rodzaj_inwestycji")),
            "description": clean(row.get("nazwa_zam_budowlanego")) or clean(row.get("nazwa_zamierzenia_bud")) or "Sprawa budowlana",
            "parcel_ids": parcel_ids(row, "jednosta_numer_ew"),
        }
    return {
        "source_type": source_type,
        "external_id": clean(row.get("numer_ewidencyjny_system")),
        "received_date": parse_date(row.get("data_wplywu_wniosku_do_urzedu")),
        "decision_date": None,
        "status": clean(row.get("stan")) or "brak statusu",
        "office": clean(row.get("nazwa_organu")),
        "voivodeship": clean(row.get("wojewodztwo_objekt")),
        "city": clean(row.get("miasto")),
        "address": address_for(row),
        "case_kind": clean(row.get("rodzaj_zam_budowlanego")),
        "description": clean(row.get("nazwa_zam_budowlanego")) or "Sprawa budowlana",
        "parcel_ids": parcel_ids(row, "jednostki_numer"),
    }


def source_archives():
    archives = []
    for path in sorted(ZIP_DIR.glob("*.zip")):
        source_type = "zgloszenie" if "zgloszenia" in path.name else "wniosek_decyzja"
        province = path.stem.removeprefix("wynik_").replace("-", " ") if source_type == "wniosek_decyzja" else ""
        date_field = "data_wplywu_wniosku_do_urzedu" if source_type == "zgloszenie" else "data_wplywu_wniosku"
        archives.append((path, source_type, province, date_field))
    if len(archives) != 18:
        raise RuntimeError(f"Oczekiwano 18 archiwów GUNB, znaleziono {len(archives)}")
    return archives


def open_stage():
    STAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(STAGE_PATH)
    database.execute("PRAGMA journal_mode=WAL")
    database.execute("PRAGMA synchronous=NORMAL")
    database.execute("PRAGMA temp_store=FILE")
    return database


def build_stage(database, archives, cutoff, newest):
    database.executescript("""
        DROP TABLE IF EXISTS source_rows;
        DROP TABLE IF EXISTS staged_cases;
        CREATE TABLE source_rows (
          source_type TEXT NOT NULL, external_id TEXT NOT NULL, received_date TEXT NOT NULL,
          decision_date TEXT, status TEXT NOT NULL, office TEXT NOT NULL, voivodeship TEXT NOT NULL,
          city TEXT NOT NULL, address TEXT NOT NULL, case_kind TEXT NOT NULL,
          description TEXT NOT NULL, parcel_id TEXT NOT NULL
        );
    """)
    insert_sql = "INSERT INTO source_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    total = 0
    by_province = Counter()
    for path, source_type, fallback_province, _date_field in archives:
        batch = []
        for raw in iter_archive(path):
            row = normalize(raw, source_type, fallback_province)
            if not row["external_id"] or not row["received_date"] or not cutoff <= row["received_date"] <= newest:
                continue
            province = row["voivodeship"].casefold()
            parcels = row["parcel_ids"] or [""]
            for parcel_id in parcels:
                batch.append((
                    row["source_type"], row["external_id"], row["received_date"].isoformat(),
                    row["decision_date"].isoformat() if row["decision_date"] else None,
                    row["status"], row["office"], province, row["city"], row["address"],
                    row["case_kind"], row["description"], parcel_id,
                ))
            total += 1
            by_province[province] += 1
            if len(batch) >= 5000:
                database.executemany(insert_sql, batch)
                database.commit()
                batch.clear()
        if batch:
            database.executemany(insert_sql, batch)
            database.commit()
        print(f"Staged {path.name}", flush=True)
    database.executescript("""
        CREATE INDEX source_rows_case_idx ON source_rows(source_type, external_id);
        CREATE INDEX source_rows_parcel_idx ON source_rows(parcel_id) WHERE parcel_id <> '';
        CREATE TABLE staged_cases AS
        WITH ranked AS (
          SELECT *, row_number() OVER (
            PARTITION BY source_type, external_id
            ORDER BY length(description) DESC, length(office) DESC, received_date DESC
          ) AS rank
          FROM source_rows
        ), aggregated AS (
          SELECT source_type, external_id, min(received_date) AS received_date,
                 max(decision_date) AS decision_date, group_concat(DISTINCT status) AS statuses,
                 json_group_array(DISTINCT parcel_id) FILTER (WHERE parcel_id <> '') AS parcel_ids
          FROM source_rows GROUP BY source_type, external_id
        )
        SELECT a.source_type, a.external_id, a.received_date, a.decision_date, a.statuses,
               r.office, r.voivodeship, r.city, r.address, r.case_kind, r.description,
               coalesce(a.parcel_ids, '[]') AS parcel_ids
        FROM aggregated a JOIN ranked r USING(source_type, external_id) WHERE r.rank=1;
        CREATE UNIQUE INDEX staged_cases_key_idx ON staged_cases(source_type, external_id);
    """)
    database.commit()
    return {"normalized_rows": total, "source_rows_by_voivodeship": dict(by_province)}


def variants_for(parcel_id):
    variants = [parcel_id]
    normalized = re.sub(r"\.AR_0+(\d+)\.", r".AR_\1.", parcel_id)
    if normalized not in variants:
        variants.append(normalized)
    without_annotations = re.sub(r"\s+(?:część|cz\.).*$", "", parcel_id, flags=re.I).strip()
    if without_annotations and without_annotations not in variants:
        variants.append(without_annotations)
    without_sheet = re.sub(r"\.AR_[^.]+\.", ".", without_annotations, count=1, flags=re.I)
    if without_sheet and without_sheet not in variants:
        variants.append(without_sheet)
    return variants


def fetch_parcel(parcel_id):
    if requests is None:
        raise RuntimeError("Zainstaluj zależności: pip install -r scripts/requirements.txt")
    if not hasattr(THREAD_LOCAL, "session"):
        THREAD_LOCAL.session = requests.Session()
        THREAD_LOCAL.session.headers.update({"User-Agent": "obokmnie-polska/1.0"})
    for attempt in range(3):
        try:
            for variant in variants_for(parcel_id):
                query = {
                    "request": "GetParcelById", "id": variant,
                    "result": "id,geom_wkt,region,parcel,datasource", "srid": "4326",
                }
                response = THREAD_LOCAL.session.get("https://uldk.gugik.gov.pl/", params=query, timeout=(5, 20))
                response.raise_for_status()
                lines = response.text.strip().splitlines()
                for line in lines[1:]:
                    parts = line.split("|", 4)
                    if len(parts) >= 2 and parts[0].casefold() == variant.casefold():
                        return parcel_id, parts[0], parts[1], parts[4] if len(parts) > 4 else "ULDK", None
            return parcel_id, None, None, None, "no exact result"
        except Exception as error:
            if attempt == 2:
                return parcel_id, None, None, None, str(error)
            time.sleep(0.4 * (2**attempt))


def ensure_parcel_cache(database):
    database.execute("""
      CREATE TABLE IF NOT EXISTS parcel_cache (
        requested_id TEXT PRIMARY KEY, returned_id TEXT, geom_wkt TEXT,
        geometry_json TEXT, datasource TEXT, error TEXT, updated_at TEXT NOT NULL
      )
    """)


def seed_legacy_cache(database):
    ensure_parcel_cache(database)
    if not LEGACY_CACHE.exists() or database.execute("SELECT count(*) FROM parcel_cache").fetchone()[0]:
        return
    legacy = json.loads(LEGACY_CACHE.read_text(encoding="utf-8"))
    batch = []
    for requested_id, value in legacy.items():
        batch.append((requested_id, value.get("returned_id"), None,
                      json.dumps(value.get("geometry"), separators=(",", ":")) if value.get("geometry") else None,
                      value.get("datasource"), value.get("error"), datetime.now().isoformat()))
    database.executemany("INSERT OR REPLACE INTO parcel_cache VALUES (?,?,?,?,?,?,?)", batch)
    database.commit()
    print(f"Seeded {len(batch)} legacy cached parcels", flush=True)


def seed_existing_parcels(database, cutoff, newest):
    """Use PostGIS as the durable positive and negative cache for parcel lookups."""
    ensure_parcel_cache(database)
    connection = postgres_connection()
    reused = 0
    try:
        with connection.cursor() as cursor:
            cursor.execute("""
              SELECT DISTINCT unnest(parcel_ids) AS parcel_id
              FROM cases
              WHERE source_active AND received_date BETWEEN %s AND %s
            """, (cutoff, newest))
            for batch in chunks((row[0] for row in cursor if row[0]), 5000):
                now = datetime.now().isoformat()
                database.executemany(
                    "INSERT OR IGNORE INTO parcel_cache VALUES (?,?,?,?,?,?,?)",
                    [(parcel_id, parcel_id, None, None, "postgis-existing", None, now)
                     for parcel_id in batch],
                )
                database.commit()
                reused += len(batch)

            requested = database.execute("""
              SELECT DISTINCT parcel_id FROM source_rows
              WHERE parcel_id <> '' AND parcel_id NOT IN (SELECT requested_id FROM parcel_cache)
              ORDER BY parcel_id
            """)
            for batch in chunks((row[0] for row in requested), 5000):
                cursor.execute("""
                  SELECT parcel_id FROM parcels
                  WHERE parcel_id=ANY(%s)
                """, (batch,))
                existing = [row[0] for row in cursor]
                if not existing:
                    continue
                now = datetime.now().isoformat()
                database.executemany(
                    "INSERT OR IGNORE INTO parcel_cache VALUES (?,?,?,?,?,?,?)",
                    [(parcel_id, parcel_id, None, None, "postgis-existing", None, now)
                     for parcel_id in existing],
                )
                database.commit()
                reused += len(existing)
    finally:
        connection.close()
    print(f"Reused {reused} parcel lookup results from PostGIS", flush=True)
    return reused


def fetch_missing_parcels(database):
    seed_legacy_cache(database)
    if RETRY_ERRORS:
        database.execute("DELETE FROM parcel_cache WHERE error IS NOT NULL")
        database.commit()
    missing = [row[0] for row in database.execute("""
      SELECT DISTINCT parcel_id FROM source_rows
      WHERE parcel_id <> '' AND parcel_id NOT IN (SELECT requested_id FROM parcel_cache)
      ORDER BY parcel_id
    """)]
    if FETCH_LIMIT >= 0:
        missing = missing[:FETCH_LIMIT]
    print(f"Parcel ids missing: {len(missing)}", flush=True)
    completed = 0
    pending_results = []
    missing_iterator = iter(missing)

    def save_results(results):
        nonlocal completed
        now = datetime.now().isoformat()
        database.executemany(
            "INSERT OR REPLACE INTO parcel_cache VALUES (?,?,?,?,?,?,?)",
            [(requested_id, returned_id, wkt, None, datasource, error, now)
             for requested_id, returned_id, wkt, datasource, error in results],
        )
        database.commit()
        completed += len(results)
        print(f"Fetched {completed}/{len(missing)}", flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = set()
        for _ in range(min(len(missing), MAX_WORKERS * 3)):
            try:
                futures.add(executor.submit(fetch_parcel, next(missing_iterator)))
            except StopIteration:
                break
        while futures:
            done, futures = concurrent.futures.wait(futures, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                pending_results.append(future.result())
                try:
                    futures.add(executor.submit(fetch_parcel, next(missing_iterator)))
                except StopIteration:
                    pass
            if len(pending_results) >= FETCH_BATCH:
                save_results(pending_results)
                pending_results = []
    if pending_results:
        save_results(pending_results)


def postgres_connection():
    if psycopg is None:
        raise RuntimeError("Zainstaluj zależności: pip install -r scripts/requirements.txt")
    url = os.environ.get("DATABASE_PUBLIC_URL") or os.environ.get("DATABASE_URL")
    sslmode = os.environ.get("PGSSLMODE", "require")
    if url:
        return psycopg.connect(url, sslmode=sslmode)
    return psycopg.connect(
        host=os.environ["PGHOST"], port=os.environ.get("PGPORT", "5432"),
        user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"],
        dbname=os.environ["PGDATABASE"], sslmode=sslmode,
    )


def chunks(iterator, size=1000):
    batch = []
    for item in iterator:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def start_import(cutoff, newest):
    connection = postgres_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO imports(source_date,period_start,period_end) VALUES(%s,%s,%s) RETURNING id",
                (date.today(), cutoff, newest),
            )
            import_id = cursor.fetchone()[0]
        connection.commit()
        return import_id
    finally:
        connection.close()


def fail_import(import_id, error):
    try:
        connection = postgres_connection()
        with connection.cursor() as cursor:
            if import_id is None:
                cursor.execute("""
                  INSERT INTO imports(source_date,status,finished_at,error)
                  VALUES(%s,'failed',now(),%s)
                """, (date.today(), str(error)[:4000]))
            else:
                cursor.execute("""
                  UPDATE imports SET finished_at=now(),status='failed',error=%s WHERE id=%s
                """, (str(error)[:4000], import_id))
        connection.commit()
        connection.close()
    except Exception as reporting_error:
        print(f"Nie udało się zapisać błędu importu: {reporting_error}", flush=True)


def validate_stage(stage, cutoff, newest):
    staged_cases = stage.execute("SELECT count(*) FROM staged_cases").fetchone()[0]
    staged_provinces = stage.execute(
        "SELECT count(DISTINCT voivodeship) FROM staged_cases WHERE voivodeship<>''"
    ).fetchone()[0]
    if staged_cases < MIN_STAGE_CASES:
        raise RuntimeError(
            f"Walidacja źródła: tylko {staged_cases} spraw; minimum to {MIN_STAGE_CASES}"
        )
    if staged_provinces != 16:
        raise RuntimeError(
            f"Walidacja źródła: dane obejmują {staged_provinces} województw zamiast 16"
        )

    connection = postgres_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute("""
              SELECT count(*)::int, count(*) FILTER (WHERE published)::int
              FROM cases WHERE source_active AND received_date BETWEEN %s AND %s
            """, (cutoff, newest))
            existing_cases, existing_published = cursor.fetchone()
    finally:
        connection.close()
    if existing_cases:
        ratio = staged_cases / existing_cases
        if ratio < MIN_STAGE_RATIO or ratio > MAX_STAGE_RATIO:
            raise RuntimeError(
                f"Walidacja źródła: zmiana liczby spraw {existing_cases} -> {staged_cases} "
                f"(współczynnik {ratio:.3f}) jest poza zakresem "
                f"{MIN_STAGE_RATIO:.2f}–{MAX_STAGE_RATIO:.2f}"
            )
    return {
        "baseline_cases": existing_cases,
        "baseline_published_cases": existing_published,
        "staged_voivodeships": staged_provinces,
    }


def validate_publication(total_cases, published_cases, baseline_published):
    required = max(int(total_cases * MIN_PUBLISHED_RATIO), int(baseline_published * 0.75))
    if published_cases < required:
        raise RuntimeError(
            f"Walidacja publikacji: {published_cases} opublikowanych spraw; wymagane co najmniej {required}"
        )


def load_postgres(stage, metrics, cutoff, newest, import_id):
    connection = postgres_connection()
    connection.autocommit = False
    with connection.cursor() as cursor:
        cases = stage.execute("SELECT * FROM staged_cases ORDER BY source_type, external_id")
        upsert_case = """
          INSERT INTO cases(case_key,source_type,external_id,received_date,decision_date,status,office,
            voivodeship,city,address,case_kind,description,parcel_ids,updated_at,source_active,last_import_id)
          VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),true,%s)
          ON CONFLICT(case_key) DO UPDATE SET received_date=excluded.received_date,
            decision_date=excluded.decision_date,status=excluded.status,office=excluded.office,
            voivodeship=excluded.voivodeship,city=excluded.city,address=excluded.address,
            case_kind=excluded.case_kind,description=excluded.description,parcel_ids=excluded.parcel_ids,
            updated_at=now(),source_active=true,last_import_id=excluded.last_import_id
        """
        loaded_cases = 0
        for batch in chunks(cases):
            values = []
            for row in batch:
                source_type, external_id, received, decision, statuses, office, province, city, address, kind, description, parcels = row
                values.append((f"{source_type}:{external_id}", source_type, external_id, received, decision,
                               statuses.replace(",", ", "), office, province, city, address, kind,
                               description, json.loads(parcels), import_id))
            cursor.executemany(upsert_case, values)
            connection.commit()
            loaded_cases += len(values)
            print(f"Loaded cases {loaded_cases}", flush=True)

        parcels = stage.execute("""
          SELECT requested_id,returned_id,geom_wkt,geometry_json,datasource,error
          FROM parcel_cache WHERE datasource<>'postgis-existing' OR datasource IS NULL
        """)
        upsert_parcel = """
          INSERT INTO parcels(parcel_id,returned_id,geom,datasource,error,updated_at)
          VALUES(%s,%s,CASE WHEN %s::text IS NOT NULL THEN ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromText(%s),4326)),3))
                            WHEN %s::text IS NOT NULL THEN ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)),3)) END,
                 %s,%s,now())
          ON CONFLICT(parcel_id) DO UPDATE SET returned_id=excluded.returned_id,geom=excluded.geom,
            datasource=excluded.datasource,error=excluded.error,updated_at=now()
        """
        loaded_parcels = 0
        for batch in chunks(parcels, 500):
            values = [(pid, returned, wkt, wkt, geojson, geojson, datasource, error)
                      for pid, returned, wkt, geojson, datasource, error in batch]
            cursor.executemany(upsert_parcel, values)
            connection.commit()
            loaded_parcels += len(values)
            print(f"Loaded parcels {loaded_parcels}", flush=True)

        refs = stage.execute("SELECT DISTINCT source_type,external_id,parcel_id FROM source_rows WHERE parcel_id<>''")
        insert_ref = """
          INSERT INTO case_parcels(case_id,parcel_id)
          SELECT c.id,%s FROM cases c JOIN parcels p ON p.parcel_id=%s
          WHERE c.case_key=%s AND left(%s,2)=voivodeship_teryt_code(c.voivodeship)
          ON CONFLICT DO NOTHING
        """
        loaded_refs = 0
        for batch in chunks(refs):
            values = [(parcel_id, parcel_id, f"{source_type}:{external_id}", parcel_id)
                      for source_type, external_id, parcel_id in batch]
            cursor.executemany(insert_ref, values)
            connection.commit()
            loaded_refs += len(values)
            print(f"Loaded refs {loaded_refs}", flush=True)

        cursor.execute("""
          DELETE FROM case_parcels cp USING cases c
          WHERE cp.case_id=c.id
            AND c.received_date BETWEEN %s AND %s
            AND NOT (cp.parcel_id=ANY(c.parcel_ids))
        """, (cutoff, newest))
        cursor.execute(
            "UPDATE cases SET location=NULL,published=false WHERE received_date BETWEEN %s AND %s",
            (cutoff, newest),
        )
        cursor.execute("""
          UPDATE cases SET source_active=false,published=false,updated_at=now()
          WHERE source_active AND received_date BETWEEN %s AND %s
            AND last_import_id IS DISTINCT FROM %s
        """, (cutoff, newest, import_id))
        inactive_cases = cursor.rowcount
        cursor.execute("""
          UPDATE cases c SET location=s.location,published=true
          FROM (
            SELECT cp.case_id, ST_PointOnSurface(ST_Collect(p.geom)) AS location
            FROM case_parcels cp
            JOIN parcels p ON p.parcel_id=cp.parcel_id
            JOIN cases source_case ON source_case.id=cp.case_id
            WHERE source_case.source_active
              AND source_case.received_date BETWEEN %s AND %s
              AND p.geom IS NOT NULL AND NOT ST_IsEmpty(p.geom) AND ST_IsValid(p.geom)
              AND left(cp.parcel_id,2)=voivodeship_teryt_code(source_case.voivodeship)
              AND ST_Within(ST_Centroid(p.geom),ST_MakeEnvelope(14.0,48.8,24.3,55.3,4326))
            GROUP BY cp.case_id
          ) s WHERE c.id=s.case_id AND c.source_active
        """, (cutoff, newest))
        cursor.execute("ANALYZE cases")
        cursor.execute("ANALYZE parcels")
        cursor.execute("""
          SELECT count(*)::int, count(*) FILTER (WHERE published)::int,
                 count(DISTINCT voivodeship)::int FROM cases
          WHERE source_active AND received_date BETWEEN %s AND %s
        """, (cutoff, newest))
        total_cases, published_cases, provinces = cursor.fetchone()
        validate_publication(
            total_cases,
            published_cases,
            metrics.get("baseline_published_cases", 0),
        )
        metrics.update({
            "unique_cases": total_cases, "published_cases": published_cases,
            "voivodeships": provinces, "parcel_cache_rows": loaded_parcels,
            "case_parcel_refs": loaded_refs, "inactive_cases": inactive_cases,
        })
        cursor.execute("UPDATE imports SET finished_at=now(),status='success',metrics=%s WHERE id=%s",
                       (json.dumps(metrics, ensure_ascii=False), import_id))
        connection.commit()
    connection.close()
    return metrics


def run_import():
    global ACTIVE_IMPORT_ID
    started = time.perf_counter()
    if DOWNLOAD_ARCHIVES:
        from download_gunb_archives import download_archives
        download_archives(ZIP_DIR)
    archives = source_archives()
    newest = parse_date(PERIOD_END) if PERIOD_END else None
    if newest is None:
        for path, _source_type, _province, date_field in archives:
            for row in iter_archive(path):
                current = parse_date(row.get(date_field))
                if current and (newest is None or current > newest):
                    newest = current
    if newest is None:
        raise RuntimeError("Brak dat w źródłach")
    cutoff = parse_date(PERIOD_START) if PERIOD_START else subtract_year(newest)
    if cutoff is None:
        raise RuntimeError(f"Nieprawidłowy OBOKMNIE_PERIOD_START: {PERIOD_START}")
    if cutoff > newest:
        raise RuntimeError("Początek zakresu importu jest późniejszy niż jego koniec")
    print(f"Analysis period: {cutoff}..{newest}", flush=True)
    stage = open_stage()
    has_stage = stage.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('source_rows','staged_cases')"
    ).fetchone()[0] == 2
    if REUSE_STAGE:
        if not has_stage:
            raise RuntimeError("Brak zapisanego etapu do ponownego użycia")
        metrics = {"stage_reused": True}
        print(f"Reusing stage: {STAGE_PATH}", flush=True)
    else:
        metrics = build_stage(stage, archives, cutoff, newest)
    metrics.update({
        "period_start": cutoff.isoformat(), "period_end": newest.isoformat(),
        "unique_cases_staged": stage.execute("SELECT count(*) FROM staged_cases").fetchone()[0],
        "unique_parcel_ids": stage.execute("SELECT count(DISTINCT parcel_id) FROM source_rows WHERE parcel_id<>''").fetchone()[0],
    })
    if STAGE_ONLY:
        metrics["elapsed_seconds"] = round(time.perf_counter() - started, 2)
        print(json.dumps(metrics, ensure_ascii=False, indent=2))
        return
    metrics.update(validate_stage(stage, cutoff, newest))
    if not FETCH_ONLY:
        ACTIVE_IMPORT_ID = start_import(cutoff, newest)
    metrics["parcel_lookup_results_reused"] = seed_existing_parcels(stage, cutoff, newest)
    if SKIP_ULDK:
        print("Skipping ULDK fallback; unmatched historical parcel ids remain unpublished", flush=True)
    else:
        fetch_missing_parcels(stage)
    if FETCH_ONLY:
        metrics["parcel_cache_rows"] = stage.execute("SELECT count(*) FROM parcel_cache").fetchone()[0]
        metrics["elapsed_seconds"] = round(time.perf_counter() - started, 2)
        print(json.dumps(metrics, ensure_ascii=False, indent=2))
        return
    metrics = load_postgres(stage, metrics, cutoff, newest, ACTIVE_IMPORT_ID)
    metrics["elapsed_seconds"] = round(time.perf_counter() - started, 2)
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


def main():
    try:
        run_import()
    except Exception as error:
        if not STAGE_ONLY and not FETCH_ONLY:
            fail_import(ACTIVE_IMPORT_ID, error)
        raise


if __name__ == "__main__":
    main()
