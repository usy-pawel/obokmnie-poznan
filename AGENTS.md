# RadarZmian — zasady pracy agentów

## Źródła prawdy

- PostgreSQL/PostGIS pozostaje źródłem prawdy o sprawach, działkach, importach,
  zdarzeniach Radaru i przyszłych subskrypcjach.
- `docs/maintenance-supervisor.md` opisuje control plane autoutrzymania.
- `docs/agent-runbook.md` określa kolejność ról i wymagane review.
- Nie kopiuj domenowych mechanizmów Widać Mnie, gdy istniejący importer,
  `imports`, `case_events` albo prosta funkcja RadarZmian wystarczą.

## Granice autonomii

Praca read-only, diagnoza, lokalna implementacja, testy i przygotowanie szkicu
mogą odbywać się automatycznie. Bez świeżej decyzji Pawła agent nie może:

- wdrożyć na produkcję ani uruchomić produkcyjnej migracji,
- włączyć cyklicznego Supervisora lub rozszerzyć jego uprawnień,
- dodać płatnej usługi, kupić domeny lub zwiększyć budżetu,
- wysłać wiadomości, opublikować dokumentu albo skontaktować się z GUNB,
- dodać lub zmienić przetwarzania e-maila, retencji albo zgody,
- wykonać destrukcyjnej operacji na danych, DNS lub infrastrukturze.

`await_human` jest poprawne wyłącznie dla konkretnej zapisanej decyzji. Zwykła
praca techniczna, brak wykonawcy albo błąd narzędzia nie są decyzją człowieka.

## Zasady implementacji

- Pracuj w czystym worktree. Nie dołączaj cudzych ani niezwiązanych zmian.
- Implementer nie używa produkcyjnych sekretów, Railway, pusha ani deployu.
- Prywatny preflight dla agenta musi być ograniczony, wersjonowany i
  zredagowany; nie zawiera e-maili, tokenów, IP ani surowych logów.
- Każda mutacja maintenance używa stabilnego klucza idempotencji. Claim wymaga
  lease'u, heartbeatów i fencing tokenu; spóźniony wykonawca nie zapisuje.
- Długotrwały importer nie używa lease'u Supervisora. Przez cały przebieg trzyma
  własny sesyjny PostgreSQL advisory lock; fencing dotyczy tylko control plane.
- Detekcja awarii i zmian danych jest deterministyczna. Model może wyjaśniać lub
  proponować naprawę, ale nie jest źródłem health, severity ani sukcesu.
- Terminalny przebieg musi zakończyć każdy wykryty problem przez naprawę,
  typowane zadanie albo konkretną decyzję Pawła.
- Gdy źródło prawdy jest niedostępne, przebieg kończy się jawnie jako błąd i nie
  udaje zapisanego accountability. Nie twórz drugiego magazynu tylko dla awarii.
- Logi, błędy i receipty nie mogą przechowywać sekretów ani danych osobowych.
- Zgoda Pawła jest jednorazowa, wygasa i wiąże dokładny context hash, commit lub
  migrację oraz środowisko; nie wolno użyć jej ponownie dla innego skutku.
- Po każdej zmianie sprawdź, czy wykorzystano istniejący mechanizm i czy ten sam
  efekt da się osiągnąć prościej.

## Lokalne CI

GitHub Actions nie jest bramką odbioru. Przed review, pushem lub wdrożeniem
uruchom lokalnie:

```powershell
npm run check
```

Zmiana schematu lub recovery wymaga dodatkowo migracji i testu na izolowanym
PostgreSQL/PostGIS. Zmiana krytycznej ścieżki wymaga odpowiedniego E2E oraz
bezpiecznego smoke testu. Wyniki poleceń trafiają do podsumowania wdrożenia.

## Minimalne review

- Newton — architektura i prostota control plane.
- Ada — kod, transakcje, edge case'y i testy.
- Soter — sekrety, prywatne API, tokeny, PII i abuse.
- Eva — pełny przepływ oraz E2E na telefonie i desktopie.
- Darek — migracje, idempotencja, retry, retencja i restore.
- Iga — zależności, lockfile, runtime i supply chain.
- Felix — przyczyna incydentu, test regresji i pamięć incydentu.

Warunkowo uruchamiaj Leona dla wydajności, Alicję dla interakcji i dostępności
oraz Recenzenta dla polskiego tekstu widocznego dla użytkownika.
