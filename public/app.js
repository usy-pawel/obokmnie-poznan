const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const ORTHO_TILE_URL = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';
const POLAND_BOUNDS = [14.0, 48.8, 24.3, 55.3];
const LIST_SIZE = 80;

const state = {
  map: null,
  features: [],
  filter: 'all',
  query: '',
  selectedCaseKey: null,
  selectedDetail: null,
  listLimit: LIST_SIZE,
  baseLayer: 'aerial',
  requestController: null,
  requestTimer: null,
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
  const displayed = cases.slice(0, state.listLimit);
  ui.list.replaceChildren();
  ui.resultCount.textContent = cases.length.toLocaleString('pl-PL');
  ui.empty.hidden = cases.length !== 0;
  ui.loadMore.hidden = displayed.length >= cases.length;

  if (state.map?.getZoom() < 10 && !state.query) {
    ui.listNote.textContent = 'Przybliż mapę lub wyszukaj miejsce, aby zobaczyć pojedyncze sprawy.';
  } else if (state.query) {
    ui.listNote.textContent = `Wyniki dla: „${state.query}”.`;
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
    fragment.querySelector('.case-title').textContent = shortTitle(item.description) || 'Sprawa budowlana';
    fragment.querySelector('.case-address').textContent = item.address || item.city || item.voivodeship;
    fragment.querySelector('.case-status').textContent = item.status || 'brak statusu';
    fragment.querySelector('.detail-id').textContent = item.external_id || key;
    fragment.querySelector('.detail-parcels').textContent = detail
      ? (detail.parcel_ids || []).join(', ') || 'brak numeru'
      : 'ładowanie…';
    fragment.querySelector('.aerial-action').addEventListener('click', () => { void selectCase(key, true); });
    button.setAttribute('aria-expanded', String(selected));
    button.addEventListener('click', () => { void selectCase(key, true); });
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
  state.features = collection.features || [];
  state.map?.getSource('cases')?.setData(collection);
  renderCases();
}

function currentBbox() {
  if (state.query) return POLAND_BOUNDS.join(',');
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

async function selectCase(key, moveMap = false) {
  if (state.selectedCaseKey === key && state.selectedDetail) {
    state.selectedCaseKey = null;
    state.selectedDetail = null;
    state.map.getSource('selected-parcels')?.setData(emptyCollection());
    renderCases();
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
    state.map.getSource('selected-parcels')?.setData({ type: 'FeatureCollection', features });
    renderCases();
    if (moveMap) {
      setBaseLayer('aerial');
      const bounds = boundsForFeatures(features);
      if (bounds) state.map.fitBounds(bounds, { padding: 70, maxZoom: 17, duration: 800 });
      else if (state.selectedDetail.location) state.map.flyTo({ center: state.selectedDetail.location.coordinates, zoom: 16 });
      document.querySelector('.map-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch {
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

  const setupLayers = () => {
    if (state.map.getSource('cases')) return;
    const styleLayers = state.map.getStyle()?.layers;
    if (!styleLayers?.length) return;
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
    state.map.on('click', 'case-points', (event) => { void selectCase(caseKey(event.features[0].properties), true); });
    for (const layer of ['case-clusters', 'case-points']) {
      state.map.on('mouseenter', layer, () => { state.map.getCanvas().style.cursor = 'pointer'; });
      state.map.on('mouseleave', layer, () => { state.map.getCanvas().style.cursor = ''; });
    }
    state.map.on('moveend', () => scheduleMapData());
    void loadMapData();
  };
  state.map.on('styledata', setupLayers);
  window.setTimeout(setupLayers, 250);
}

ui.filters.forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  state.listLimit = LIST_SIZE;
  ui.filters.forEach((item) => item.classList.toggle('is-active', item === button));
  scheduleMapData(0);
}));

ui.search.addEventListener('input', () => {
  state.query = ui.search.value.trim();
  state.listLimit = LIST_SIZE;
  scheduleMapData(320);
});

ui.loadMore.addEventListener('click', () => {
  state.listLimit += LIST_SIZE;
  renderCases();
});

ui.baseLayerButtons.forEach((button) => button.addEventListener('click', () => setBaseLayer(button.dataset.baseLayer)));

initializeMap();
loadMeta().catch(() => { ui.heroCount.textContent = '—'; });
