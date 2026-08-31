# Radar Zmian — raport bezpieczeństwa, wydajności i recovery

Data kontroli: 2026-08-31  
Zakres: lokalne testy izolowane oraz read-only kontrola konfiguracji Railway. Bez migracji, mutacji danych i zmian zasobów produkcyjnych.

## Wynik

Lokalna bramka jest zielona. Router serwerowego Radaru pozostaje wyłączony w produkcji
(`RADAR_SERVER_ENABLED` nie jest ustawione). Włączenie wymaga osobnej decyzji i wdrożenia.

| Obszar | Dowód | Wynik |
|---|---|---|
| Tokeny i sesje | Baza przechowuje wyłącznie 32-bajtowe SHA-256 tokenu profilu i CSRF. Cookie profilu jest `HttpOnly`, `Secure`, `SameSite=Strict`; profil ma limit 90 dni bezczynności i 365 dni bezwzględny. Usunięcie profilu unieważnia token. Surowe tokeny nie pojawiają się w logach testowego serwera. | PASS |
| Abuse i izolacja | CSRF, same-origin, izolacja profili, ścisła walidacja payloadu, idempotency conflict, limity globalne i per profil, limit 20 monitorów / 100 działek / 3 promieni. Serwer testowy słucha wyłącznie na `127.0.0.1` i nie dziedziczy sekretów AI ani maintenance. | PASS |
| Zimny start i viewporty | 12 testów Playwright: telefon 390×844, desktop 1366×900 i duży desktop 1920×1080. Każdy wariant przechodzi pełny drill-down, Radar, historię, resize i realny MapLibre click/tap. Budżet klienta: 2,5 s; realnej mapy: 6 s. | PASS |
| Projekcja monitoringu | Izolowany PostGIS: 100 profili, 300 monitorów (działka, zestaw, promień) i 200 zdarzeń, czyli co najmniej 60 000 dopasowań. Zaobserwowany zakres: 2,35–6,27 s przy budżecie 8 s i twardym timeout 10 s. | PASS |
| Przerwane wdrożenie | Migracja 011 jest wykonywana w transakcji, po czym backend PostgreSQL jest zrywany przed `COMMIT`. Po ponownym połączeniu nie ma częściowego schematu ani wpisu migracji; pełny retry przechodzi. | PASS |
| Backup i restore | Przypięty digest obrazu PostGIS, `pg_dump --format=custom`, `pg_restore --exit-on-error`, porównanie stanu przed/po, idempotentny retry migracji i pełny test API na odtworzonej bazie. | PASS |
| Fencing po restore | Backup zawiera aktywny run i lease z fence `7`. `maintenance:restore-reset` blokuje run, czyści lease, utrzymuje kill switch i podnosi fence do `8`. | PASS |
| Prywatny PostGIS Railway | Read-only kontrola weba, importera i `radar-maintenance-paper`: wszystkie mają `DATABASE_URL` z hostem `*.railway.internal`, żaden nie ma `DATABASE_PUBLIC_URL`. Nie odczytywano ani nie zapisywano wartości sekretów. | PASS |

## Wykonane kontrole

```text
npm run check
npm run test:e2e
npm run test:recovery
npm run test:postgis
npm run check:release
npm audit
npm audit signatures
git diff --check
```

`test:recovery` tworzy jednorazowy kontener i dwie losowe bazy `radar_test_recovery_*` dostępne
wyłącznie przez loopback. Każdy proces ma deadline, a błąd cleanupu oblewa bramkę. Po teście nie
pozostają kontenery, dumpy ani bazy.

## Ryzyka resztkowe

- Test wydajności jest celowo ograniczony i syntetyczny. Chroni przed dużą regresją algorytmiczną,
  ale nie zastępuje read-only obserwacji czasów na produkcyjnym wolumenie po wdrożeniu.
- Test odtwarza logiczny dump PostgreSQL w lokalnym PostGIS. Nie sprawdza panelu kopii zapasowych
  Railway ani parametrów retencji dostawcy.
- Router jest nadal wyłączony. Aktywacja bez uprzedniego `verify:radar-import` i read-only smoke
  pozostaje niedozwolona.

## Plan rollbacku

1. Pozostawić lub przywrócić `RADAR_SERVER_ENABLED=0`/brak zmiennej; fallback `localStorage` działa dalej.
2. W razie rollbacku aplikacji nie cofać addytywnej migracji 011 ani importera po publikacji projekcji.
3. Uruchomić `npm run maintenance:radar-housekeeping`, następnie `npm run verify:radar-import`.
4. Po odtworzeniu bazy obowiązkowo uruchomić `npm run maintenance:restore-reset`, potwierdzić brak
   aktywnego lease'u, podniesiony fence i aktywny kill switch.
5. Dopiero po zielonym read-only smoke rozważyć ponowne włączenie routera w osobnej decyzji.
