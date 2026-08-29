# Co budują w Wielkopolsce? — T‑MVP

Publiczna mapa dokładnie zlokalizowanych spraw budowlanych z całego województwa wielkopolskiego. Widok regionalny pokazuje klastry spraw, a przy zbliżeniu rzeczywiste granice działek pobrane z oficjalnej usługi ULDK.

## Dane

- okres: 24 sierpnia 2025 – 24 sierpnia 2026,
- 14 980 opublikowanych spraw i 29 503 powiązania spraw z geometriami działek,
- publikowane są wyłącznie sprawy z co najmniej jedną dokładnie potwierdzoną geometrią działki,
- geometrie są dzielone przestrzennie i pobierane dopiero po przybliżeniu mapy,
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
python scripts/build-wielkopolska-geojson.py
```

Skrypt filtruje oba rejestry GUNB do Wielkopolski, grupuje powtarzające się wiersze spraw, pobiera granice działek z ULDK wielowątkowo, ponawia nieudane zapytania i korzysta z lokalnego cache w `.cache/`. Lokalizacji nie wybiera AI.

## Architektura

- statyczny HTML, CSS i JavaScript,
- MapLibre GL JS i OpenFreeMap Positron,
- przełączany podkład ortofotomapy GUGiK bez klucza API i opłat za wyświetlenia,
- osobny GeoJSON punktów spraw do klastrowania,
- małe przestrzenne fragmenty GeoJSON działek ładowane tylko dla oglądanego obszaru,
- statyczne wdrożenie Railway połączone z gałęzią `main` na GitHubie.

Przy skali całej Polski statyczne fragmenty powinny zostać zastąpione przez PostgreSQL/PostGIS i kafle wektorowe.
