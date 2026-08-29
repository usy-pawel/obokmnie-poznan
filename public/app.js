const CASES_URL = '/data/poznan-cases.geojson';
const PARCELS_URL = '/data/poznan-parcels.geojson';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const ORTHO_TILE_URL = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';
const INITIAL_LIST_SIZE = 60;
const LIST_STEP = 60;

const state = {
  casesCollection: null,
  parcelsCollection: null,
  cases: [],
  parcelsByCase: new Map(),
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
};

function formatDate(value) {
  return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })
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
  ui.resultCount.textContent = String(visible.length);
  ui.heroCount.textContent = String(state.cases.length);
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
    fragment.querySelector('.aerial-action').addEventListener('click', () => showCaseOnAerial(item.case_id));
    button.setAttribute('aria-expanded', String(item.case_id === state.selectedCaseId));
    button.addEventListener('click', () => selectCase(item.case_id, true));
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

function showCaseOnAerial(caseId) {
  state.selectedCaseId = caseId;
  setBaseLayer('aerial');
  updateSelectedLayer();
  const parcelFeatures = state.parcelsByCase.get(caseId) || [];
  const pointFeature = state.cases.find((feature) => feature.properties.case_id === caseId);
  const bounds = boundsForFeatures(parcelFeatures.length ? parcelFeatures : [pointFeature]);
  if (bounds && state.map) state.map.fitBounds(bounds, { padding: 70, maxZoom: 17, duration: 650 });
  document.querySelector('.map-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function filteredCollections() {
  const ids = new Set(filteredCases().map((feature) => feature.properties.case_id));
  return {
    cases: { ...state.casesCollection, features: state.casesCollection.features.filter((feature) => ids.has(feature.properties.case_id)) },
    parcels: { ...state.parcelsCollection, features: state.parcelsCollection.features.filter((feature) => ids.has(feature.properties.case_id)) },
  };
}

function updateMapData() {
  if (!state.map?.getSource('cases')) return;
  const collections = filteredCollections();
  state.map.getSource('cases').setData(collections.cases);
  state.map.getSource('parcels').setData(collections.parcels);
  if (state.selectedCaseId && !collections.cases.features.some((feature) => feature.properties.case_id === state.selectedCaseId)) {
    state.selectedCaseId = null;
  }
  updateSelectedLayer();
}

function updateSelectedLayer() {
  if (!state.map?.getLayer('parcels-selected')) return;
  state.map.setFilter(
    'parcels-selected',
    state.selectedCaseId ? ['==', ['get', 'case_id'], state.selectedCaseId] : ['==', ['get', 'case_id'], ''],
  );
}

function selectCase(caseId, moveMap = false) {
  state.selectedCaseId = state.selectedCaseId === caseId ? null : caseId;
  renderCases();
  updateSelectedLayer();
  if (!state.selectedCaseId) return;

  const parcelFeatures = state.parcelsByCase.get(state.selectedCaseId) || [];
  const pointFeature = state.cases.find((feature) => feature.properties.case_id === state.selectedCaseId);
  if (moveMap && state.map) {
    const bounds = boundsForFeatures(parcelFeatures.length ? parcelFeatures : [pointFeature]);
    if (bounds) state.map.fitBounds(bounds, { padding: 90, maxZoom: 16.5, duration: 700 });
  }
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
    clusterMaxZoom: 13,
    clusterRadius: 46,
  });
  state.map.addSource('parcels', { type: 'geojson', data: state.parcelsCollection });

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
    center: [16.925, 52.405],
    zoom: 10.7,
    minZoom: 9,
    maxZoom: 19,
    attributionControl: true,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  state.map.on('load', () => {
    addMapLayers();
    setBaseLayer(state.baseLayer);
    const bounds = boundsForFeatures(state.casesCollection.features);
    if (bounds) state.map.fitBounds(bounds, { padding: 50, maxZoom: 11.4, duration: 0 });
    ui.loading.classList.add('is-hidden');
  });

  state.map.on('click', 'clusters', async (event) => {
    const feature = state.map.queryRenderedFeatures(event.point, { layers: ['clusters'] })[0];
    if (!feature) return;
    const zoom = await state.map.getSource('cases').getClusterExpansionZoom(feature.properties.cluster_id);
    state.map.easeTo({ center: feature.geometry.coordinates, zoom });
  });
  state.map.on('click', 'case-points', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    selectCase(feature.properties.case_id);
    popupForCase(feature.properties.case_id, event.lngLat);
  });
  state.map.on('click', 'parcels-fill', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    selectCase(feature.properties.case_id);
    popupForCase(feature.properties.case_id, event.lngLat);
  });
  for (const layer of ['clusters', 'case-points', 'parcels-fill']) {
    state.map.on('mouseenter', layer, () => { state.map.getCanvas().style.cursor = 'pointer'; });
    state.map.on('mouseleave', layer, () => { state.map.getCanvas().style.cursor = ''; });
  }
  state.map.on('error', (event) => {
    if (!state.map.loaded()) {
      ui.loading.classList.add('is-error');
      ui.loading.querySelector('p').textContent = 'Nie udało się załadować mapy bazowej.';
    }
    console.error(event.error);
  });
}

async function start() {
  try {
    const [casesResponse, parcelsResponse] = await Promise.all([fetch(CASES_URL), fetch(PARCELS_URL)]);
    if (!casesResponse.ok || !parcelsResponse.ok) throw new Error('Data request failed');
    state.casesCollection = await casesResponse.json();
    state.parcelsCollection = await parcelsResponse.json();
    state.cases = [...state.casesCollection.features]
      .sort((a, b) => b.properties.received_date.localeCompare(a.properties.received_date));
    for (const feature of state.parcelsCollection.features) {
      const caseId = feature.properties.case_id;
      if (!state.parcelsByCase.has(caseId)) state.parcelsByCase.set(caseId, []);
      state.parcelsByCase.get(caseId).push(feature);
    }
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
