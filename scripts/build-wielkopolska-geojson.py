from __future__ import annotations

import concurrent.futures
import csv
import json
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
WORK_DATA = PROJECT.parent / "work" / "obokmnie"
PERMITS = Path(os.environ.get("OBOKMNIE_PERMITS", WORK_DATA / "raw" / "wynik_wielkopolskie.csv"))
NOTIFICATIONS = Path(os.environ.get("OBOKMNIE_NOTIFICATIONS", WORK_DATA / "raw-zgloszenia" / "wynik_zgloszenia_2022_up.csv"))
DATA_DIR = PROJECT / "public" / "data"
PARCEL_DIR = DATA_DIR / "wielkopolska-parcels"
CASE_OUTPUT = DATA_DIR / "wielkopolska-cases.geojson"
MANIFEST_OUTPUT = DATA_DIR / "wielkopolska-parcel-manifest.json"
METRICS_OUTPUT = DATA_DIR / "wielkopolska-build-metrics.json"
CACHE_PATH = PROJECT / ".cache" / "wielkopolska-uldk-geometries.json"
MAX_WORKERS = int(os.environ.get("OBOKMNIE_WORKERS", "12"))
MAX_ATTEMPTS = 3
SAVE_EVERY = int(os.environ.get("OBOKMNIE_SAVE_EVERY", "500"))
RETRY_ERRORS = os.environ.get("OBOKMNIE_RETRY_ERRORS") == "1"
SHARD_SIZE = 0.25
PROVINCE_BOUNDS = (15.5, 50.8, 19.2, 53.7)

cache_lock = threading.Lock()


def clean(value):
    return (value or "").replace("[object Object]", "").strip().strip('"').strip()


def unique_header(header):
    seen = Counter()
    result = []
    for name in header:
        seen[name] += 1
        result.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return result


def iter_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter=";")
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
    base = clean(row.get("ulica"))
    detail = clean(row.get("ulica_dalej"))
    return re.sub(r"\s+", " ", f"{detail} {base}").strip()


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
        if not parcel:
            continue
        result.append(f"{unit}.{district}.AR_{sheet}.{parcel}" if sheet else f"{unit}.{district}.{parcel}")
    return result


def normalize_permit(row):
    return {
        "source_type": "wniosek_decyzja",
        "case_id": clean(row.get("numer_gunb")),
        "received_date": parse_date(row.get("data_wplywu_wniosku")),
        "decision_date": parse_date(row.get("data_wydania_decyzji")),
        "status": "decyzja wydana" if clean(row.get("numer_decyzji_urzedu")) else "wniosek",
        "office": clean(row.get("nazwa_organu")),
        "city": clean(row.get("miasto")),
        "street": street_name(row),
        "house_number": clean(row.get("nr_domu")),
        "case_kind": clean(row.get("rodzaj_inwestycji")),
        "description": clean(row.get("nazwa_zam_budowlanego")) or clean(row.get("nazwa_zamierzenia_bud")),
        "parcel_ids": parcel_ids(row, "jednosta_numer_ew"),
    }


def normalize_notification(row):
    if clean(row.get("wojewodztwo_objekt")).casefold() != "wielkopolskie":
        return None
    return {
        "source_type": "zgloszenie",
        "case_id": clean(row.get("numer_ewidencyjny_system")),
        "received_date": parse_date(row.get("data_wplywu_wniosku_do_urzedu")),
        "decision_date": None,
        "status": clean(row.get("stan")) or "brak statusu",
        "office": clean(row.get("nazwa_organu")),
        "city": clean(row.get("miasto")),
        "street": street_name(row),
        "house_number": clean(row.get("nr_domu")),
        "case_kind": clean(row.get("rodzaj_zam_budowlanego")),
        "description": clean(row.get("nazwa_zam_budowlanego")),
        "parcel_ids": parcel_ids(row, "jednostki_numer"),
    }


def split_top_level(value):
    parts = []
    start = depth = 0
    for index, char in enumerate(value):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append(value[start:index].strip())
            start = index + 1
    parts.append(value[start:].strip())
    return [part for part in parts if part]


def strip_outer(value):
    value = value.strip()
    if not (value.startswith("(") and value.endswith(")")):
        return value
    depth = 0
    for index, char in enumerate(value):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0 and index != len(value) - 1:
                return value
    return value[1:-1].strip()


def parse_ring(value):
    return [[float(number) for number in pair.strip().split()[:2]] for pair in value.split(",")]


def parse_wkt(value):
    value = value.split(";", 1)[-1].strip()
    match = re.match(r"^(POLYGON|MULTIPOLYGON)\s*(.+)$", value, re.I)
    if not match:
        raise ValueError(f"Unsupported WKT: {value[:60]}")
    geometry_type = match.group(1).upper()
    body = strip_outer(match.group(2))
    if geometry_type == "POLYGON":
        return {"type": "Polygon", "coordinates": [parse_ring(strip_outer(ring)) for ring in split_top_level(body)]}
    return {
        "type": "MultiPolygon",
        "coordinates": [
            [parse_ring(strip_outer(ring)) for ring in split_top_level(strip_outer(polygon))]
            for polygon in split_top_level(body)
        ],
    }


def geometry_points(geometry):
    if geometry["type"] == "Polygon":
        return [point for ring in geometry["coordinates"] for point in ring]
    return [point for polygon in geometry["coordinates"] for ring in polygon for point in ring]


def geometry_center(geometries):
    points = [point for geometry in geometries for point in geometry_points(geometry)]
    return [(min(p[0] for p in points) + max(p[0] for p in points)) / 2, (min(p[1] for p in points) + max(p[1] for p in points)) / 2]


def inside_control_region(geometry):
    min_lon, min_lat, max_lon, max_lat = PROVINCE_BOUNDS
    return all(min_lon <= lon <= max_lon and min_lat <= lat <= max_lat for lon, lat in geometry_points(geometry))


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
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            for variant in variants_for(parcel_id):
                query = urllib.parse.urlencode({
                    "request": "GetParcelById",
                    "id": variant,
                    "result": "id,geom_wkt,region,parcel,datasource",
                    "srid": "4326",
                })
                request = urllib.request.Request(
                    f"https://uldk.gugik.gov.pl/?{query}",
                    headers={"User-Agent": "obokmnie-wielkopolska-tmvp/1.0"},
                )
                with urllib.request.urlopen(request, timeout=30) as response:
                    lines = response.read().decode("utf-8", errors="replace").strip().splitlines()
                for line in lines[1:]:
                    parts = line.split("|", 4)
                    if len(parts) >= 2 and parts[0].casefold() == variant.casefold():
                        return {
                            "requested_id": parcel_id,
                            "returned_id": parts[0],
                            "geometry": parse_wkt(parts[1]),
                            "datasource": parts[4] if len(parts) > 4 else "ULDK",
                        }
            return {"requested_id": parcel_id, "error": "no exact result"}
        except Exception as error:
            last_error = error
            if attempt + 1 < MAX_ATTEMPTS:
                time.sleep(0.4 * (2**attempt))
    return {"requested_id": parcel_id, "error": str(last_error)}


def load_cache():
    if not CACHE_PATH.exists():
        return {}
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))


def save_cache(cache):
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = CACHE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(CACHE_PATH)


def address_for(row):
    street = clean(row["street"])
    number = clean(row["house_number"])
    address = " ".join(part for part in [street, number] if part)
    if row["city"] and row["city"].casefold() not in address.casefold():
        address = ", ".join(part for part in [address, row["city"]] if part)
    return address


def build_cases(rows):
    groups = defaultdict(list)
    for row in rows:
        if row["case_id"]:
            groups[(row["source_type"], row["case_id"])].append(row)
    cases = []
    for (source_type, case_id), group in groups.items():
        best = max(group, key=lambda row: (bool(row["description"]), len(row["description"]), bool(row["office"])))
        cases.append({
            "source_type": source_type,
            "case_id": case_id,
            "received_date": min(row["received_date"] for row in group).isoformat(),
            "decision_date": next((row["decision_date"].isoformat() for row in group if row["decision_date"]), None),
            "statuses": sorted({row["status"] for row in group if row["status"]}),
            "office": best["office"],
            "city": next((row["city"] for row in group if row["city"]), "Brak miejscowości"),
            "addresses": sorted({address_for(row) for row in group if address_for(row)}),
            "parcel_ids": sorted({parcel_id for row in group for parcel_id in row["parcel_ids"]}),
            "case_kind": best["case_kind"],
            "description": best["description"] or "Sprawa budowlana",
        })
    return cases


def public_properties(case):
    return {
        "case_id": case["case_id"],
        "source_type": case["source_type"],
        "received_date": case["received_date"],
        "decision_date": case["decision_date"],
        "status": ", ".join(case["statuses"]),
        "description": case["description"],
        "address": "; ".join(case["addresses"]) or case["city"] or "Brak pełnego adresu",
        "city": case["city"] or "Brak miejscowości",
        "office": case["office"],
        "case_kind": case["case_kind"] or "Brak kategorii",
        "parcel_ids": case["parcel_ids"],
        "location_quality": "dokładny",
        "gunb_url": "https://wyszukiwarka.gunb.gov.pl/",
    }


def shard_id_for(point):
    return f"x{math.floor(point[0] / SHARD_SIZE):03d}-y{math.floor(point[1] / SHARD_SIZE):03d}"


def main():
    started = time.perf_counter()
    newest = None
    sources = [
        ("wniosek_decyzja", PERMITS, normalize_permit, "data_wplywu_wniosku", "wojewodztwo"),
        (
            "zgloszenie",
            NOTIFICATIONS,
            normalize_notification,
            "data_wplywu_wniosku_do_urzedu",
            "wojewodztwo_objekt",
        ),
    ]

    # The source files are large. First find the newest applicable date without
    # retaining rows, then normalize only records from the published period.
    for _source_type, path, _normalizer, date_field, province_field in sources:
        if not path.exists():
            raise FileNotFoundError(f"Brak pliku źródłowego: {path}")
        for raw in iter_csv(path):
            if province_field and clean(raw.get(province_field)).casefold() != "wielkopolskie":
                continue
            current = parse_date(raw.get(date_field))
            if current and (newest is None or current > newest):
                newest = current

    if newest is None:
        raise RuntimeError("Brak poprawnych dat w plikach źródłowych")

    cutoff = subtract_year(newest)
    rows = []
    for _source_type, path, normalizer, _date_field, _province_field in sources:
        for raw in iter_csv(path):
            row = normalizer(raw)
            if row and row["received_date"] and cutoff <= row["received_date"] <= newest:
                rows.append(row)
    cases = build_cases(rows)
    parcel_to_cases = defaultdict(list)
    for case in cases:
        for parcel_id in case["parcel_ids"]:
            parcel_to_cases[parcel_id].append(case["case_id"])

    cache = load_cache()
    if RETRY_ERRORS:
        cache = {parcel_id: result for parcel_id, result in cache.items() if "error" not in result}
    requested_ids = sorted(parcel_to_cases)
    missing_ids = [parcel_id for parcel_id in requested_ids if parcel_id not in cache]
    print(f"Cases: {len(cases)}; parcel ids: {len(requested_ids)}; cached: {len(requested_ids) - len(missing_ids)}", flush=True)

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        for offset in range(0, len(missing_ids), SAVE_EVERY):
            batch = missing_ids[offset:offset + SAVE_EVERY]
            futures = [executor.submit(fetch_parcel, parcel_id) for parcel_id in batch]
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                with cache_lock:
                    cache[result["requested_id"]] = result
                completed += 1
            save_cache(cache)
            print(f"Fetched {completed}/{len(missing_ids)}", flush=True)
    save_cache(cache)

    successful_by_case = defaultdict(list)
    failed_ids = []
    outside_ids = []
    for parcel_id in requested_ids:
        parcel = cache[parcel_id]
        if "error" in parcel:
            failed_ids.append(parcel_id)
            continue
        if not inside_control_region(parcel["geometry"]):
            outside_ids.append(parcel_id)
            continue
        for case_id in parcel_to_cases[parcel_id]:
            successful_by_case[case_id].append(parcel)

    cases_by_id = {case["case_id"]: case for case in cases}
    case_features = []
    shard_features = defaultdict(list)
    seen_features = set()
    for case_id, parcels in successful_by_case.items():
        case = cases_by_id[case_id]
        unique_parcels = {parcel["returned_id"]: parcel for parcel in parcels}
        center = geometry_center([parcel["geometry"] for parcel in unique_parcels.values()])
        shard_id = shard_id_for(center)
        properties = public_properties(case)
        properties.update({"parcel_count": len(unique_parcels), "parcel_shard": shard_id})
        case_features.append({
            "type": "Feature",
            "id": case_id,
            "geometry": {"type": "Point", "coordinates": center},
            "properties": properties,
        })
        for returned_id, parcel in unique_parcels.items():
            feature_id = f"{case_id}::{returned_id}"
            if feature_id in seen_features:
                continue
            seen_features.add(feature_id)
            parcel_properties = dict(properties)
            parcel_properties.update({"parcel_id": returned_id, "location_source": parcel["datasource"]})
            shard_features[shard_id].append({
                "type": "Feature",
                "id": feature_id,
                "geometry": parcel["geometry"],
                "properties": parcel_properties,
            })

    case_features.sort(key=lambda feature: feature["properties"]["received_date"], reverse=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PARCEL_DIR.mkdir(parents=True, exist_ok=True)
    for old_shard in PARCEL_DIR.glob("*.geojson"):
        old_shard.unlink()
    generated_at = date.today().isoformat()
    CASE_OUTPUT.write_text(json.dumps({
        "type": "FeatureCollection",
        "name": "Dokładnie zlokalizowane sprawy budowlane — Wielkopolska",
        "generated_at": generated_at,
        "analysis_period": {"start": cutoff.isoformat(), "end": newest.isoformat()},
        "features": case_features,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    manifest = {"generated_at": generated_at, "shard_size": SHARD_SIZE, "shards": {}}
    for shard_id, features in sorted(shard_features.items()):
        path = PARCEL_DIR / f"{shard_id}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        all_points = [point for feature in features for point in geometry_points(feature["geometry"])]
        manifest["shards"][shard_id] = {
            "url": f"/data/wielkopolska-parcels/{shard_id}.geojson",
            "bounds": [min(p[0] for p in all_points), min(p[1] for p in all_points), max(p[0] for p in all_points), max(p[1] for p in all_points)],
            "features": len(features),
            "cases": len({feature["properties"]["case_id"] for feature in features}),
            "bytes": path.stat().st_size,
        }
    MANIFEST_OUTPUT.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    elapsed = time.perf_counter() - started
    metrics = {
        "generated_at": generated_at,
        "analysis_period": {"start": cutoff.isoformat(), "end": newest.isoformat()},
        "source_rows_in_period": len(rows),
        "source_rows_by_type_in_period": dict(Counter(row["source_type"] for row in rows)),
        "unique_cases": len(cases),
        "published_cases": len(case_features),
        "unpublished_cases_without_exact_geometry": len(cases) - len(case_features),
        "parcel_ids_requested": len(requested_ids),
        "parcel_ids_resolved": len(requested_ids) - len(failed_ids) - len(outside_ids),
        "parcel_ids_failed": len(failed_ids),
        "parcel_ids_outside_control": len(outside_ids),
        "parcel_geometries_published": sum(len(features) for features in shard_features.values()),
        "parcel_shards": len(shard_features),
        "largest_shard_bytes": max((info["bytes"] for info in manifest["shards"].values()), default=0),
        "case_geojson_bytes": CASE_OUTPUT.stat().st_size,
        "manifest_bytes": MANIFEST_OUTPUT.stat().st_size,
        "source_type_counts": dict(Counter(feature["properties"]["source_type"] for feature in case_features)),
        "elapsed_seconds": round(elapsed, 2),
        "max_workers": MAX_WORKERS,
    }
    METRICS_OUTPUT.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
