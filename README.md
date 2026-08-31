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
$env:RADAR_SERVER_ENABLED='1'
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

Paper preflight ma wersję `radar_maintenance_paper_v1`, czyta wyłącznie publiczne endpointy
i nie zapisuje niczego w PostgreSQL.

Prywatny, deterministyczny paper supervisor korzysta z PostGIS i nie wykonuje
napraw produkcyjnych. Tick zawsze uruchamia watchdog, a pełny sweep tylko w
ustalonej godzinie UTC:

```powershell
$env:MAINTENANCE_SUPERVISOR_MODE='paper'
$env:MAINTENANCE_SWEEP_HOUR_UTC='6'
$env:MAINTENANCE_BASE_COMMIT=(git rev-parse HEAD)
$env:ALLOW_LOCAL_MAINTENANCE_RUNNER='1'
npm run maintenance:supervisor-tick
```

Jednorazowe wymuszenie lokalnego/manualnego smoke wymaga dodatkowo pary
`MAINTENANCE_FORCE_SWEEP=1` i `MAINTENANCE_FORCE_CONFIRM=paper_manual_once`.
Nie zapisuje się ich jako stałych zmiennych serwisu.

Zweryfikowany wynik pracy agenta można zapisać atomowo poleceniem
`npm run maintenance:paper-receipt -- material.json`. Ten sam klucz i materiał
odzyskują istniejący receipt; konflikt materiału nie nadpisuje pliku.

Agregatową weryfikację najnowszego udanego importu i eventów Radaru uruchamia:

```powershell
npm run verify:radar-import
```

Skrypt wykonuje jedno zapytanie read-only, nie zwraca danych spraw ani snapshotów i blokuje
aktywację, jeśli choć jeden udany import nie ma rekordu projekcji Radaru.

## Lokalne CI

```powershell
npm run check
```

Kontrole obejmują składnię serwera, frontendu, migracji i importera oraz testy danych. GitHub Actions nie jest bramką wdrożenia.
Lokalne E2E mapy i Radaru uruchamia `npm run test:e2e`; polecenie instaluje przypięte Chromium
do lokalnego cache i wykonuje testy desktop/mobile wyłącznie na syntetycznych danych oraz losowym
porcie loopback. Nie wymaga sekretów ani połączenia z produkcją.

Pełna bramka wydania `npm run check:release` uruchamia dodatkowo E2E, migrację 010→011 oraz testy
SQL/API na losowej bazie `radar_test_*` dostępnej wyłącznie przez loopback.

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

Po rozwinięciu sprawy użytkownik może obserwować jej działkę. Publiczny interfejs nadal zachowuje
obserwacje w `localStorage` i korzysta z kompatybilnego `GET /api/radar`; tego fallbacku nie wolno
usunąć podczas pierwszego rolloutu serwerowego Radaru.

Addytywna migracja `011_server_radar.sql` przygotowuje trwały monitoring pojedynczej działki,
zestawu działek albo promienia 500 m / 1 km / 3 km. Anonimowy profil jest uwierzytelniany losowym
256-bitowym sekretem w host-only cookie; baza przechowuje wyłącznie SHA-256 sekretu i CSRF. Limit to
20 monitorów, 100 przypisań działek i 3 obszary na profil. Profil wygasa po 90 dniach bezczynności,
nie później niż rok od utworzenia; wygasłe profile usuwa ograniczony housekeeping uruchamiany po
każdym udanym imporcie. Ten sam przebieg odzyskuje ewentualne udane importy bez projekcji.

API profili jest domyślnie wyłączone i zwraca 404. Włącza je dopiero
`RADAR_SERVER_ENABLED=1`; stary read-only `GET /api/radar` pozostaje dostępny niezależnie.
Interfejs automatycznie wykrywa ten stan: przy wyłączonym API zachowuje obecny tryb
`localStorage`, a po włączeniu tworzy anonimowy profil, idempotentnie przenosi obserwacje i pokazuje
sterowanie wstrzymaniem, wznowieniem oraz usunięciem monitoringu. Sekret profilu pozostaje wyłącznie
w ciasteczku `HttpOnly`; JavaScript odczytuje tylko osobny token CSRF. Potwierdzone obserwacje
przeglądarkowe nie są usuwane, dzięki czemu wyłączenie routera nadal ma bezpieczny fallback.
Tworzenie profili i monitorów ma trwałe godzinne limity globalne, a profil dodatkowo ogranicza
tworzenie, mutacje i odczyt kanału. Limit jest naliczany przed kosztownym backfillem.

Nowe zdarzenie zachowuje kanoniczną unię działek przed i po zmianie. Dopasowania powstają atomowo
z udanym importem, a nie podczas odczytu przez użytkownika. Pauza zatrzymuje nowe dopasowania;
wznowienie świadomie zaczyna od ostatniego udanego importu, więc zdarzenia z czasu pauzy nie są
uzupełniane. Migracja starych obserwacji jest idempotentna, ograniczona do 90 dni i nie usuwa
`localStorage` przed potwierdzeniem serwera. Dla zdarzeń sprzed migracji dopasowanie OLD+NEW jest
odtwarzane best-effort z bieżącego i poprzedniego snapshotu tej samej sprawy.

Kanał zdarzeń stronicuje po `radar_matches.id` (`after_match_id`), dzięki czemu późny backfill nie
może zostać pominięty przez starszy identyfikator zdarzenia. Jedno dopasowanie jest jednym rekordem
kanału; klient może zwinąć powtórzenia tej samej sprawy. Odpowiedź ma maksymalnie 50 rekordów i
256 KiB, a lista działek w snapshotcie jest ograniczona do 20 pozycji z flagą skrócenia.

Detekcja jest deterministyczna i nie korzysta z AI. Zdarzenia są publikowane tylko dla importów ze
statusem `success`; objaśnienie AI pozostaje osobną funkcją uruchamianą na żądanie w karcie sprawy.

Test migracji i API wymaga wyłącznie izolowanej bazy PostGIS:

```powershell
$env:RADAR_TEST_DATABASE='1'
$env:DATABASE_URL='postgresql://radar:radar_test@127.0.0.1:PORT/radar'
$env:PGSSLMODE='disable'
npm run test:postgis
```

Harness sam tworzy i usuwa losową bazę; skrypty wykonujące `TRUNCATE` odmawiają pracy poza
loopbackiem i bazą o prefiksie `radar_test_`.

Kolejność rolloutu: migracja 011 → kod z API wyłączonym → `verify:radar-import` i smoke → osobna
decyzja o `RADAR_SERVER_ENABLED=1`. Po aktywacji nie wolno cofać samego importera do wersji bez
projekcji. Jeżeli rollback aplikacji jest konieczny, API pozostaje wyłączone, housekeeping odzyskuje
brakujące projekcje przez `npm run maintenance:radar-housekeeping`, a weryfikacja musi ponownie
przejść przed włączeniem.

Po włączeniu routera bezpieczny, read-only smoke profilu uruchamia się bez tworzenia danych:

```powershell
$env:SMOKE_EXPECT_RADAR_SERVER='1'
npm run smoke
```

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
