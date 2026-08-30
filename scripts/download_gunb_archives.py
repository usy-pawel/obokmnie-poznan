from __future__ import annotations

import hashlib
import json
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import requests


PROJECT = Path(__file__).resolve().parents[1]
ZIP_DIR = Path(os.environ.get("OBOKMNIE_ZIP_DIR", PROJECT.parent / "work" / "obokmnie" / "poland-zips"))
BASE_URL = "https://wyszukiwarka.gunb.gov.pl/pliki_pobranie"
MANIFEST_NAME = ".gunb-download-manifest.json"
VOIVODESHIPS = (
    "dolnoslaskie",
    "kujawsko-pomorskie",
    "lodzkie",
    "lubelskie",
    "lubuskie",
    "malopolskie",
    "mazowieckie",
    "opolskie",
    "podkarpackie",
    "podlaskie",
    "pomorskie",
    "slaskie",
    "swietokrzyskie",
    "warminsko-mazurskie",
    "wielkopolskie",
    "zachodniopomorskie",
)


def expected_archive_names():
    return [f"wynik_{name}.zip" for name in VOIVODESHIPS] + [
        "wynik_zgloszenia_2016_2021.zip",
        "wynik_zgloszenia_2022_up.zip",
    ]


def load_manifest(directory):
    path = directory / MANIFEST_NAME
    if not path.exists():
        return {"files": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"files": {}}


def validate_archive(path):
    if path.stat().st_size < 1024:
        raise RuntimeError(f"Archiwum jest podejrzanie małe: {path.name}")
    with zipfile.ZipFile(path) as archive:
        csv_files = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if len(csv_files) != 1:
            raise RuntimeError(f"Archiwum {path.name} nie zawiera dokładnie jednego CSV")
        broken = archive.testzip()
        if broken:
            raise RuntimeError(f"Uszkodzony plik {broken} w archiwum {path.name}")


def download_archive(session, directory, name, previous):
    url = f"{BASE_URL}/{name}"
    target = directory / name
    head = session.head(url, timeout=(10, 30))
    head.raise_for_status()
    etag = head.headers.get("ETag")
    expected_size = int(head.headers.get("Content-Length") or 0)
    if (
        target.exists()
        and previous.get("etag") == etag
        and previous.get("size") == target.stat().st_size
        and (not expected_size or expected_size == target.stat().st_size)
    ):
        validate_archive(target)
        print(f"Bez zmian: {name}", flush=True)
        return previous

    temporary = target.with_suffix(".zip.part")
    digest = hashlib.sha256()
    written = 0
    try:
        with session.get(url, stream=True, timeout=(10, 180)) as response:
            response.raise_for_status()
            with temporary.open("wb") as output:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    output.write(chunk)
                    digest.update(chunk)
                    written += len(chunk)
        if expected_size and written != expected_size:
            raise RuntimeError(f"Niepełne archiwum {name}: {written} z {expected_size} bajtów")
        validate_archive(temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Pobrano: {name} ({written} B)", flush=True)
    return {
        "url": url,
        "etag": etag,
        "last_modified": head.headers.get("Last-Modified"),
        "size": written,
        "sha256": digest.hexdigest(),
    }


def download_archives(directory=ZIP_DIR):
    directory.mkdir(parents=True, exist_ok=True)
    previous_manifest = load_manifest(directory)
    session = requests.Session()
    session.headers.update({"User-Agent": "obokmnie-polska-updater/1.0"})
    files = {}
    for name in expected_archive_names():
        files[name] = download_archive(
            session,
            directory,
            name,
            previous_manifest.get("files", {}).get(name, {}),
        )
    manifest = {
        "source": "GUNB RWDZ",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "files": files,
    }
    temporary = directory / f"{MANIFEST_NAME}.part"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(directory / MANIFEST_NAME)
    return manifest


if __name__ == "__main__":
    download_archives()
