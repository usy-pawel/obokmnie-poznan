# Podsumowanie wdrożenia — cała Polska

- Data: 30 sierpnia 2026
- Produkcja: https://obokmnie-poznan-production.up.railway.app
- Repozytorium: https://github.com/usy-pawel/obokmnie-poznan
- Railway: projekt `obokmnie-poznan`, środowisko `production`
- Architektura: Node.js/Express, PostgreSQL 17 + PostGIS 3.5, MapLibre GL JS

## Zakres danych

- okres: 1 stycznia 2016 – 27 sierpnia 2026,
- 3 209 564 unikalne sprawy w bazie,
- 2 581 496 spraw publikowanych z dokładną geometrią,
- zakres 12 miesięcy: 175 361 spraw,
- zakres 3 lat: 601 888 spraw,
- zakres 5 lat: 1 053 188 spraw,
- wszystkie 16 województw,
- 4 944 868 unikalnych identyfikatorów działek w źródłach,
- 3 827 686 użytecznych geometrii działek w PostGIS,
- 5 329 360 relacji sprawa–działka,
- 628 068 spraw bez potwierdzonej geometrii nie jest publikowanych,
- rzeczywisty rozmiar bazy: 12 181 965 971 bajtów, około 11,35 GiB,
- czas pełnego importu do PostGIS: 7 049 sekund (1 godz. 57 min).

Geometrie zostały dopasowane deterministycznie z krajowego GeoParquet EGiB.
AI nie wybiera lokalizacji ani granic działek.
AI objaśnia wyłącznie dane wybranej sprawy i historię tej samej działki po kliknięciu użytkownika.

## Mapa i API

Widok kraju pobiera lekkie klastry, a pojedyncze sprawy i granice działek są
zwracane dopiero dla widocznego obszaru lub wyszukiwania. Dostępne są filtry,
wyszukiwanie, szczegóły sprawy i bezpłatna ortofotomapa GUGiK.

Endpointy produkcyjne:

- `/health`
- `/api/data-status` — jawny stan ostatniego importu: zdrowy, w toku, nieaktualny albo błąd
- `/api/meta`
- `/api/map`
- `/api/search`
- `/api/cases/:caseKey`
- `/api/cases/:caseKey/context` — kontekst pobierany na żądanie i przechowywany w cache

`/api/meta`, `/api/map`, `/api/search` i `/api/suggestions` przyjmują parametr
`range=1y|3y|5y|all`. Domyślny jest lekki widok `1y`; starsze sprawy są
pobierane wyłącznie na żądanie dla aktualnego widoku mapy.

## Lokalne CI

```powershell
npm run check
```

Wynik: 6/6 testów Node oraz 3/3 testów Python. Przeszły także kontrole składni
serwera, frontendu, migracji i importerów.

## Test produkcyjny

```powershell
$env:BASE_URL='https://obokmnie-poznan-production.up.railway.app'
npm run smoke
```

Oczekiwany wynik po wdrożeniu: 175 361 spraw z ostatnich 12 miesięcy,
2 581 496 spraw historycznych, 16 województw, 8 obszarów Wielkopolski,
2 240 spraw dla Poznania i poprawne szczegóły wybranej działki.

Test przeglądarkowy 390×844 potwierdził przełączenie 12 miesięcy / 3 lata /
5 lat / od 2016, nieblokujące ładowanie w tle, wejście z kraju do 8 obszarów
województwa oraz pełne szczegóły i kontekst starszej sprawy.

## Infrastruktura

Aplikacja korzysta z PostGIS przez prywatną sieć Railway. Nieużywana, zapasowa
instancja PostgreSQL została usunięta wraz z pustym wolumenem.

Aktualizacja danych działa jako osobna usługa cykliczna Railway. Po nocnej
publikacji GUNB pobiera komplet archiwów, aktualizuje ruchome 12 miesięcy,
ponownie używa dodatnich i negatywnych wyników geometrii z PostGIS i kończy proces. Kontrole regresji blokują
publikację podejrzanie niepełnego przebiegu; błąd jest zapisany w tabeli
`imports` i widoczny przez `/api/data-status`. Usługa używa minimalnego obrazu
`Dockerfile.cron`; nie uruchamia serwera WWW i nie pozostaje aktywna między
przebiegami.
