# RadarZmian — agent runbook v1

## Przepływ zmiany

1. Koordynator pobiera deterministyczny, ograniczony preflight.
2. Newton ocenia, czy istniejący mechanizm wystarcza i zamraża granice zmiany.
3. Świeży Engineer dostaje wyłącznie stage pack, pracuje lokalnie i uruchamia
   wskazane testy. Nie ma sekretów, Railway, prywatnego API, pusha ani deployu.
4. Ada wykonuje niezależny code review.
5. Dodatkowe gate'y uruchamiają się według zakresu poniżej.
6. Lokalne CI jest dowodem technicznym. GitHub Actions nie jest bramką.
7. Koordynator zapisuje receipt i zatrzymuje się na human gate albo przygotowuje
   bezpieczny następny krok.
8. Po produkcyjnym wdrożeniu Felix domyka incydent dopiero po smoke i wyniku
   użytkownika/danych, a następnie zapisuje przyczynę i test regresji.

## Role i obowiązkowe wywołania

| Rola | Kiedy | Sprawdza | Nie robi |
|---|---|---|---|
| Newton | control plane, schemat, nowe usługi | prostota, granice, koszt utrzymania | nie implementuje |
| Ada | każda zmiana kodu | bugi, transakcje, edge case'y, testy | nie zatwierdza produktu |
| Soter | API, tokeny, e-mail, logi, dane | auth, PII, SSRF, sekrety, abuse | nie obniża bezpieczeństwa dla wygody |
| Eva | krytyczny przepływ i wdrożenie | E2E, błędy, mobile/desktop, smoke | nie tworzy danych produkcyjnych bez safe flag |
| Darek | migracje, retry, retencja, recovery | restore, idempotencja, backoff, utrata odpowiedzi | nie robi destrukcyjnego restore na produkcji |
| Iga | zależności i tooling | wersje, lockfile, install scripts, provenance | nie aktualizuje zależności bez zakresu |
| Felix | potwierdzony incydent | root cause, test regresji, rollout i outcome | nie zamyka po samym deployu |
| Leon | wydajność | pomiar przed/po, zapytania, payload i render | nie wymyśla metryk |
| Alicja | formularze i interakcje | klawiatura, focus, semantyka, kontrast | nie zastępuje testu manualnego samym skanerem |
| Recenzent | polskie copy | sens, spójność, komunikaty i terminologia | nie zmienia faktów technicznych |

## Macierz gate'ów

- Schemat, importer, eventy lub subskrypcje: Newton, Ada, Darek, Soter.
- Prywatny API, token zarządzania, e-mail lub admin: Ada, Soter, Darek, Eva.
- Frontend, mapa, formularz i komunikaty: Ada, Eva, Alicja, Recenzent; Leon,
  jeśli zmiana wpływa na render, sieć lub wydajność.
- Zależności, Docker, Railway i skrypty wdrożenia: Iga oraz właściwy reviewer
  techniczny.
- Incydent produkcyjny: Felix oraz reviewerzy odpowiadający zmienionemu
  subsystemowi.

## Receipt zmiany

Podsumowanie przed decyzją lub wdrożeniem zawiera:

- identyfikator problemu lub zadania i context hash,
- branch/worktree i dokładny commit,
- listę zmienionych plików,
- komendy oraz wyniki lokalnego CI,
- wyniki wymaganych reviewerów,
- plan migracji, smoke i rollbacku,
- jawne pominięte pokrycie,
- decyzję Pawła, jeśli była wymagana.
