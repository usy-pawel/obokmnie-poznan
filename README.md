# Co budują na Strzeszynie? — T‑MVP

Publiczna, interaktywna mapa sześciu potwierdzonych spraw budowlanych ze Strzeszyna. Osiem geometrii działek pochodzi z oficjalnej usługi ULDK, a informacje o sprawach z eksportu GUNB RWDZ.

## Uruchomienie

Wymagany jest Node.js 20 lub nowszy.

```powershell
npm start
```

Strona będzie dostępna pod `http://localhost:3000`, a kontrola zdrowia pod `/health`.

## Lokalne CI

```powershell
npm run check
```

Kontrole obejmują składnię JavaScript, spójność GeoJSON, kompletność sześciu spraw, położenie geometrii w kontrolnym zakresie Strzeszyna oraz działanie serwera HTTP.

## Aktualizacja danych

Skrypt `scripts/build-geojson.py` pobiera pełne geometrie działek z ULDK dla spraw zapisanych w artefakcie MVP 0. Lokalizacje nie są generowane przez AI.

## Architektura

- statyczny HTML, CSS i JavaScript,
- MapLibre GL JS,
- mapa bazowa OpenFreeMap Positron,
- statyczny GeoJSON dla T‑MVP,
- minimalny serwer Node.js gotowy do wdrożenia na Railway.

Przy skali całej Polski statyczny GeoJSON powinien zostać zastąpiony przez PostgreSQL/PostGIS i kafle wektorowe.

## Źródła

- https://wyszukiwarka.gunb.gov.pl/
- https://uldk.gugik.gov.pl/
- https://openfreemap.org/
- https://www.openstreetmap.org/copyright
