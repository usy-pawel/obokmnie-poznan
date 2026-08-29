# Podsumowanie wdrożenia — Poznań

## Aktualizacja: ortofotomapa działek

- domyślny podkład zdjęć lotniczych z bezpłatnej usługi WMTS GUGiK,
- przełącznik „Mapa / Zdjęcie” dostępny na desktopie i urządzeniach mobilnych,
- przycisk w szczegółach sprawy pokazujący wybraną działkę na ortofotomapie,
- obrysy działek zachowują czytelność bez zasłaniania zabudowy,
- źródło danych jest oznaczone bezpośrednio na mapie.

Kontrola przed wdrożeniem: `npm run check`, `git diff --check`, test przeglądarkowy desktop i mobile 390 × 844 px; 6/6 testów zaliczonych, bez błędów i ostrzeżeń konsoli.

- Data: 29 sierpnia 2026
- Produkcja: https://obokmnie-poznan-production.up.railway.app
- Repozytorium: https://github.com/usy-pawel/obokmnie-poznan
- Railway: projekt `obokmnie-poznan`, środowisko `production`
- Forma: statyczna strona publikowana z katalogu `public`

## Zakres

- 870 unikalnych spraw źródłowych z ostatnich 12 miesięcy,
- 833 dokładnie zlokalizowane sprawy opublikowane jako punkty,
- 1 887 opublikowanych geometrii działek,
- 163 identyfikatory działek bez odpowiedzi ULDK,
- 3 geometrie spoza kontrolnego obszaru Poznania wykryte i odrzucone,
- pliki mapy: łącznie około 3,25 MB.

## Zmierzony czas danych

```text
Pierwsze pobranie 1 815 identyfikatorów ULDK: 162,02 s
Uzupełnienie i ponowienie 208 identyfikatorów: 53,27 s
Ponowne zbudowanie z pełnego cache: 0,12 s
```

Pełne przygotowanie danych od zimnego cache zajmuje około 3–4 minut. Kolejna publikacja z istniejącym cache trwa poniżej sekundy plus czas pobrania wyłącznie nowych działek.

## Lokalne CI

Polecenia:

```powershell
npm install --package-lock-only --ignore-scripts
npm run check
git diff --check
```

Wynik końcowy:

```text
audited 1 package, 0 vulnerabilities
tests 6
pass 6
fail 0
git diff --check: bez uwag
```

Kontrole obejmują składnię JavaScript, liczbę i unikalność spraw, dokładność danych, typy i zakres geometrii, kompletność pól, spójność metryk oraz maksymalny rozmiar plików.

## Kontrola przeglądarkowa

- desktop: mapa, klastry, wyszukiwanie i wybór działki — zaliczone,
- mobile 390 × 844 px — zaliczone,
- filtr „Zgłoszenia” — 117 wyników,
- wyszukiwanie „Rostworowskiego” — 1 wynik i poprawna geometria,
- konsola świeżej sesji: 0 błędów, 0 ostrzeżeń.
