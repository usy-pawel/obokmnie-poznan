import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT.parent / "obokmnie-mvp0" / "strzeszyn-events.json"
OUTPUT = PROJECT / "public" / "data" / "strzeszyn-parcels.geojson"


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
        raise ValueError(f"Unsupported WKT: {value[:40]}")
    geometry_type = match.group(1).upper()
    body = strip_outer(match.group(2))
    if geometry_type == "POLYGON":
        rings = [parse_ring(strip_outer(ring)) for ring in split_top_level(body)]
        return {"type": "Polygon", "coordinates": rings}
    polygons = []
    for polygon in split_top_level(body):
        polygon_body = strip_outer(polygon)
        polygons.append([parse_ring(strip_outer(ring)) for ring in split_top_level(polygon_body)])
    return {"type": "MultiPolygon", "coordinates": polygons}


def fetch_parcel(parcel_id):
    variants = [parcel_id]
    normalized = re.sub(r"\.AR_0+(\d+)\.", r".AR_\1.", parcel_id)
    if normalized not in variants:
        variants.append(normalized)
    for variant in variants:
        query = urllib.parse.urlencode({
            "request": "GetParcelById",
            "id": variant,
            "result": "id,geom_wkt,region,parcel,datasource",
            "srid": "4326",
        })
        request = urllib.request.Request(
            f"https://uldk.gugik.gov.pl/?{query}",
            headers={"User-Agent": "obokmnie-strzeszyn-tmvp/1.0"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            lines = response.read().decode("utf-8", errors="replace").strip().splitlines()
        for line in lines[1:]:
            parts = line.split("|", 4)
            if len(parts) >= 2 and parts[0].casefold() == variant.casefold():
                return {
                    "returned_id": parts[0],
                    "geometry": parse_wkt(parts[1]),
                    "datasource": parts[4] if len(parts) > 4 else "ULDK",
                }
    raise RuntimeError(f"ULDK did not return an exact geometry for {parcel_id}")


def main():
    cases = json.loads(SOURCE.read_text(encoding="utf-8"))
    features = []
    for case in cases:
        for parcel_id in case["parcel_ids"]:
            parcel = fetch_parcel(parcel_id)
            features.append({
                "type": "Feature",
                "id": f"{case['case_id']}::{parcel['returned_id']}",
                "geometry": parcel["geometry"],
                "properties": {
                    "case_id": case["case_id"],
                    "source_type": case["source_type"],
                    "received_date": case["received_date"],
                    "status": ", ".join(case["statuses"]),
                    "description": case["description"],
                    "address": ", ".join(case["addresses"]) or "Brak pełnego adresu",
                    "parcel_id": parcel["returned_id"],
                    "all_parcel_ids": case["parcel_ids"],
                    "location_quality": case["location_quality"],
                    "location_source": parcel["datasource"],
                    "gunb_url": "https://wyszukiwarka.gunb.gov.pl/",
                },
            })
    collection = {
        "type": "FeatureCollection",
        "name": "Potwierdzone sprawy budowlane — Strzeszyn",
        "generated_at": "2026-08-29",
        "features": features,
    }
    OUTPUT.write_text(json.dumps(collection, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(features)} parcel geometries for {len(cases)} cases to {OUTPUT}")


if __name__ == "__main__":
    main()
