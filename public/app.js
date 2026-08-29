const CASES_URL = '/data/wielkopolska-cases.geojson';
const PARCEL_MANIFEST_URL = '/data/wielkopolska-parcel-manifest.json';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const ORTHO_TILE_URL = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';
const INITIAL_LIST_SIZE = 60;
const LIST_STEP = 60;

const state = {
  casesCollection: null,
  parcelManifest: null,
  cases: [],
  parcelsByCase: new Map(),
  parcelShardCache: new Map(),
  parcelShardPromises: new Map(),
  activeParcelShards: new Set(),
  parcelLoadGeneration: 0,
  filter: 'all',
  query: '',
  selectedCaseId: null,
  listLimit: INITIAL_LIST_SIZE,
  baseLayer: 'aerial',
  map: null,
  popup: null,
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

function formatDate(value) {
  return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${value}T12:00:00`));
}

function formatNumericDate(value) {
  return new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(`${value}T12:00:00`));
}

function shortTitle(value) {
  return value
    .replace(/^Pozwolenie na\s+/i, '')
    .replace(/^Zgłoszenie\s+/i, '')
    .replace(/^budowę\s+/i, 'Budowa ')
    .replace(/^budowe\s+/i, 'Budowa ')
    .replace(/^przebudowę\s+/i, 'Przebudowa ')
    .replace(/^przebudowe\s+/i, 'Przebudowa ');
}

function normalizeSearch(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pl-PL');
}

function geometryPoints(geometry) {
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

function filteredCases() {
  const query = normalizeSearch(state.query.trim());
  return state.cases.filter((item) => {
    if (state.filter !== 'all' && item.properties.source_type !== state.filter) return false;
    if (!query) return true;
    const haystack = normalizeSearch([
      item.properties.description,
      item.properties.address,
      item.properties.case_id,
      item.properties.status,
      item.properties.case_kind,
      ...(item.properties.parcel_ids || []),
    ].join(' '));
    return haystack.includes(query);
  });
}

function typeLabel(properties) {
  return properties.source_type === 'zgloszenie' ? 'Zgłoszenie' : 'Pozwolenie';
}

function resultLabel(count) {
  if (count === 1) return '1 wynik na mapie.';
  if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)) {
    return `${count} wyniki na mapie.`;
  }
  return `${count} wyników na mapie.`;
}

function renderCases() {
  const visible = filteredCases();
  const displayed = visible.slice(0, state.listLimit);
  ui.list.replaceChildren();
  ui.resultCount.textContent = visible.length.toLocaleString('pl-PL');
  ui.heroCount.textContent = state.cases.length.toLocaleString('pl-PL');
  ui.empty.hidden = visible.length !== 0;
  ui.loadMore.hidden = displayed.length >= visible.length;
  ui.listNote.textContent = visible.length > displayed.length
    ? `Pokazujemy ${displayed.length} z ${visible.length} wyników. Mapa zawiera wszystkie.`
    : resultLabel(visible.length);

  for (const feature of displayed) {
    const item = feature.properties;
    const fragment = ui.template.content.cloneNode(true);
    const card = fragment.querySelector('.case-card');
    const button = fragment.querySelector('.case-card-button');
    const details = fragment.querySelector('.case-details');
    card.dataset.caseId = item.case_id;
    card.classList.toggle('is-notice', item.source_type === 'zgloszenie');
    card.classList.toggle('is-selected', item.case_id === state.selectedCaseId);
    details.hidden = item.case_id !== state.selectedCaseId;
    fragment.querySelector('.case-type').textContent = typeLabel(item);
    fragment.querySelector('.case-date').textContent = formatDate(item.received_date);
    fragment.querySelector('.case-title').textContent = shortTitle(item.description);
    fragment.querySelector('.case-address').textContent = item.address;
    fragment.querySelector('.case-status').textContent = item.status;
    fragment.querySelector('.detail-id').textContent = item.case_id;
    fragment.querySelector('.detail-parcels').textContent = item.parcel_ids.join(', ');
    fragment.querySelector('.aerial-action').addEventListener('click', () => { void showCaseOnAerial(item.case_id); });
    button.setAttribute('aria-expanded', String(item.case_id === state.selectedCaseId));
    button.addEventListener('click', () => { void selectCase(item.case_id, true); });
    ui.list.append(fragment);
  }
}

function parcelFillOpacity() {
  return state.baseLayer === 'aerial'
    ? ['interpolate', ['linear'], ['zoom'], 13, 0.12, 16, 0.3]
    : ['interpolate', ['linear'], ['zoom'], 13, 0.18, 16, 0.58];
}

function setBaseLayer(layer) {
  state.baseLayer = layer;
  ui.baseLayerButtons.forEach((button) => {
    const active = button.dataset.baseLayer === layer;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (!state.map?.getLayer('ortho')) return;
  state.map.setLayoutProperty('ortho', 'visibility', layer === 'aerial' ? 'visible' : 'none');
  state.map.setPaintProperty('parcels-fill', 'fill-opacity', parcelFillOpacity());
}

async function showCaseOnAerial(caseId) {
  setBaseLayer('aerial');
  if (state.selectedCaseId !== caseId) state.selectedCaseId = caseId;
  renderCases();
  await focusSelectedCase(true, 70);
  document.querySelector('.map-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

function filteredCaseIds() {
  return new Set(filteredCases().map((feature) => feature.properties.case_id));
}

function refreshParcelSource() {
  if (!state.map?.getSource('parcels')) return;
  const visibleIds = filteredCaseIds();
  const features = [...state.activeParcelShards]
    .flatMap((shardId) => state.parcelShardCache.get(shardId)?.features || [])
    .filter((feature) => visibleIds.has(feature.properties.case_id));
  state.parcelsByCase = new Map();
  for (const feature of features) {
    const caseId = feature.properties.case_id;
    if (!state.parcelsByCase.has(caseId)) state.parcelsByCase.set(caseId, []);
    state.parcelsByCase.get(caseId).push(feature);
  }
  state.map.getSource('parcels').setData({ type: 'FeatureCollection', features });
  updateSelectedLayer();
}

async function loadParcelShard(shardId) {
  if (!shardId || state.parcelShardCache.has(shardId)) return;
  if (!state.parcelShardPromises.has(shardId)) {
    const info = state.parcelManifest.shards[shardId];
    if (!info) return;
    const request = fetch(info.url)
      .then((response) => {
        if (!response.ok) throw new Error(`Parcel shard ${shardId} failed`);
        return response.json();
      })
      .then((collection) => state.parcelShardCache.set(shardId, collection))
      .finally(() => state.parcelShardPromises.delete(shardId));
    state.parcelShardPromises.set(shardId, request);
  }
  await state.parcelShardPromises.get(shardId);
}

function intersectsMapBounds(shardBounds, mapBounds) {
  const [west, south, east, north] = shardBounds;
  return east >= mapBounds.getWest() && west <= mapBounds.getEast()
    && north >= mapBounds.getSouth() && south <= mapBounds.getNorth();
}

async function loadParcelShardsForView() {
  if (!state.map?.getSource('parcels') || !state.parcelManifest) return;
  const generation = ++state.parcelLoadGeneration;
  if (state.map.getZoom() < 11.5) {
    state.activeParcelShards.clear();
    refreshParcelSource();
    ui.zoomHint.textContent = 'Przybliż mapę, aby zobaczyć granice działek';
    return;
  }
  const mapBounds = state.map.getBounds();
  const shardIds = Object.entries(state.parcelManifest.shards)
    .filter(([, info]) => intersectsMapBounds(info.bounds, mapBounds))
    .map(([shardId]) => shardId);
  const selected = state.cases.find((feature) => feature.properties.case_id === state.selectedCaseId);
  if (selected?.properties.parcel_shard && !shardIds.includes(selected.properties.parcel_shard)) {
    shardIds.push(selected.properties.parcel_shard);
  }
  ui.zoomHint.textContent = 'Ładowanie granic działek…';
  try {
    await Promise.all(shardIds.map(loadParcelShard));
  } catch {
    if (generation === state.parcelLoadGeneration) ui.zoomHint.textContent = 'Nie udało się pobrać granic działek';
    return;
  }
  if (generation !== state.parcelLoadGeneration) return;
  state.activeParcelShards = new Set(shardIds);
  refreshParcelSource();
  ui.zoomHint.textContent = shardIds.length ? 'Granice działek są widoczne na mapie' : 'Brak spraw w tym obszarze';
}

function updateMapData() {
  if (!state.map?.getSource('cases')) return;
  const ids = filteredCaseIds();
  const cases = { ...state.casesCollection, features: state.casesCollection.features.filter((feature) => ids.has(feature.properties.case_id)) };
  state.map.getSource('cases').setData(cases);
  if (state.selectedCaseId && !cases.features.some((feature) => feature.properties.case_id === state.selectedCaseId)) {
    state.selectedCaseId = null;
  }
  refreshParcelSource();
}

function updateSelectedLayer() {
  if (!state.map?.getLayer('parcels-selected')) return;
  state.map.setFilter(
    'parcels-selected',
    state.selectedCaseId ? ['==', ['get', 'case_id'], state.selectedCaseId] : ['==', ['get', 'case_id'], ''],
  );
}

async function focusSelectedCase(moveMap, padding = 90) {
  const pointFeature = state.cases.find((feature) => feature.properties.case_id === state.selectedCaseId);
  if (!pointFeature) return;
  const shardId = pointFeature.properties.parcel_shard;
  ui.zoomHint.textContent = 'Ładowanie wybranej działki…';
  try {
    await loadParcelShard(shardId);
  } catch {
    ui.zoomHint.textContent = 'Nie udało się pobrać granicy działki';
    return;
  }
  state.activeParcelShards.add(shardId);
  refreshParcelSource();
  const parcelFeatures = state.parcelsByCase.get(state.selectedCaseId) || [];
  if (moveMap && state.map) {
    const bounds = boundsForFeatures(parcelFeatures.length ? parcelFeatures : [pointFeature]);
    if (bounds) state.map.fitBounds(bounds, { padding, maxZoom: 17, duration: 700 });
  }
  ui.zoomHint.textContent = 'Wybrana działka jest zaznaczona na mapie';
  updateSelectedLayer();
}

async function selectCase(caseId, moveMap = false) {
  state.selectedCaseId = state.selectedCaseId === caseId ? null : caseId;
  renderCases();
  updateSelectedLayer();
  if (!state.selectedCaseId) return;
  await focusSelectedCase(moveMap);
  requestAnimationFrame(() => {
    document.querySelector(`[data-case-id="${CSS.escape(state.selectedCaseId)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function popupForCase(caseId, lngLat) {
  const feature = state.cases.find((candidate) => candidate.properties.case_id === caseId);
  if (!feature) return;
  const item = feature.properties;
  const wrapper = document.createElement('div');
  const type = document.createElement('span');
  type.className = 'popup-type';
  type.textContent = typeLabel(item);
  const title = document.createElement('h3');
  title.className = 'popup-title';
  title.textContent = shortTitle(item.description);
  const address = document.createElement('p');
  address.className = 'popup-address';
  address.textContent = item.address;
  wrapper.append(type, title, address);
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ closeButton: false, offset: 12 })
    .setLngLat(lngLat)
    .setDOMContent(wrapper)
    .addTo(state.map);
}

function addMapLayers() {
  state.map.addSource('ortho', {
    type: 'raster',
    tiles: [ORTHO_TILE_URL],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 19,
    attribution: 'Ortofotomapa © Główny Urząd Geodezji i Kartografii',
  });
  state.map.addLayer({
    id: 'ortho',
    type: 'raster',
    source: 'ortho',
    layout: { visibility: state.baseLayer === 'aerial' ? 'visible' : 'none' },
    paint: { 'raster-fade-duration': 120 },
  });
  state.map.addSource('cases', {
    type: 'geojson',
    data: state.casesCollection,
    cluster: true,
    clusterMaxZoom: 12,
    clusterRadius: 46,
  });
  state.map.addSource('parcels', { type: 'geojson', data: emptyFeatureCollection() });

  state.map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'cases',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['step', ['get', 'point_count'], '#f3b841', 20, '#e88754', 60, '#d95f43'],
      'circle-radius': ['step', ['get', 'point_count'], 17, 20, 23, 60, 30],
      'circle-stroke-width': 3,
      'circle-stroke-color': '#fffdf8',
    },
  });
  state.map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'cases',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
    },
    paint: { 'text-color': '#152c2a' },
  });
  state.map.addLayer({
    id: 'case-points',
    type: 'circle',
    source: 'cases',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['match', ['get', 'source_type'], 'zgloszenie', '#347c6c', '#e26948'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 8],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fffdf8',
    },
  });
  state.map.addLayer({
    id: 'parcels-fill',
    type: 'fill',
    source: 'parcels',
    minzoom: 13,
    paint: {
      'fill-color': ['match', ['get', 'source_type'], 'zgloszenie', '#347c6c', '#e26948'],
      'fill-opacity': parcelFillOpacity(),
    },
  });
  state.map.addLayer({
    id: 'parcels-outline',
    type: 'line',
    source: 'parcels',
    minzoom: 13,
    paint: {
      'line-color': ['match', ['get', 'source_type'], 'zgloszenie', '#195649', '#9d3c28'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 17, 2.5],
      'line-opacity': 0.9,
    },
  });
  state.map.addLayer({
    id: 'parcels-selected',
    type: 'line',
    source: 'parcels',
    minzoom: 12,
    filter: ['==', ['get', 'case_id'], ''],
    paint: { 'line-color': '#f3b841', 'line-width': 5, 'line-blur': 0.3 },
  });
}

function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [16.7, 52.15],
    zoom: 7.1,
    minZoom: 6,
    maxZoom: 19,
    attributionControl: true,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  state.map.on('load', () => {
    addMapLayers();
    setBaseLayer(state.baseLayer);
    const bounds = boundsForFeatures(state.casesCollection.features);
    if (bounds) state.map.fitBounds(bounds, { padding: 45, maxZoom: 7.8, duration: 0 });
    ui.loading.classList.add('is-hidden');
  });
  state.map.on('moveend', () => { void loadParcelShardsForView(); });

  state.map.on('click', 'clusters', async (event) => {
    const feature = state.map.queryRenderedFeatures(event.point, { layers: ['clusters'] })[0];
    if (!feature) return;
    const zoom = await state.map.getSource('cases').getClusterExpansionZoom(feature.properties.cluster_id);
    state.map.easeTo({ center: feature.geometry.coordinates, zoom });
  });
  state.map.on('click', 'case-points', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    void selectCase(feature.properties.case_id);
    popupForCase(feature.properties.case_id, event.lngLat);
  });
  state.map.on('click', 'parcels-fill', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    void selectCase(feature.properties.case_id);
    popupForCase(feature.properties.case_id, event.lngLat);
  });
  for (const layer of ['clusters', 'case-points', 'parcels-fill']) {
    state.map.on('mouseenter', layer, () => { state.map.getCanvas().style.cursor = 'pointer'; });
    state.map.on('mouseleave', layer, () => { state.map.getCanvas().style.cursor = ''; });
  }
  state.map.on('error', (event) => {
    if (event.sourceId === 'ortho') return;
    if (!state.map.loaded()) {
      ui.loading.classList.add('is-error');
      ui.loading.querySelector('p').textContent = 'Nie udało się załadować mapy bazowej.';
    }
    console.error(event.error);
  });
}

async function start() {
  try {
    const [casesResponse, manifestResponse] = await Promise.all([fetch(CASES_URL), fetch(PARCEL_MANIFEST_URL)]);
    if (!casesResponse.ok || !manifestResponse.ok) throw new Error('Data request failed');
    state.casesCollection = await casesResponse.json();
    state.parcelManifest = await manifestResponse.json();
    if (state.casesCollection.analysis_period) {
      const { start: periodStart, end: periodEnd } = state.casesCollection.analysis_period;
      ui.dataRange.lastChild.textContent = `Dane: ${formatNumericDate(periodStart)}–${formatNumericDate(periodEnd)}`;
    }
    state.cases = [...state.casesCollection.features]
      .sort((a, b) => b.properties.received_date.localeCompare(a.properties.received_date));
    renderCases();
    initMap();
  } catch (error) {
    ui.loading.classList.add('is-error');
    ui.loading.querySelector('p').textContent = 'Nie udało się załadować danych.';
    console.error(error);
  }
}

for (const button of ui.filters) {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    state.listLimit = INITIAL_LIST_SIZE;
    ui.filters.forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
    renderCases();
    updateMapData();
  });
}

for (const button of ui.baseLayerButtons) {
  button.addEventListener('click', () => setBaseLayer(button.dataset.baseLayer));
}

let searchTimer;
ui.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = ui.search.value;
    state.listLimit = INITIAL_LIST_SIZE;
    renderCases();
    updateMapData();
  }, 180);
});

ui.loadMore.addEventListener('click', () => {
  state.listLimit += LIST_STEP;
  renderCases();
});

start();
