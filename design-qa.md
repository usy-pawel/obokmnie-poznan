# Design QA — pełny tytuł i podpowiedzi wyszukiwania

## Evidence

- Source visual truth: `C:\Users\Lenovo\Documents\Codex\2026-08-29\na-x20\.codex-remote-attachments\01a04de2-38ec-7de0-a360-756c642e168a\02b0ebed-0627-4ad6-801b-0198066c34ed\1-Photo-1.jpg`
- Implementation screenshot: `C:\Users\Lenovo\Documents\Codex\2026-08-29\na-x20\outputs\podpowiedzi-i-pelny-tytul\po-poprawce-mobile.png`
- Suggestions screenshot: `C:\Users\Lenovo\Documents\Codex\2026-08-29\na-x20\outputs\podpowiedzi-i-pelny-tytul\podpowiedzi-mobile.png`
- Source pixels: 576 × 1280, browser chrome included, density unknown.
- Implementation: 390 × 844 CSS px at device scale factor 1; screenshot 390 × 844 px.
- State: case `ST-WK-PZ/WNIOSEK/5821/2026` selected and expanded; separate `poz` suggestion state.
- Normalization: compared the app-owned selected-card region rather than browser chrome. The street-map base layer is intentional and follows the existing product requirement; the source screenshot used aerial imagery.

## Findings

- No remaining P0/P1/P2 findings.
- Typography: the selected title keeps the existing Georgia hierarchy and now wraps to its full height without ellipsis. Collapsed cards retain the two-line clamp.
- Spacing and layout: the longer title increases only the selected card height; card padding, detail divider, status and controls retain the existing rhythm. The 390 px viewport has no horizontal overflow.
- Colors and tokens: existing surface, ink, selected border and status tokens are unchanged. Suggestions reuse the current surface, line and focus colors.
- Image quality: map tiles and parcel geometry remain native map assets; no new raster or substitute assets were introduced.
- Copy and content: the full official description is visible after expansion. Suggestions expose only a place name and province context, capped at seven items.
- Accessibility: suggestions use a combobox/listbox relationship, `aria-expanded`, `aria-activedescendant`, option selection state, Arrow Up/Down, Enter and Escape. No browser console errors were present.

## Comparison history

1. Initial source finding — P1: the expanded card still used the collapsed two-line clamp and hid most of the official title.
   - Fix: scope the line clamp to collapsed cards and restore normal block flow for `.case-card.is-selected .case-title`.
   - Post-fix evidence: selected title measured `scrollHeight === clientHeight` (216 px), `overflow: visible`, and no line clamp.
2. First post-fix comparison — P2: the card showed 24 March while the source showed 25 March because PostgreSQL `date` values were serialized through UTC.
   - Fix: serialize API dates explicitly as `YYYY-MM-DD` using `to_char` before client formatting.
   - Post-fix evidence: the same case now renders `25 mar 2026`.

## Primary interactions tested

- Type `poz` and receive seven non-granular place suggestions.
- Select Poznań with Arrow Down + Enter; the map returns 796 results.
- Search the exact GUNB number and open the matching card.
- Confirm the complete title is visible after expansion.
- Confirm 390 px mobile layout has no horizontal overflow and no console errors.

## Follow-up polish

- P3: optionally highlight the matching prefix inside each suggestion if users need faster scanning after usage data is available.

final result: passed
