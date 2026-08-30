# Co budują w Polsce? — T‑MVP

Publiczna mapa dokładnie zlokalizowanych spraw budowlanych z całej Polski. Widok kraju pokazuje lekkie skupiska spraw, a po przybliżeniu lub wyszukaniu API zwraca pojedyncze sprawy i rzeczywiste granice działek z oficjalnej usługi ULDK.

## Dane

- okres: ostatnie 12 miesięcy według najnowszego wpisu w źródłach,
- 193 161 unikalnych spraw w bieżącym imporcie,
- 175 385 spraw z dokładną geometrią, obejmujących wszystkie 16 województw,
- 406 495 unikalnych identyfikatorów działek do weryfikacji,
- publikowane są wyłącznie sprawy z co najmniej jedną dokładnie potwierdzoną geometrią działki,
- źródła: GUNB RWDZ, GUGiK ULDK, bezpłatna ortofotomapa WMTS oraz OpenStreetMap/OpenFreeMap.

## Uruchomienie lokalne

Wymagane są Node.js 20+, Python 3.11+ oraz PostgreSQL z PostGIS.

```powershell
npm install
pip install -r scripts/requirements.txt
$env:DATABASE_URL='postgresql://...'
$env:PGSSLMODE='disable'
$env:OPENAI_API_KEY='...'
$env:OPENAI_BASE_URL='https://api.openai.com/v1'
$env:OPENAI_CONTEXT_MODEL='gpt-5.6-luna'
npm run migrate
npm start
```

Strona będzie dostępna pod `http://localhost:3000`, a stan usługi pod `/health`.

## Lokalne CI

```powershell
npm run check
```

Kontrole obejmują składnię serwera, frontendu, migracji i importera oraz testy danych. GitHub Actions nie jest bramką wdrożenia.

## Aktualizacja danych

```powershell
npm run import:egib
npm run import:data
```

Importer strumieniowo czyta 17 bieżących archiwów GUNB, normalizuje ostatnie 12 miesięcy w lokalnym etapie SQLite i usuwa duplikaty spraw. Geometrie są najpierw łączone zbiorczo z oficjalnym krajowym GeoParquet EGiB, a ULDK pozostaje awaryjnym źródłem dla brakujących identyfikatorów. Wyniki trafiają do wznawialnego cache w `.cache/`, a następnie do PostGIS. Lokalizacji nie wybiera AI.

## Architektura

- statyczny HTML, CSS i JavaScript obsługiwany przez Express,
- PostgreSQL/PostGIS jako baza spraw, działek i relacji,
- lekkie agregaty przestrzenne dla widoku kraju i zapytania po obszarze dla większego zbliżenia,
- MapLibre GL JS i OpenFreeMap Positron,
- przełączany podkład ortofotomapy GUGiK bez klucza API,
- kontekst sprawy generowany dopiero po jej otwarciu z danych GUNB i historii tej samej działki,
- pojedyncze objaśnienie GPT-5.6 Luna zapisywane w PostGIS i ponownie używane do czasu zmiany danych źródłowych,
- Railway połączony z gałęzią `main` na GitHubie.
