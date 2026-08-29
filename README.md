# Co budują w Poznaniu? — T‑MVP

Publiczna mapa dokładnie zlokalizowanych spraw budowlanych z całego Poznania. Widok miejski pokazuje klastry spraw, a przy zbliżeniu rzeczywiste granice działek pobrane z oficjalnej usługi ULDK.

## Dane

- okres: 27 sierpnia 2025 – 27 sierpnia 2026,
- 870 unikalnych spraw źródłowych,
- 833 dokładnie zlokalizowane sprawy publikowane na mapie,
- wpisy przybliżone, sprzeczne i nierozwiązane nie są publikowane,
- źródła: GUNB RWDZ, GUGiK ULDK i bezpłatna ortofotomapa WMTS, OpenStreetMap/OpenFreeMap.

## Lokalny podgląd

```powershell
python -m http.server 3000 --directory public
```

Strona będzie dostępna pod `http://localhost:3000`.

## Lokalne CI

```powershell
npm run check
```

Kontrole obejmują składnię JavaScript, liczbę i unikalność spraw, dokładność danych, typy i zakres geometrii, kompletność pól oraz maksymalny rozmiar statycznych plików.

## Aktualizacja danych

```powershell
python scripts/build-poznan-geojson.py
```

Skrypt pobiera granice działek z ULDK wielowątkowo, ponawia nieudane zapytania i korzysta z lokalnego cache w `.cache/`. Lokalizacji nie wybiera AI.

## Architektura

- statyczny HTML, CSS i JavaScript,
- MapLibre GL JS i OpenFreeMap Positron,
- przełączany podkład ortofotomapy GUGiK bez klucza API i opłat za wyświetlenia,
- osobny GeoJSON punktów spraw do klastrowania,
- osobny GeoJSON geometrii działek widoczny przy zbliżeniu,
- statyczne wdrożenie Railway połączone z gałęzią `main` na GitHubie.

Przy skali wielu miast lub całej Polski statyczne pliki powinny zostać zastąpione przez PostgreSQL/PostGIS i kafle wektorowe.
