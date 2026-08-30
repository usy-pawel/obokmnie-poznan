# Radar Maintenance Supervisor v1

## Cel i granice

Maintenance Supervisor jest lekkim control plane RadarZmian. Nie zastępuje
importera ani tabel domenowych. Odczytuje istniejące `imports`, `cases`,
`parcels` i `case_events`, materializuje stan zdrowia, przypisuje problem oraz
bezpiecznie koordynuje naprawę.

Pierwsza wersja nie zawiera biznesowych celów, eksperymentów, researchu,
Business Wisdom, rejestru ewaluacji modeli ani automatycznych publikacji.

## Kolejność wdrożenia

1. Naprawić fundament: lock importera, readiness bazy, świeżość danych, trwałe
   kody błędów oraz osobny `last_success` po późniejszej awarii.
2. Dodać deterministyczny read-only health i lokalny paper receipt bez nowej
   warstwy persistence. Obserwować rzeczywiste przebiegi i kody błędów.
3. Dopiero po potwierdzeniu wartości dodać fingerprintowane problemy,
   idempotentne zadania, claim, lease, heartbeat, fencing i decyzje.
4. Dodać ograniczony prywatny preflight, transition/release i accountability.
5. Dopiero po zatwierdzeniu Pawła aktywować cykliczną automatyzację.

## Zarządzane zdolności

Pierwszy rejestr health jest zamknięty i deterministyczny:

| Zdolność | Sygnał | Degradacja | Blokada | Domyślna naprawa |
|---|---|---|---|---|
| `web_database` | `SELECT 1` | nie dotyczy | brak konfiguracji lub połączenia | engineer / human dla credentiala |
| `daily_import` | `imports` | ostatni sukces starszy niż 36 h | brak sukcesu przez 48 h albo latest `failed` | automatic retry raz, potem engineer |
| `data_coverage` | metryki udanego importu | spadek poza zatwierdzony zakres | liczba województw inna niż 16 lub walidacja publikacji | engineer |
| `radar_diff` | metryki importu i `case_events` | rozbieżność liczby oczekiwanych oraz zapisanych zdarzeń | zdarzenia z częściowego/nieudanego importu | engineer |

Retry jest ograniczony i idempotentny. Brak credentiala, cofnięta zgoda,
niejednoznaczna operacja na danych albo wyczerpany retry tworzą konkretną
decyzję lub zadanie, a nie kolejną ślepą próbę.

## Severity i priorytet

1. **P0:** ryzyko prywatności, sekretu, korupcji danych, publikacja
   niezweryfikowanego zestawu albo błędna geometria masowa.
2. **P1:** web niedostępny, dane `stale`, alerty zablokowane,
   utracony lease lub nieudana migracja.
3. **P2:** regresja wydajności, częściowe pokrycie nieblokujące publikacji,
   problem UX lub dostępności.
4. Praca planowa.
5. `idle` tylko przy braku problemu i gotowego zadania.

Severity pochodzi z kodu i metryk, nigdy z narracji modelu.

Importer nie używa lease'u Supervisora. Utrzymuje osobne sesyjne PostgreSQL
advisory lock przez cały rzeczywisty przebieg, także gdy staging trwa dłużej niż
50 minut. Drugi importer kończy się bez mutacji z trwałym kodem
`import_already_running` i kodem procesu `0`, aby kontrolowany skip nie uruchamiał
restartów crona. Wspólny plik SQLite stage ma osobną blokadę sesyjną SQLite.
Fencing chroni wyłącznie późniejszy control plane.

Warunek `radar_diff` staje się aktywny dopiero wtedy, gdy udany import zapisuje
w metrykach liczbę oczekiwanych zmian według typu oraz liczbę faktycznie
zapisanych `case_events`; projektor porównuje te wartości 1:1. Do tego czasu
sprawdza wyłącznie zakaz publikacji eventów z importu innego niż `success`.

## Wdrożony minimalny model danych

Control plane używa trzech tabel i istniejących danych domenowych:

- `maintenance_runs` — historia wywołań, idempotency key, niezmienny context
  hash, fencing token, wynik i terminalny accountability receipt;
- `maintenance_leases` — jeden aktywny owner scope, kill switch, fencing token
  i expiry;
- `maintenance_issues` — bieżąca projekcja fingerprintowanych problemów,
  severity, kod, wystąpienia, status, bezpieczny kontekst i owner.

Historia `maintenance_runs` jest śladem przebiegów chronionym triggerem przed
`DELETE`, `TRUNCATE`, zmianą tożsamości oraz modyfikacją terminalnego
rekordu. Ochrona dotyczy zwykłego kontraktu zapisu aplikacji; nie zastępuje
backupów ani uprawnień administracyjnych. Issue jest projekcją stanu, nie
dziennikiem zdarzeń. Osobne tabele zadań, decyzji, eventów i metryk nie powstają
w tym etapie: dokładamy je wyłącznie wtedy, gdy kolejne etapy wykażą potrzebę,
której nie pokrywa ten model.

Nie przechowujemy pełnych logów, promptów, odpowiedzi modeli, e-maili ani
sekretów. Bezpieczny kontekst ma zamknięty schemat i twardy limit rozmiaru.

## Claim, lease i recovery

- `acquire` zapisuje niezmienny `contextHash`, ownera, czas startu i rosnący
  fencing token.
- Lease trwa 20 minut, heartbeat następuje nie rzadziej niż co 5 minut, a cały
  przebieg kończy się najpóźniej po 50 minutach.
- Ten sam idempotency key z tym samym materiałem zwraca istniejący wynik.
- Ten sam klucz z innym materiałem jest błędem kontraktu.
- Wygasły lease oznacza `timed_out`; nowy wykonawca dostaje wyższy fencing
  token. Stary nie może zapisać transition, result ani release.
- Utrata odpowiedzi po trwałym zapisie jest obsługiwana przez odczyt istniejącego
  receipt, bez powtórzenia skutku.

W obecnym etapie deadline jest egzekwowany przy każdym kolejnym kontakcie z
control plane: `acquire`, `heartbeat`, zakończenie lub porażka materializują
`timed_out` atomowo. Jeżeli proces zniknie i nikt więcej nie wykona operacji,
rekord może pozostać fizycznie `running` po deadline, choć lease jest już
logicznie nieważny. Cykliczny watchdog materializujący takie timeouty należy do
etapu Supervisora; do jego wdrożenia nie raportujemy gwarancji fizycznego
zakończenia rekordu w 50. minucie.

Restore bazy wymaga zatrzymania wszystkich workerów Supervisora i potwierdzenia,
że żaden stary proces nie działa. Po restore, jeszcze przed ich wznowieniem,
operator uruchamia `npm run maintenance:restore-reset` z jednorazową zmienną
`CONFIRM_RADAR_RESTORE_RESET=radar_operations`. Narzędzie pod advisory lockiem
i w jednej transakcji:

1. oznacza wszystkie odtworzone przebiegi `running` jako `blocked` z kodem
   `restore_invalidated` i terminalnym receiptem
   `radar_restore_reset_v1`;
2. czyści tożsamość lease'u, zwiększa fencing token i ustawia
   `actions_disabled=true`;
3. przed commitem sprawdza brak przebiegów `running`, pusty lease oraz aktywny
   kill switch.

Receipt resetu zapisuje
`accountability_status=not_evaluated_after_restore` i celowo nie zawiera
`remaining=[]`: reset nie jest health sweepem i nie może świadczyć, że
odtworzone problemy zostały rozwiązane. Następny preflight oraz pełny
accountability sweep są obowiązkowe przed zdjęciem kill switcha.

Dopiero nowy preflight i osobna decyzja o zdjęciu kill switcha pozwalają wznowić
pracę. Bez tej sekwencji restore może cofnąć także fence i przywrócić ważność
starego uchwytu, więc produkcyjny restore nie jest dozwolony.

Limit 50 minut dotyczy wyłącznie przebiegu Supervisora. Nie ogranicza importera,
który może trwać około dwóch godzin i chroni się własnym advisory lockiem.

## Preflight i stage pack

Prywatny preflight ma wersję `radar_maintenance_api_v1` i zwraca maksymalnie
32 KB:

- czas i freshness,
- jeden wybrany problem lub zadanie,
- zagregowane metryki ostatniego oraz ostatniego udanego importu,
- status lease'u bez credentiala,
- kill switch i politykę autonomii,
- listę brakujących wymaganych zdolności,
- `contextHash` wyliczony ze stabilnego JSON.

Implementer dostaje wyłącznie zamrożony stage pack z publiczną referencją,
kodem błędu, severity, liczbą wystąpień, bezpiecznym kontekstem i kryteriami
odbioru. Nie dostaje prywatnego API, fence'a, Railway ani sekretów.

## Odpowiedzialne zakończenie

Każdy terminalny transition wykonuje `radar_accountability_v1`:

- ponownie sprawdza zarządzane zdolności,
- przypisuje nowe problemy do istniejącego lub nowego zadania,
- zamyka nieaktualne problemy po potwierdzonym powrocie zdrowia,
- odrzuca release, jeśli pozostaje problem bez ownera i następnej akcji,
- zapisuje `remaining=[]` albo jawny wykaz problemów z ownerem.

Opis agenta nie jest dowodem zdrowia. Dowodem jest zapytanie, pomiar, test,
commit, wynik wdrożenia lub bezpieczny smoke odpowiedni dla danego etapu.

Gdy sama baza jest niedostępna, Supervisor nie może uczciwie zapisać receipt,
issue ani accountability w tym samym źródle prawdy. Zewnętrzny przebieg kończy
się wtedy błędem `database_unavailable`, bez fałszywego terminalnego sukcesu i
bez drugiego magazynu danych. Po odzyskaniu bazy kolejny sweep zapisuje
incydent z czasem pierwszej zaobserwowanej porażki dostępnym z bezpiecznego
receiptu wykonania automatyzacji.

## Human gates

Decyzja człowieka musi zawierać dokładne pytanie, akcję, zakres i wpływ. Jest
wymagana dla produkcyjnego deployu i migracji, zmiany autonomii, kosztu,
credentiala, retencji, domeny/DNS, kontaktu, publikacji oraz destrukcyjnej
operacji. Brak wykonawcy albo zwykła naprawa techniczna nie są human gate.

Zgoda jest jednorazowa i związana z `contextHash`, dokładnym commitem albo
migracją oraz środowiskiem. Ma termin ważności i `consumed_at`; nie może zostać
ponownie użyta dla innego materiału ani drugiego skutku.

## Paper-mode

Przed aktywacją Supervisor może tylko:

- pobrać preflight,
- rozpoznać priorytet,
- utworzyć lokalny plan lub patch w czystym worktree,
- uruchomić lokalne testy i reviewerów,
- zapisać receipt oraz propozycję następnego kroku.

Pierwszy paper-mode jest read-only i nie wymaga nowych tabel. Receipt pozostaje
lokalnym artefaktem przebiegu oraz aktualizacją zadania w Notion. Trwały control
plane powstaje dopiero po zebraniu dowodu, że paper-mode wykrywa użyteczne
problemy bez szumu.

Nie może użyć produkcyjnego credentiala implementera, zmienić Railway, wykonać
pusha, deployu, migracji, retry importu ani działania zewnętrznego.
