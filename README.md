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

Strona będzie dostępna pod `http://localhost:3000`, stan usługi pod `/health`,
a stan ostatniej aktualizacji danych pod `/api/data-status`.

Read-only paper preflight zapisuje ograniczony lokalny receipt w `.cache`:

```powershell
npm run maintenance:preflight -- --base-url http://localhost:3000 --allow-localhost
```

Preflight ma wersję `radar_maintenance_api_v1`, czyta wyłącznie publiczne endpointy
i nie zapisuje niczego w PostgreSQL.

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

Importer strumieniowo czyta 18 archiwów GUNB, normalizuje wybrany zakres w lokalnym etapie SQLite i usuwa duplikaty spraw. `OBOKMNIE_PERIOD_START` włącza pełną historię; bez tej zmiennej aktualizowany jest ruchomy ostatni rok i zachowywana jest wcześniejsza historia. Automatyczny przebieg pobiera świeże archiwa po ustawieniu `OBOKMNIE_DOWNLOAD_ARCHIVES=1`.

Przed zmianą widocznych danych importer sprawdza komplet 16 województw, minimalną liczebność, dopuszczalną zmianę względem bieżącej bazy i udział spraw z geometrią. Podejrzany przebieg kończy się błędem bez przełączenia publikacji. Rekordy usunięte ze źródła pozostają w bazie audytowej jako nieaktywne. Istniejące geometrie oraz potwierdzone braki są ponownie używane bezpośrednio z PostGIS, a ULDK jest wywoływany tylko dla nowych identyfikatorów. Lokalizacji nie wybiera AI.

Dobowy przebieg produkcyjny:

```powershell
$env:OBOKMNIE_DOWNLOAD_ARCHIVES='1'
$env:OBOKMNIE_ZIP_DIR='.cache/gunb-zips'
$env:OBOKMNIE_STAGE='.cache/daily-stage.sqlite'
npm run update:data
```

Pełny import wykonany 30 sierpnia 2026 trwał 7 049 sekund. Baza po imporcie zajmuje 12 181 965 971 bajtów, czyli około 11,35 GiB.

## Radar Zmian MVP

Po rozwinięciu sprawy użytkownik może obserwować jej działkę. Lista obserwowanych działek jest
przechowywana wyłącznie w jego przeglądarce, bez konta i bez danych osobowych. Po kolejnych udanych
importach endpoint `GET /api/radar` zwraca nowe, zmienione lub usunięte ze źródła sprawy dotyczące
obserwowanych działek. Pierwszym kanałem powiadomienia jest licznik i oś zmian w interfejsie.

Detekcja jest deterministyczna i nie korzysta z AI. Zdarzenia są publikowane tylko dla importów ze
statusem `success`; objaśnienie AI pozostaje osobną funkcją uruchamianą na żądanie w karcie sprawy.

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
