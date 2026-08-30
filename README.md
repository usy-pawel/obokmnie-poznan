# Co budują w Polsce? — T‑MVP

Publiczna mapa dokładnie zlokalizowanych spraw budowlanych z całej Polski. Widok kraju pokazuje lekkie skupiska spraw, a po przybliżeniu lub wyszukaniu API zwraca pojedyncze sprawy i rzeczywiste granice działek z oficjalnej usługi ULDK.

## Dane

- dane w bazie: pełna historia od 2016 roku; domyślny widok mapy: ostatnie 12 miesięcy,
- 3 209 564 unikalne sprawy w pełnym imporcie,
- 2 581 496 spraw z dokładną geometrią, obejmujących wszystkie 16 województw,
- 4 944 868 unikalnych identyfikatorów działek do weryfikacji; 3 827 686 ma użyteczną geometrię,
- widoki na żądanie: 175 361 spraw z 12 miesięcy, 601 888 z 3 lat i 1 053 188 z 5 lat,
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

Pełny import historii:

```powershell
$env:OBOKMNIE_PERIOD_START='2016-01-01'
$env:OBOKMNIE_SKIP_ULDK='1'
python scripts/import-poland-postgis.py
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

Importer strumieniowo czyta 18 archiwów GUNB, normalizuje wybrany zakres w lokalnym etapie SQLite i usuwa duplikaty spraw. `OBOKMNIE_PERIOD_START` włącza pełną historię; bez tej zmiennej aktualizowany jest ostatni rok bez usuwania wcześniejszych relacji. Geometrie są najpierw łączone zbiorczo z oficjalnym krajowym GeoParquet EGiB, a ULDK pozostaje awaryjnym źródłem dla brakujących identyfikatorów. Wyniki trafiają do wznawialnego cache w `.cache/`, a następnie do PostGIS. Lokalizacji nie wybiera AI.

Pełny import wykonany 30 sierpnia 2026 trwał 7 049 sekund. Baza po imporcie zajmuje 12 181 965 971 bajtów, czyli około 11,35 GiB.

## Architektura

- statyczny HTML, CSS i JavaScript obsługiwany przez Express,
- PostgreSQL/PostGIS jako baza spraw, działek i relacji,
- lekkie agregaty przestrzenne dla widoku kraju i zapytania po obszarze dla większego zbliżenia,
- zakres mapy wybierany na żądanie: 12 miesięcy, 3 lata, 5 lat albo pełna historia od 2016 roku,
- MapLibre GL JS i OpenFreeMap Positron,
- przełączany podkład ortofotomapy GUGiK bez klucza API,
- kontekst sprawy generowany dopiero po jej otwarciu z danych GUNB i historii tej samej działki,
- pojedyncze objaśnienie GPT-5.6 Luna zapisywane w PostGIS i ponownie używane do czasu zmiany danych źródłowych,
- Railway połączony z gałęzią `main` na GitHubie.
