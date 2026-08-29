# Co budują na Strzeszynie? — T‑MVP

Publiczna, interaktywna mapa sześciu potwierdzonych spraw budowlanych ze Strzeszyna. Osiem geometrii działek pochodzi z oficjalnej usługi ULDK, a informacje o sprawach z eksportu GUNB RWDZ.

## Uruchomienie

Do lokalnego podglądu wystarczy dowolny statyczny serwer HTTP, np. Python 3:

```powershell
python -m http.server 3000 --directory public
```

Strona będzie dostępna pod `http://localhost:3000`.

## Lokalne CI

```powershell
npm run check
```

Kontrole obejmują składnię JavaScript, spójność GeoJSON, kompletność sześciu spraw i położenie geometrii w kontrolnym zakresie Strzeszyna.

## Aktualizacja danych

Skrypt `scripts/build-geojson.py` pobiera pełne geometrie działek z ULDK dla spraw zapisanych w artefakcie MVP 0. Lokalizacje nie są generowane przez AI.

## Architektura

- statyczny HTML, CSS i JavaScript,
- MapLibre GL JS,
- mapa bazowa OpenFreeMap Positron,
- statyczny GeoJSON dla T‑MVP,
- statyczne wdrożenie Railway bez warstwy aplikacyjnej.

Przy skali całej Polski statyczny GeoJSON powinien zostać zastąpiony przez PostgreSQL/PostGIS i kafle wektorowe.

## Źródła

- https://wyszukiwarka.gunb.gov.pl/
- https://uldk.gugik.gov.pl/
- https://openfreemap.org/
- https://www.openstreetmap.org/copyright
