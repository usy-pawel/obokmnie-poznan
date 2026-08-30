const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const ORTHO_TILE_URL = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';
const LIST_SIZE = 80;
const RANGE_COPY = {
  '1y': 'ostatnich 12 miesięcy',
  '3y': 'ostatnich 3 lat',
  '5y': 'ostatnich 5 lat',
  all: 'całej historii od 2016 roku',
};

const state = {
  map: null,
  features: [],
  filter: 'all',
  range: '1y',
  query: '',
  region: null,
  selectedCaseKey: null,
  selectedDetail: null,
  selectedContext: null,
  listLimit: LIST_SIZE,
  baseLayer: 'streets',
  lastFittedQuery: '',
  requestController: null,
  requestTimer: null,
  suggestions: [],
  suggestionIndex: -1,
  suggestionController: null,
  suggestionTimer: null,
};

const ui = {
  list: document.querySelector('#cases-list'),
  empty: document.querySelector('#empty-state'),
  resultCount: document.querySelector('#result-count'),
  heroCount: document.querySelector('#hero-count'),
  loading: document.querySelector('#map-loading'),
  template: document.querySelector('#case-card-template'),
  filters: [...document.querySelectorAll('[data-filter]')],
  rangeButtons: [...document.querySelectorAll('[data-range]')],
  search: document.querySelector('#search-input'),
  searchWrap: document.querySelector('.search-wrap'),
  suggestions: document.querySelector('#search-suggestions'),
  loadMore: document.querySelector('#load-more'),
  listNote: document.querySelector('#list-note'),
  casesHeading: document.querySelector('#cases-heading'),
  casesEyebrow: document.querySelector('#cases-eyebrow'),
  countryReset: document.querySelector('#country-reset'),
  locationScope: document.querySelector('#location-scope'),
  baseLayerButtons: [...document.querySelectorAll('[data-base-layer]')],
  zoomHint: document.querySelector('#zoom-hint'),
  dataRange: document.querySelector('#data-range'),
  heroLead: document.querySelector('#hero-lead'),
};

function emptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

function formatDate(value) {
  if (!value) return 'brak daty';
  return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${String(value).slice(0, 10)}T12:00:00`));
}

function formatNumericDate(value) {
  return new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(`${String(value).slice(0, 10)}T12:00:00`));
}

function shortTitle(value = '') {
  return value
    .replace(/^Pozwolenie na\s+/i, '')
    .replace(/^Zgłoszenie\s+/i, '')
    .replace(/^budowę\s+/i, 'Budowa ')
    .replace(/^budowe\s+/i, 'Budowa ')
    .replace(/^przebudowę\s+/i, 'Przebudowa ')
    .replace(/^przebudowe\s+/i, 'Przebudowa ');
}

function typeLabel(properties) {
  return properties.source_type === 'zgloszenie' ? 'Zgłoszenie' : 'Pozwolenie';
}

function hideSuggestions() {
  state.suggestionIndex = -1;
  ui.suggestions.hidden = true;
  ui.search.setAttribute('aria-expanded', 'false');
  ui.search.removeAttribute('aria-activedescendant');
}

function chooseSuggestion(suggestion) {
  ui.search.value = suggestion.label;
  state.query = suggestion.label;
  state.lastFittedQuery = '';
  state.listLimit = LIST_SIZE;
  hideSuggestions();
  scheduleMapData(0);
}

function renderSuggestions() {
  ui.suggestions.replaceChildren();
  if (!state.suggestions.length) {
    hideSuggestions();
    return;
  }
  state.suggestions.forEach((suggestion, index) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'presentation');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-suggestion';
    button.id = `search-suggestion-${index}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === state.suggestionIndex));
    button.setAttribute('aria-label', `${suggestion.label}, ${suggestion.context}`);
    const label = document.createElement('strong');
    label.textContent = suggestion.label;
    const context = document.createElement('span');
    context.textContent = suggestion.context;
    button.append(label, context);
    button.addEventListener('click', () => chooseSuggestion(suggestion));
    item.append(button);
    ui.suggestions.append(item);
  });
  ui.suggestions.hidden = false;
  ui.search.setAttribute('aria-expanded', 'true');
  if (state.suggestionIndex >= 0) {
    ui.search.setAttribute('aria-activedescendant', `search-suggestion-${state.suggestionIndex}`);
  } else {
    ui.search.removeAttribute('aria-activedescendant');
  }
}

async function loadSuggestions(query) {
  state.suggestionController?.abort();
  if (query.length < 2) {
    state.suggestions = [];
    renderSuggestions();
    return;
  }
  state.suggestionController = new AbortController();
  try {
    const response = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}&range=${state.range}`, {
      signal: state.suggestionController.signal,
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    if (ui.search.value.trim() !== query) return;
    state.suggestions = await response.json();
    state.suggestionIndex = -1;
    renderSuggestions();
  } catch (error) {
    if (error.name !== 'AbortError') hideSuggestions();
  }
}

function scheduleSuggestions(query, delay = 160) {
  window.clearTimeout(state.suggestionTimer);
  state.suggestionTimer = window.setTimeout(() => { void loadSuggestions(query); }, delay);
}

function caseKey(properties) {
  return properties.case_key || properties.case_id;
}

function parcelFeatures(detail) {
  return (detail?.parcels || []).map((parcel) => ({
    type: 'Feature',
    geometry: parcel.geometry,
    properties: { parcel_id: parcel.parcel_id },
  }));
}

function geometryPoints(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'Polygon') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
}

function boundsForFeatures(features) {
  const points = features.flatMap((feature) => geometryPoints(feature.geometry));
  if (!points.length) return null;
  return points.reduce(
    (bounds, point) => bounds.extend(point),
    new maplibregl.LngLatBounds(points[0], points[0]),
  );
}

function zoomToCluster(feature) {
  const item = feature.properties || {};
  let clusterBounds = item.bounds;
  if (typeof clusterBounds === 'string') {
    try { clusterBounds = JSON.parse(clusterBounds); } catch { clusterBounds = null; }
  }
  if (item.cluster_scope === 'voivodeship' && Array.isArray(clusterBounds)) {
    state.region = item.region;
    ui.locationScope.textContent = item.label;
    ui.countryReset.setAttribute('aria-label', `${item.label}. Wróć do widoku całej Polski`);
    const camera = state.map.cameraForBounds(clusterBounds, { padding: window.innerWidth <= 620 ? 28 : 54 });
    state.map.easeTo({ center: camera.center, zoom: camera.zoom, duration: 800 });
    return;
  }
  if (Array.isArray(clusterBounds)) {
    const camera = state.map.cameraForBounds(clusterBounds, { padding: window.innerWidth <= 620 ? 34 : 64 });
    const minimumZoom = item.cluster_scope === 'area'
      ? 8.5
      : item.cluster_scope === 'powiat'
        ? 10.5
        : 14.2;
    state.map.easeTo({ center: camera.center, zoom: Math.max(camera.zoom, minimumZoom), duration: 700 });
    return;
  }
  state.map.easeTo({
    center: feature.geometry.coordinates,
    zoom: Math.max(state.map.getZoom() + 2, 10.2),
    duration: 650,
  });
}

function renderClusterChoices(features) {
  const scope = features[0]?.properties.cluster_scope;
  const copy = {
    area: ['Krok 2 z 4', ui.locationScope.textContent, 'Wybierz jeden z 8 obszarów województwa.'],
    powiat: ['Krok 3 z 4', 'Powiaty na mapie', 'Wybierz powiat, aby przejść bliżej spraw.'],
    local: ['Krok 4 z 4', 'Sprawy w okolicy', 'Wybierz grupę, aby zobaczyć pojedyncze sprawy.'],
  }[scope] || ['Potwierdzone lokalizacje', 'Sprawy na mapie', 'Wybierz grupę na mapie.'];
  ui.list.replaceChildren();
  ui.list.classList.remove('is-province-list');
  ui.list.classList.add('is-cluster-list');
  ui.casesEyebrow.textContent = copy[0];
  ui.casesHeading.textContent = copy[1];
  ui.resultCount.textContent = features.reduce((sum, feature) => sum + Number(feature.properties.count || 0), 0).toLocaleString('pl-PL');
  ui.listNote.textContent = `${copy[2]} Na mapie: ${features.length}.`;
  ui.empty.hidden = true;
  ui.loadMore.hidden = true;
  for (const feature of [...features].sort((a, b) => Number(b.properties.count) - Number(a.properties.count))) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cluster-card';
    button.setAttribute('aria-label', `${feature.properties.label}, ${Number(feature.properties.count).toLocaleString('pl-PL')} spraw`);
    const name = document.createElement('strong');
    name.textContent = feature.properties.label;
    const count = document.createElement('span');
    count.textContent = `${Number(feature.properties.count).toLocaleString('pl-PL')} spraw`;
    button.append(name, count);
    button.addEventListener('click', () => zoomToCluster(feature));
    ui.list.append(button);
  }
}

function renderProvinceChoices(features) {
  ui.list.replaceChildren();
  ui.list.classList.remove('is-cluster-list');
  ui.list.classList.add('is-province-list');
  ui.casesEyebrow.textContent = 'Cała Polska';
  ui.casesHeading.textContent = 'Wybierz województwo';
  ui.resultCount.textContent = features.length.toLocaleString('pl-PL');
  ui.listNote.textContent = 'Wybierz region na mapie lub z listy.';
  ui.empty.hidden = true;
  ui.loadMore.hidden = true;
  for (const feature of [...features].sort((a, b) => a.properties.label.localeCompare(b.properties.label, 'pl'))) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'province-card';
    button.setAttribute('aria-label', `${feature.properties.label}, ${Number(feature.properties.count).toLocaleString('pl-PL')} spraw`);
    const name = document.createElement('strong');
    name.textContent = feature.properties.label;
    const count = document.createElement('span');
    count.textContent = `${Number(feature.properties.count).toLocaleString('pl-PL')} spraw`;
    button.append(name, count);
    button.addEventListener('click', () => zoomToCluster(feature));
    ui.list.append(button);
  }
}

function appendTextItems(list, items) {
  list.replaceChildren();
  for (const text of items || []) {
    const item = document.createElement('li');
    item.textContent = text;
    list.append(item);
  }
}

function renderCaseContext(fragment, contextState) {
  const status = fragment.querySelector('.context-state');
  const content = fragment.querySelector('.context-content');
  if (!contextState || contextState.status === 'loading') {
    status.textContent = 'Analizuję oficjalne dane…';
    content.hidden = true;
    return;
  }
  if (contextState.status === 'error') {
    status.textContent = 'Kontekst jest chwilowo niedostępny.';
    content.hidden = true;
    return;
  }
  const context = contextState.data;
  status.textContent = context.generated_by === 'ai' ? 'Objaśnienie przygotowane na żądanie' : 'Podsumowanie danych urzędowych';
  content.hidden = false;
  fragment.querySelector('.context-summary').textContent = context.summary;
  appendTextItems(fragment.querySelector('.context-signals'), context.signals);
  appendTextItems(fragment.querySelector('.context-limitations ul'), context.limitations);
  fragment.querySelector('.context-disclaimer').textContent = context.generated_by === 'ai'
    ? 'AI objaśnia wyłącznie dane GUNB i historię spraw tej działki. Nie potwierdza realizacji inwestycji.'
    : 'Podsumowanie powstało bez AI na podstawie danych GUNB i historii spraw tej działki.';
}

function renderCases() {
  const cases = state.features.filter((feature) => !feature.properties.cluster);
  const clusters = state.features.filter((feature) => feature.properties.cluster);
  const provinces = clusters.filter((feature) => feature.properties.cluster_scope === 'voivodeship');
  if (provinces.length && !state.query) {
    renderProvinceChoices(provinces);
    return;
  }
  if (clusters.length && !cases.length && !state.query) {
    renderClusterChoices(clusters);
    return;
  }
  ui.list.classList.remove('is-province-list', 'is-cluster-list');
  ui.casesEyebrow.textContent = 'Potwierdzone lokalizacje';
  ui.casesHeading.textContent = 'Sprawy na mapie';
  const selected = cases.find((feature) => caseKey(feature.properties) === state.selectedCaseKey);
  const ordered = selected ? [selected, ...cases.filter((feature) => feature !== selected)] : cases;
  const displayed = ordered.slice(0, state.listLimit);
  ui.list.replaceChildren();
  const visibleCount = cases.length || clusters.reduce((sum, feature) => sum + Number(feature.properties.count || 0), 0);
  ui.resultCount.textContent = visibleCount.toLocaleString('pl-PL');
  ui.empty.hidden = cases.length !== 0 || clusters.length !== 0;
  ui.loadMore.hidden = displayed.length >= cases.length;

  if (clusters.length && !state.query) {
    ui.listNote.textContent = 'Kliknij grupę na mapie, aby zobaczyć pojedyncze sprawy.';
  } else if (state.query) {
    ui.listNote.textContent = `Sprawy widoczne na mapie dla: „${state.query}”.`;
  } else {
    ui.listNote.textContent = state.range === '1y'
      ? 'Najnowsze sprawy w widocznym obszarze mapy.'
      : 'Sprawy z wybranego okresu w widocznym obszarze mapy.';
  }

  for (const feature of displayed) {
    const item = feature.properties;
    const key = caseKey(item);
    const fragment = ui.template.content.cloneNode(true);
    const card = fragment.querySelector('.case-card');
    const button = fragment.querySelector('.case-card-button');
    const details = fragment.querySelector('.case-details');
    const selected = key === state.selectedCaseKey;
    const detail = selected ? state.selectedDetail : null;
    card.dataset.caseId = key;
    card.classList.toggle('is-notice', item.source_type === 'zgloszenie');
    card.classList.toggle('is-historical', Boolean(item.historical));
    card.classList.toggle('is-selected', selected);
    details.hidden = !selected;
    fragment.querySelector('.case-type').textContent = `${typeLabel(item)}${item.historical ? ' · historia' : ''}`;
    fragment.querySelector('.case-date').textContent = formatDate(item.received_date);
    const title = shortTitle(item.description) || 'Sprawa budowlana';
    fragment.querySelector('.case-title').textContent = title;
    fragment.querySelector('.case-title').title = title;
    fragment.querySelector('.case-address').textContent = item.address || item.city || item.voivodeship;
    fragment.querySelector('.case-status').textContent = item.status || 'brak statusu';
    fragment.querySelector('.detail-id').textContent = item.external_id || key;
    const decisionRow = fragment.querySelector('.detail-decision-row');
    decisionRow.hidden = !detail?.decision_date;
    fragment.querySelector('.detail-decision-date').textContent = detail?.decision_date ? formatDate(detail.decision_date) : '';
    fragment.querySelector('.detail-office').textContent = detail ? detail.office || 'brak danych' : 'ładowanie…';
    fragment.querySelector('.detail-kind').textContent = detail ? detail.case_kind || 'brak danych' : 'ładowanie…';
    const resolvedParcelIds = detail?.parcels?.map((parcel) => parcel.parcel_id).filter(Boolean) || [];
    fragment.querySelector('.detail-parcels').textContent = detail
      ? resolvedParcelIds.join(', ') || (detail.parcel_ids || []).join(', ') || 'brak danych działki'
      : 'ładowanie…';
    renderCaseContext(fragment, selected ? state.selectedContext : null);
    const aerialAction = fragment.querySelector('.aerial-action');
    aerialAction.hidden = Boolean(detail && !resolvedParcelIds.length);
    aerialAction.addEventListener('click', () => {
      void selectCase(key, { moveMap: true, showAerial: true, scrollToCard: true, toggle: false });
    });
    button.setAttribute('aria-expanded', String(selected));
    button.addEventListener('click', () => { void selectCase(key, { moveMap: true }); });
    ui.list.append(fragment);
  }
}

function setBaseLayer(layer) {
  state.baseLayer = layer;
  ui.baseLayerButtons.forEach((button) => {
    const active = button.dataset.baseLayer === layer;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (state.map?.getLayer('ortho')) {
    state.map.setLayoutProperty('ortho', 'visibility', layer === 'aerial' ? 'visible' : 'none');
  }
}

function setMapFeatures(collection) {
  state.features = (collection.features || []).filter((feature) => (
    feature.properties?.cluster || Number(feature.properties?.parcel_count || 0) > 0
  ));
  if (state.selectedCaseKey && !state.features.some((feature) => (
    !feature.properties.cluster && caseKey(feature.properties) === state.selectedCaseKey
  ))) {
    state.selectedCaseKey = null;
    state.selectedDetail = null;
    state.selectedContext = null;
    state.map?.getSource('selected-parcels')?.setData(emptyCollection());
  }
  const safeCollection = { type: 'FeatureCollection', features: state.features };
  state.map?.getSource('cases')?.setData(safeCollection);
  renderCases();
  if (state.query && state.lastFittedQuery !== state.query) {
    state.lastFittedQuery = state.query;
    const points = state.features.filter((feature) => !feature.properties.cluster);
    const bounds = boundsForFeatures(points);
    if (bounds) state.map.fitBounds(bounds, { padding: 70, maxZoom: 13, duration: 700 });
  }
}

function currentBbox() {
  const bounds = state.map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
}

async function loadMapData() {
  if (!state.map?.getSource('cases')) return;
  if (state.map.getZoom() < 5.6 && !state.query && state.region) {
    state.region = null;
    ui.locationScope.textContent = 'Cała Polska';
    ui.countryReset.setAttribute('aria-label', 'Cała Polska');
  }
  state.requestController?.abort();
  const controller = new AbortController();
  state.requestController = controller;
  const params = new URLSearchParams({
    bbox: currentBbox(),
    zoom: String(state.query ? 12 : state.map.getZoom()),
  });
  if (state.filter !== 'all') params.set('type', state.filter);
  if (state.query) params.set('q', state.query);
  if (state.region) params.set('region', state.region);
  params.set('range', state.range);
  ui.loading.classList.remove('is-hidden');
  ui.loading.setAttribute('aria-hidden', 'false');
  try {
    const response = await fetch(`/api/map?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`API ${response.status}`);
    setMapFeatures(await response.json());
    ui.zoomHint.textContent = state.map.getZoom() < 14 && !state.query
      ? 'Przybliż mapę, aby zobaczyć pojedyncze sprawy'
      : 'Kliknij punkt, aby zobaczyć działkę';
  } catch (error) {
    if (error.name !== 'AbortError') ui.listNote.textContent = 'Nie udało się pobrać danych. Spróbuj ponownie za chwilę.';
  } finally {
    if (state.requestController === controller) {
      ui.loading.classList.add('is-hidden');
      ui.loading.setAttribute('aria-hidden', 'true');
    }
  }
}

function scheduleMapData(delay = 180) {
  window.clearTimeout(state.requestTimer);
  state.requestTimer = window.setTimeout(() => { void loadMapData(); }, delay);
}

function scrollSelectedCard() {
  window.requestAnimationFrame(() => {
    const card = [...document.querySelectorAll('.case-card')]
      .find((element) => element.dataset.caseId === state.selectedCaseKey);
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card?.querySelector('.case-card-button')?.focus({ preventScroll: true });
  });
}

async function loadCaseContext(key) {
  try {
    const response = await fetch(`/api/cases/${encodeURIComponent(key)}/context`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    const context = await response.json();
    if (state.selectedCaseKey !== key) return;
    state.selectedContext = { status: 'ready', data: context };
    renderCases();
  } catch {
    if (state.selectedCaseKey !== key) return;
    state.selectedContext = { status: 'error' };
    renderCases();
  }
}

async function selectCase(key, options = {}) {
  const { moveMap = false, showAerial = false, scrollToCard = false, toggle = true } = options;
  if (state.selectedCaseKey === key && state.selectedDetail && toggle) {
    state.selectedCaseKey = null;
    state.selectedDetail = null;
    state.selectedContext = null;
    state.map.getSource('selected-parcels')?.setData(emptyCollection());
    renderCases();
    return;
  }
  if (state.selectedCaseKey === key && state.selectedDetail) {
    if (showAerial) setBaseLayer('aerial');
    if (moveMap) {
      const features = parcelFeatures(state.selectedDetail);
      const bounds = boundsForFeatures(features);
      if (bounds) state.map.fitBounds(bounds, { padding: 70, maxZoom: 17, duration: 800 });
    }
    if (scrollToCard) scrollSelectedCard();
    return;
  }
  state.selectedCaseKey = key;
  state.selectedDetail = null;
  state.selectedContext = null;
  renderCases();
  try {
    const response = await fetch(`/api/cases/${encodeURIComponent(key)}`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    state.selectedDetail = await response.json();
    state.selectedContext = { status: 'loading' };
    const features = parcelFeatures(state.selectedDetail);
    if (!features.length) throw new Error('Brak geometrii działki');
    state.map.getSource('selected-parcels')?.setData({ type: 'FeatureCollection', features });
    renderCases();
    void loadCaseContext(key);
    if (moveMap) {
      if (showAerial) setBaseLayer('aerial');
      const bounds = boundsForFeatures(features);
      if (bounds) state.map.fitBounds(bounds, { padding: 70, maxZoom: 17, duration: 800 });
      else if (state.selectedDetail.location) state.map.flyTo({ center: state.selectedDetail.location.coordinates, zoom: 16 });
    }
    if (scrollToCard) scrollSelectedCard();
  } catch {
    state.selectedCaseKey = null;
    state.selectedDetail = null;
    state.selectedContext = null;
    state.map.getSource('selected-parcels')?.setData(emptyCollection());
    renderCases();
    ui.listNote.textContent = 'Nie udało się pobrać szczegółów tej sprawy.';
  }
}

async function loadMeta() {
  const response = await fetch(`/api/meta?range=${state.range}`);
  if (!response.ok) throw new Error('Brak metadanych');
  const meta = await response.json();
  ui.heroCount.textContent = Number(meta.published_cases || 0).toLocaleString('pl-PL');
  ui.heroLead.textContent = `Sprawdź sprawy budowlane z ${RANGE_COPY[state.range]}. Przybliż mapę, aby zobaczyć dokładne granice działek, albo wyszukaj ulicę, inwestycję czy numer sprawy.`;
  if (meta.period_start && meta.period_end) {
    ui.dataRange.innerHTML = `<span></span>Dane: ${formatNumericDate(meta.period_start)}–${formatNumericDate(meta.period_end)}`;
  }
}

function initializeMap() {
  state.map = new maplibregl.Map({
    container: 'map', style: MAP_STYLE, center: [19.15, 52.1], zoom: 5.35, minZoom: 5, maxZoom: 19,
    maxBounds: [[13.3, 48.2], [25, 55.8]], attributionControl: false,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  state.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  let layersInitializing = false;
  const setupLayers = () => {
    if (state.map.getSource('cases')) return;
    if (layersInitializing) return;
    const styleLayers = state.map.getStyle()?.layers;
    if (!styleLayers?.length) return;
    layersInitializing = true;
    const firstSymbol = styleLayers.find((layer) => layer.type === 'symbol')?.id;
    state.map.addSource('ortho', { type: 'raster', tiles: [ORTHO_TILE_URL], tileSize: 256, attribution: 'Ortofotomapa: GUGiK' });
    state.map.addLayer({ id: 'ortho', type: 'raster', source: 'ortho', paint: { 'raster-opacity': 0.94 } }, firstSymbol);
    state.map.addSource('cases', { type: 'geojson', data: emptyCollection() });
    state.map.addSource('selected-parcels', { type: 'geojson', data: emptyCollection() });
    state.map.addLayer({
      id: 'case-clusters', type: 'circle', source: 'cases', filter: ['==', ['get', 'cluster'], true],
      paint: {
        'circle-color': ['match', ['get', 'cluster_scope'], 'voivodeship', '#fffdf8', 'area', '#f3b841', 'local', '#347c6c', '#152c2a'],
        'circle-radius': ['match', ['get', 'cluster_scope'], 'voivodeship', 22, 'area', 23, 'powiat', 19, 17],
        'circle-stroke-color': ['match', ['get', 'cluster_scope'], 'voivodeship', '#152c2a', '#fffdf8'],
        'circle-stroke-width': 2,
      },
    });
    state.map.addLayer({
      id: 'cluster-count', type: 'symbol', source: 'cases', filter: ['==', ['get', 'cluster'], true],
      layout: { 'text-field': ['to-string', ['get', 'count']], 'text-size': ['match', ['get', 'cluster_scope'], 'voivodeship', 9, 'area', 11, 10] },
      paint: { 'text-color': ['match', ['get', 'cluster_scope'], 'voivodeship', '#152c2a', 'area', '#152c2a', '#ffffff'] },
    });
    state.map.addLayer({
      id: 'province-labels', type: 'symbol', source: 'cases',
      filter: ['==', ['get', 'cluster_scope'], 'voivodeship'],
      layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 3], 'text-anchor': 'top', 'text-max-width': 11 },
      paint: { 'text-color': '#152c2a', 'text-halo-color': '#fffdf8', 'text-halo-width': 2 },
    });
    state.map.addLayer({
      id: 'case-points', type: 'circle', source: 'cases', filter: ['!=', ['get', 'cluster'], true],
      paint: {
        'circle-color': ['match', ['get', 'source_type'], 'zgloszenie', '#347c6c', '#e26948'],
        'circle-opacity': ['case', ['boolean', ['get', 'historical'], false], 0.48, 1],
        'circle-radius': ['case', ['boolean', ['get', 'historical'], false], 5, 7],
        'circle-stroke-color': '#fffdf8',
        'circle-stroke-width': 2,
      },
    });
    state.map.addLayer({ id: 'selected-fill', type: 'fill', source: 'selected-parcels', paint: { 'fill-color': '#f3b841', 'fill-opacity': 0.34 } });
    state.map.addLayer({ id: 'selected-line', type: 'line', source: 'selected-parcels', paint: { 'line-color': '#152c2a', 'line-width': 3 } });
    setBaseLayer(state.baseLayer);
    state.map.on('click', 'case-clusters', (event) => zoomToCluster(event.features[0]));
    state.map.on('click', 'case-points', (event) => {
      void selectCase(caseKey(event.features[0].properties), {
        moveMap: true, scrollToCard: true, toggle: false,
      });
    });
    for (const layer of ['case-clusters', 'case-points']) {
      state.map.on('mouseenter', layer, () => { state.map.getCanvas().style.cursor = 'pointer'; });
      state.map.on('mouseleave', layer, () => { state.map.getCanvas().style.cursor = ''; });
    }
    state.map.on('moveend', () => scheduleMapData());
    void loadMapData();
    layersInitializing = false;
  };
  const waitForLayers = () => {
    setupLayers();
    if (!state.map.getSource('cases')) window.setTimeout(waitForLayers, 250);
  };
  state.map.on('load', setupLayers);
  state.map.on('styledata', setupLayers);
  window.setTimeout(waitForLayers, 0);
}

ui.filters.forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  state.listLimit = LIST_SIZE;
  ui.filters.forEach((item) => item.classList.toggle('is-active', item === button));
  scheduleMapData(0);
}));

ui.rangeButtons.forEach((button) => button.addEventListener('click', () => {
  state.range = button.dataset.range;
  state.lastFittedQuery = '';
  state.listLimit = LIST_SIZE;
  ui.rangeButtons.forEach((item) => {
    const active = item === button;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  void loadMeta();
  scheduleMapData(0);
}));

ui.search.addEventListener('input', () => {
  state.query = ui.search.value.trim();
  state.region = null;
  ui.locationScope.textContent = 'Cała Polska';
  ui.countryReset.setAttribute('aria-label', 'Cała Polska');
  if (!state.query) state.lastFittedQuery = '';
  state.listLimit = LIST_SIZE;
  scheduleSuggestions(state.query);
  scheduleMapData(320);
});

ui.countryReset.addEventListener('click', () => {
  state.region = null;
  ui.locationScope.textContent = 'Cała Polska';
  ui.countryReset.setAttribute('aria-label', 'Cała Polska');
  state.map.easeTo({ center: [19.15, 52.1], zoom: 5.35, duration: 700 });
});

ui.search.addEventListener('focus', () => {
  if (ui.search.value.trim().length >= 2) scheduleSuggestions(ui.search.value.trim(), 0);
});

ui.search.addEventListener('keydown', (event) => {
  if (!state.suggestions.length || ui.suggestions.hidden) {
    if (event.key === 'Escape') hideSuggestions();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    state.suggestionIndex = (state.suggestionIndex + direction + state.suggestions.length)
      % state.suggestions.length;
    renderSuggestions();
  } else if (event.key === 'Enter' && state.suggestionIndex >= 0) {
    event.preventDefault();
    chooseSuggestion(state.suggestions[state.suggestionIndex]);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    hideSuggestions();
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!ui.searchWrap.contains(event.target)) hideSuggestions();
});

ui.loadMore.addEventListener('click', () => {
  state.listLimit += LIST_SIZE;
  renderCases();
});

ui.baseLayerButtons.forEach((button) => button.addEventListener('click', () => setBaseLayer(button.dataset.baseLayer)));

initializeMap();
loadMeta().catch(() => { ui.heroCount.textContent = '—'; });
