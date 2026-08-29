# Podsumowanie wdrożenia

- Data: 29 sierpnia 2026
- Produkcja: https://obokmnie-strzeszyn-production.up.railway.app
- Repozytorium: https://github.com/usy-pawel/obokmnie-strzeszyn
- Railway: projekt `obokmnie-strzeszyn`, środowisko `production`
- Forma: statyczna strona publikowana z katalogu `public`

## Lokalne CI

Polecenie:

```powershell
npm run check
```

Wynik końcowy:

```text
tests 3
pass 3
fail 0
duration_ms 107.6229
```

Kontrole obejmują poprawność składni JavaScript, liczbę geometrii i spraw, typ geometrii, źródło ULDK, kompletność pól publicznych oraz położenie wszystkich punktów w kontrolnym zakresie Strzeszyna.

## Kontrola produkcyjna

```text
GET /                                      -> 200
GET /data/strzeszyn-parcels.geojson        -> 200
strona zawiera „Co budują na Strzeszynie?” -> tak
```

Przeprowadzono także kontrolę wizualną w przeglądarce dla widoku desktopowego i mobilnego oraz test filtra „Zgłoszenia”. Konsola przeglądarki: 0 błędów, 0 ostrzeżeń.
