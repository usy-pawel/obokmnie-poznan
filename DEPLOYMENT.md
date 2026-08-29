# Podsumowanie wdrożenia — Wielkopolska

- Data: 29 sierpnia 2026
- Produkcja: https://obokmnie-poznan-production.up.railway.app
- Repozytorium: https://github.com/usy-pawel/obokmnie-poznan
- Railway: projekt `obokmnie-poznan`, środowisko `production`
- Forma: statyczna strona publikowana z katalogu `public`

## Zakres danych

- okres analizy: 24 sierpnia 2025 – 24 sierpnia 2026,
- 39 591 rekordów źródłowych z rejestrów GUNB,
- 19 272 unikalne sprawy źródłowe,
- 14 980 spraw z co najmniej jedną dokładnie potwierdzoną geometrią,
- 29 503 opublikowane powiązania spraw z geometriami działek,
- 4 292 sprawy bez dokładnej geometrii nie są publikowane,
- 5 geometrii poza obszarem kontrolnym zostało odrzuconych.

Mapa używa 85 przestrzennych fragmentów GeoJSON. Granice działek są pobierane dopiero po przybliżeniu lub wybraniu sprawy. Największy fragment ma 2 390 581 bajtów, a plik punktów spraw 10 795 497 bajtów.

## Zdjęcia lotnicze

Domyślnym podkładem jest bezpłatna ortofotomapa WMTS GUGiK. Przełącznik „Mapa / Zdjęcie” działa na desktopie i urządzeniach mobilnych, a wybrana działka jest wyróżniana na zdjęciu.

## Lokalne CI

Polecenia:

```powershell
npm install --package-lock-only --ignore-scripts
npm run check
git diff --check
```

Wynik:

```text
audited 1 package, 0 vulnerabilities
tests 6
pass 6
fail 0
git diff --check: bez uwag
```

Kontrole obejmują składnię JavaScript, skalę i unikalność spraw, typy i zakres geometrii, kompletność pól, spójność manifestu i metryk oraz limity rozmiaru plików.

## Kontrola przeglądarkowa

- pełny widok: 14 980 spraw, wyszukiwanie „Kalisz” — 16 wyników,
- wybór wyniku ładuje właściwy fragment działek i zaznacza geometrię,
- przełącznik ortofotomapy działa,
- mobile 390 × 844 px: mapa i wyszukiwarka są widoczne, bez poziomego przepełnienia,
- konsola: 0 błędów i 0 ostrzeżeń.

## Czas budowy

- pierwsze uzupełnienie 4 157 brakujących identyfikatorów i publikacja: 1 375,72 s,
- przebudowanie z pełnego cache: 34,35 s.

AI nie wybiera lokalizacji ani granic działek. Dopasowanie jest deterministyczne i oparte na identyfikatorach działek oraz oficjalnej usłudze ULDK.
