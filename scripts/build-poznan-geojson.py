import concurrent.futures
import json
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT.parent / "obokmnie-mvp0" / "poznan-gunb-clean-v2.json"
PARCEL_OUTPUT = PROJECT / "public" / "data" / "poznan-parcels.geojson"
CASE_OUTPUT = PROJECT / "public" / "data" / "poznan-cases.geojson"
METRICS_OUTPUT = PROJECT / "public" / "data" / "poznan-build-metrics.json"
CACHE_PATH = PROJECT / ".cache" / "uldk-geometries.json"
MAX_WORKERS = 8
MAX_ATTEMPTS = 3
CONTROL_BOUNDS = (16.65, 52.2, 17.25, 52.62)

cache_lock = threading.Lock()


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
        return {
            "type": "Polygon",
            "coordinates": [parse_ring(strip_outer(ring)) for ring in split_top_level(body)],
        }
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


def inside_control_region(geometry):
    min_lon, min_lat, max_lon, max_lat = CONTROL_BOUNDS
    return all(
        min_lon <= longitude <= max_lon and min_lat <= latitude <= max_lat
        for longitude, latitude in geometry_points(geometry)
    )


def variants_for(parcel_id):
    variants = [parcel_id]
    normalized = re.sub(r"\.AR_0+(\d+)\.", r".AR_\1.", parcel_id)
    if normalized not in variants:
        variants.append(normalized)
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
                    headers={"User-Agent": "obokmnie-poznan-tmvp/1.0"},
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
            raise RuntimeError("no exact result")
        except Exception as error:
            last_error = error
            if attempt + 1 < MAX_ATTEMPTS:
                time.sleep(0.5 * (2**attempt))
    return {"requested_id": parcel_id, "error": str(last_error)}


def load_cache():
    if not CACHE_PATH.exists():
        return {}
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))


def save_cache(cache):
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def public_properties(case):
    return {
        "case_id": case["case_id"],
        "source_type": case["source_type"],
        "received_date": case["received_date"],
        "decision_date": case.get("decision_date"),
        "status": ", ".join(case["statuses"]),
        "description": case["description"],
        "address": ", ".join(case["addresses"]) or "Brak pełnego adresu",
        "office": case["office"],
        "case_kind": case.get("case_kind") or "Brak kategorii",
        "parcel_ids": case["parcel_ids"],
        "location_quality": case["location_quality"],
        "gunb_url": "https://wyszukiwarka.gunb.gov.pl/",
    }


def main():
    started = time.perf_counter()
    cases = json.loads(SOURCE.read_text(encoding="utf-8"))
    exact_cases = [
        case for case in cases
        if case["location_quality"] == "dokładny" and case.get("inside_poznan") is True
    ]
    parcel_to_cases = defaultdict(list)
    for case in exact_cases:
        for parcel_id in case["parcel_ids"]:
            parcel_to_cases[parcel_id].append(case["case_id"])
        if case.get("resolved_parcel_id"):
            parcel_to_cases[case["resolved_parcel_id"]].append(case["case_id"])

    cache = load_cache()
    requested_ids = sorted(parcel_to_cases)
    missing_ids = [parcel_id for parcel_id in requested_ids if parcel_id not in cache]
    print(f"Exact cases: {len(exact_cases)}; unique parcel ids: {len(requested_ids)}; cached: {len(requested_ids) - len(missing_ids)}")

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_parcel, parcel_id): parcel_id for parcel_id in missing_ids}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            with cache_lock:
                cache[result["requested_id"]] = result
            completed += 1
            if completed % 100 == 0 or completed == len(missing_ids):
                save_cache(cache)
                print(f"Fetched {completed}/{len(missing_ids)} new parcel results")
    save_cache(cache)

    cases_by_id = {case["case_id"]: case for case in exact_cases}
    successful_by_case = defaultdict(list)
    failed_ids = []
    outside_control_ids = []
    for requested_id in requested_ids:
        parcel = cache[requested_id]
        if "error" in parcel:
            failed_ids.append(requested_id)
            continue
        if not inside_control_region(parcel["geometry"]):
            outside_control_ids.append(requested_id)
            continue
        for case_id in parcel_to_cases[requested_id]:
            successful_by_case[case_id].append(parcel)

    parcel_features = []
    seen_features = set()
    for case_id, parcels in successful_by_case.items():
        case = cases_by_id[case_id]
        for parcel in parcels:
            feature_id = f"{case_id}::{parcel['returned_id']}"
            if feature_id in seen_features:
                continue
            seen_features.add(feature_id)
            properties = public_properties(case)
            properties.update({
                "parcel_id": parcel["returned_id"],
                "location_source": parcel["datasource"],
            })
            parcel_features.append({
                "type": "Feature",
                "id": feature_id,
                "geometry": parcel["geometry"],
                "properties": properties,
            })

    case_features = []
    for case in exact_cases:
        properties = public_properties(case)
        properties["parcel_count"] = len({parcel["returned_id"] for parcel in successful_by_case[case["case_id"]]})
        case_features.append({
            "type": "Feature",
            "id": case["case_id"],
            "geometry": {"type": "Point", "coordinates": [case["longitude"], case["latitude"]]},
            "properties": properties,
        })

    generated_at = date.today().isoformat()
    PARCEL_OUTPUT.write_text(json.dumps({
        "type": "FeatureCollection",
        "name": "Dokładne geometrie działek — sprawy budowlane Poznań",
        "generated_at": generated_at,
        "features": parcel_features,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    CASE_OUTPUT.write_text(json.dumps({
        "type": "FeatureCollection",
        "name": "Dokładnie zlokalizowane sprawy budowlane — Poznań",
        "generated_at": generated_at,
        "features": case_features,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    elapsed = time.perf_counter() - started
    metrics = {
        "generated_at": generated_at,
        "source_cases": len(cases),
        "eligible_exact_cases": len(exact_cases),
        "published_cases": len(case_features),
        "parcel_ids_requested": len(requested_ids),
        "parcel_ids_resolved": len(requested_ids) - len(failed_ids),
        "parcel_ids_failed": len(failed_ids),
        "parcel_ids_outside_control": len(outside_control_ids),
        "parcel_geometries_published": len(parcel_features),
        "failed_ids": failed_ids,
        "outside_control_ids": outside_control_ids,
        "source_type_counts": Counter(case["source_type"] for case in exact_cases),
        "elapsed_seconds": round(elapsed, 2),
        "max_workers": MAX_WORKERS,
        "parcel_geojson_bytes": PARCEL_OUTPUT.stat().st_size,
        "case_geojson_bytes": CASE_OUTPUT.stat().st_size,
    }
    metrics["source_type_counts"] = dict(metrics["source_type_counts"])
    METRICS_OUTPUT.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
