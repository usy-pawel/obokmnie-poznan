const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const ORTHO_TILE_URL = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';
const LIST_SIZE = 80;

const state = {
  map: null,
  features: [],
  filter: 'all',
  query: '',
  selectedCaseKey: null,
  selectedDetail: null,
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
  search: document.querySelector('#search-input'),
  searchWrap: document.querySelector('.search-wrap'),
  suggestions: document.querySelector('#search-suggestions'),
  loadMore: document.querySelector('#load-more'),
  listNote: document.querySelector('#list-note'),
  baseLayerButtons: [...document.querySelectorAll('[data-base-layer]')],
  zoomHint: document.querySelector('#zoom-hint'),
  dataRange: document.querySelector('#data-range'),
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
    const response = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`, {
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

function renderCases() {
  const cases = state.features.filter((feature) => !feature.properties.cluster);
  const selected = cases.find((feature) => caseKey(feature.properties) === state.selectedCaseKey);
  const ordered = selected ? [selected, ...cases.filter((feature) => feature !== selected)] : cases;
  const displayed = ordered.slice(0, state.listLimit);
  ui.list.replaceChildren();
  ui.resultCount.textContent = cases.length.toLocaleString('pl-PL');
  ui.empty.hidden = cases.length !== 0;
  ui.loadMore.hidden = displayed.length >= cases.length;

  if (state.map?.getZoom() < 10 && !state.query) {
    ui.listNote.textContent = 'Przybliż mapę lub wyszukaj miejsce, aby zobaczyć pojedyncze sprawy.';
  } else if (state.query) {
    ui.listNote.textContent = `Sprawy widoczne na mapie dla: „${state.query}”.`;
  } else {
    ui.listNote.textContent = 'Najnowsze sprawy w widocznym obszarze mapy.';
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
    card.classList.toggle('is-selected', selected);
    details.hidden = !selected;
    fragment.querySelector('.case-type').textContent = typeLabel(item);
    fragment.querySelector('.case-date').textContent = formatDate(item.received_date);
    const title = shortTitle(item.description) || 'Sprawa budowlana';
    fragment.querySelector('.case-title').textContent = title;
    fragment.querySelector('.case-title').title = title;
    fragment.querySelector('.case-address').textContent = item.address || item.city || item.voivodeship;
    fragment.querySelector('.case-status').textContent = item.status || 'brak statusu';
    fragment.querySelector('.detail-id').textContent = item.external_id || key;
    const resolvedParcelIds = detail?.parcels?.map((parcel) => parcel.parcel_id).filter(Boolean) || [];
    fragment.querySelector('.detail-parcels').textContent = detail
      ? resolvedParcelIds.join(', ') || (detail.parcel_ids || []).join(', ') || 'brak danych działki'
      : 'ładowanie…';
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
  state.requestController?.abort();
  state.requestController = new AbortController();
  const params = new URLSearchParams({
    bbox: currentBbox(),
    zoom: String(state.query ? 12 : state.map.getZoom()),
  });
  if (state.filter !== 'all') params.set('type', state.filter);
  if (state.query) params.set('q', state.query);
  ui.loading.classList.remove('is-hidden');
  try {
    const response = await fetch(`/api/map?${params}`, { signal: state.requestController.signal });
    if (!response.ok) throw new Error(`API ${response.status}`);
    setMapFeatures(await response.json());
    ui.zoomHint.textContent = state.map.getZoom() < 10 && !state.query
      ? 'Przybliż mapę, aby zobaczyć pojedyncze sprawy'
      : 'Kliknij punkt, aby zobaczyć działkę';
  } catch (error) {
    if (error.name !== 'AbortError') ui.listNote.textContent = 'Nie udało się pobrać danych. Spróbuj ponownie za chwilę.';
  } finally {
    ui.loading.classList.add('is-hidden');
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

async function selectCase(key, options = {}) {
  const { moveMap = false, showAerial = false, scrollToCard = false, toggle = true } = options;
  if (state.selectedCaseKey === key && state.selectedDetail && toggle) {
    state.selectedCaseKey = null;
    state.selectedDetail = null;
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
  renderCases();
  try {
    const response = await fetch(`/api/cases/${encodeURIComponent(key)}`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    state.selectedDetail = await response.json();
    const features = parcelFeatures(state.selectedDetail);
    if (!features.length) throw new Error('Brak geometrii działki');
    state.map.getSource('selected-parcels')?.setData({ type: 'FeatureCollection', features });
    renderCases();
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
    state.map.getSource('selected-parcels')?.setData(emptyCollection());
    renderCases();
    ui.listNote.textContent = 'Nie udało się pobrać szczegółów tej sprawy.';
  }
}

async function loadMeta() {
  const response = await fetch('/api/meta');
  if (!response.ok) throw new Error('Brak metadanych');
  const meta = await response.json();
  ui.heroCount.textContent = Number(meta.published_cases || 0).toLocaleString('pl-PL');
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
      paint: { 'circle-color': '#152c2a', 'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 15, 100, 24, 1000, 34], 'circle-stroke-color': '#fffdf8', 'circle-stroke-width': 2 },
    });
    state.map.addLayer({
      id: 'cluster-count', type: 'symbol', source: 'cases', filter: ['==', ['get', 'cluster'], true],
      layout: { 'text-field': ['to-string', ['get', 'count']], 'text-size': 12 }, paint: { 'text-color': '#ffffff' },
    });
    state.map.addLayer({
      id: 'case-points', type: 'circle', source: 'cases', filter: ['!=', ['get', 'cluster'], true],
      paint: { 'circle-color': ['match', ['get', 'source_type'], 'zgloszenie', '#347c6c', '#e26948'], 'circle-radius': 7, 'circle-stroke-color': '#fffdf8', 'circle-stroke-width': 2 },
    });
    state.map.addLayer({ id: 'selected-fill', type: 'fill', source: 'selected-parcels', paint: { 'fill-color': '#f3b841', 'fill-opacity': 0.34 } });
    state.map.addLayer({ id: 'selected-line', type: 'line', source: 'selected-parcels', paint: { 'line-color': '#152c2a', 'line-width': 3 } });
    setBaseLayer(state.baseLayer);
    state.map.on('click', 'case-clusters', (event) => state.map.easeTo({ center: event.features[0].geometry.coordinates, zoom: Math.min(state.map.getZoom() + 2, 12) }));
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

ui.search.addEventListener('input', () => {
  state.query = ui.search.value.trim();
  if (!state.query) state.lastFittedQuery = '';
  state.listLimit = LIST_SIZE;
  scheduleSuggestions(state.query);
  scheduleMapData(320);
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
