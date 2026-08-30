# Podsumowanie wdrożenia — cała Polska

- Data: 29 sierpnia 2026
- Produkcja: https://obokmnie-poznan-production.up.railway.app
- Repozytorium: https://github.com/usy-pawel/obokmnie-poznan
- Railway: projekt `obokmnie-poznan`, środowisko `production`
- Architektura: Node.js/Express, PostgreSQL 17 + PostGIS 3.5, MapLibre GL JS

## Zakres danych

- okres: 27 sierpnia 2025 – 27 sierpnia 2026,
- 193 161 unikalnych spraw w bazie,
- 175 385 spraw publikowanych z dokładną geometrią,
- wszystkie 16 województw,
- 406 495 unikalnych identyfikatorów działek w źródłach,
- 366 010 geometrii działek w PostGIS,
- 437 667 relacji sprawa–działka,
- 17 776 spraw bez potwierdzonej geometrii nie jest publikowanych,
- rzeczywisty rozmiar bazy: około 860 MB.

Geometrie zostały dopasowane deterministycznie z krajowego GeoParquet EGiB.
AI nie wybiera lokalizacji ani granic działek.
AI objaśnia wyłącznie dane wybranej sprawy i jej otoczenia po kliknięciu użytkownika.

## Mapa i API

Widok kraju pobiera lekkie klastry, a pojedyncze sprawy i granice działek są
zwracane dopiero dla widocznego obszaru lub wyszukiwania. Dostępne są filtry,
wyszukiwanie, szczegóły sprawy i bezpłatna ortofotomapa GUGiK.

Endpointy produkcyjne:

- `/health`
- `/api/meta`
- `/api/map`
- `/api/search`
- `/api/cases/:caseKey`
- `/api/cases/:caseKey/context` — kontekst pobierany na żądanie i przechowywany w cache

## Lokalne CI

```powershell
npm run check
```

Wynik: 3/3 testów Node oraz 3/3 testów Python. Przeszły także kontrole składni
serwera, frontendu, migracji i importerów.

## Test produkcyjny

```powershell
$env:BASE_URL='https://obokmnie-poznan-production.up.railway.app'
npm run smoke
```

Wynik: 175 385 publikowanych spraw, 16 województw, 382 klastry kraju,
2 240 spraw dla Poznania i poprawne szczegóły wybranej działki.

Test przeglądarkowy potwierdził wyszukiwanie Strzeszyna, otwarcie działki
`120502_5.0010.825`, wyróżnienie jej na ortofotomapie i poprawny widok 390×844.

## Infrastruktura

Aplikacja korzysta z PostGIS przez prywatną sieć Railway. Nieużywana, zapasowa
instancja PostgreSQL została usunięta wraz z pustym wolumenem.
