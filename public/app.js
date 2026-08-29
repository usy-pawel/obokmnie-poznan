const DATA_URL = '/data/strzeszyn-parcels.geojson';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

const state = {
  data: null,
  cases: [],
  filter: 'all',
  selectedCaseId: null,
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
};

function formatDate(value) {
  return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
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

function groupCases(collection) {
  const grouped = new Map();
  for (const feature of collection.features) {
    const id = feature.properties.case_id;
    if (!grouped.has(id)) {
      grouped.set(id, {
        ...feature.properties,
        features: [],
        parcelIds: new Set(),
      });
    }
    const item = grouped.get(id);
    item.features.push(feature);
    item.parcelIds.add(feature.properties.parcel_id);
  }
  return [...grouped.values()].sort((a, b) => b.received_date.localeCompare(a.received_date));
}

function coordinatesFromGeometry(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
}

function boundsForFeatures(features) {
  const points = features.flatMap((feature) => coordinatesFromGeometry(feature.geometry));
  return points.reduce(
    (bounds, point) => bounds.extend(point),
    new maplibregl.LngLatBounds(points[0], points[0]),
  );
}

function filteredCases() {
  if (state.filter === 'all') return state.cases;
  return state.cases.filter((item) => item.source_type === state.filter);
}

function typeLabel(item) {
  return item.source_type === 'zgloszenie' ? 'Zgłoszenie' : 'Pozwolenie';
}

function renderCases() {
  const visible = filteredCases();
  ui.list.replaceChildren();
  ui.resultCount.textContent = String(visible.length);
  ui.heroCount.textContent = String(visible.length);
  ui.empty.hidden = visible.length !== 0;

  for (const item of visible) {
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
    fragment.querySelector('.detail-parcels').textContent = [...item.parcelIds].join(', ');
    button.setAttribute('aria-expanded', String(item.case_id === state.selectedCaseId));
    button.addEventListener('click', () => selectCase(item.case_id, true));
    ui.list.append(fragment);
  }
}

function setMapFilter() {
  if (!state.map?.getLayer('parcels-fill')) return;
  const filter = state.filter === 'all' ? null : ['==', ['get', 'source_type'], state.filter];
  state.map.setFilter('parcels-fill', filter);
  state.map.setFilter('parcels-outline', filter);
  if (state.selectedCaseId && !filteredCases().some((item) => item.case_id === state.selectedCaseId)) {
    state.selectedCaseId = null;
  }
  state.map.setFilter('parcels-selected', state.selectedCaseId ? ['==', ['get', 'case_id'], state.selectedCaseId] : ['==', ['get', 'case_id'], '']);
}

function selectCase(caseId, moveMap = false) {
  state.selectedCaseId = state.selectedCaseId === caseId ? null : caseId;
  renderCases();
  setMapFilter();
  if (!state.selectedCaseId) return;

  const item = state.cases.find((candidate) => candidate.case_id === state.selectedCaseId);
  if (moveMap && item && state.map) {
    state.map.fitBounds(boundsForFeatures(item.features), {
      padding: { top: 90, right: 90, bottom: 90, left: 90 },
      maxZoom: 17,
      duration: 700,
    });
  }
  requestAnimationFrame(() => {
    document.querySelector(`[data-case-id="${CSS.escape(state.selectedCaseId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function popupForFeature(feature, lngLat) {
  const wrapper = document.createElement('div');
  const type = document.createElement('span');
  type.className = 'popup-type';
  type.textContent = feature.properties.source_type === 'zgloszenie' ? 'Zgłoszenie' : 'Pozwolenie';
  const title = document.createElement('h3');
  title.className = 'popup-title';
  title.textContent = shortTitle(feature.properties.description);
  const address = document.createElement('p');
  address.className = 'popup-address';
  address.textContent = feature.properties.address;
  wrapper.append(type, title, address);
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ closeButton: false, offset: 12 })
    .setLngLat(lngLat)
    .setDOMContent(wrapper)
    .addTo(state.map);
}

function initMap(collection) {
  state.map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [16.855, 52.456],
    zoom: 13,
    minZoom: 11,
    maxZoom: 19,
    attributionControl: true,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  state.map.on('load', () => {
    state.map.addSource('parcels', { type: 'geojson', data: collection });
    state.map.addLayer({
      id: 'parcels-fill',
      type: 'fill',
      source: 'parcels',
      paint: {
        'fill-color': ['match', ['get', 'source_type'], 'zgloszenie', '#347c6c', '#e26948'],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.48, 16, 0.66],
      },
    });
    state.map.addLayer({
      id: 'parcels-outline',
      type: 'line',
      source: 'parcels',
      paint: {
        'line-color': ['match', ['get', 'source_type'], 'zgloszenie', '#195649', '#9d3c28'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 17, 2.8],
        'line-opacity': 0.95,
      },
    });
    state.map.addLayer({
      id: 'parcels-selected',
      type: 'line',
      source: 'parcels',
      filter: ['==', ['get', 'case_id'], ''],
      paint: { 'line-color': '#f3b841', 'line-width': 5, 'line-blur': 0.3 },
    });

    state.map.fitBounds(boundsForFeatures(collection.features), {
      padding: 70,
      maxZoom: 14.4,
      duration: 0,
    });
    ui.loading.classList.add('is-hidden');
  });

  state.map.on('click', 'parcels-fill', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    selectCase(feature.properties.case_id);
    popupForFeature(feature, event.lngLat);
  });
  state.map.on('mouseenter', 'parcels-fill', () => { state.map.getCanvas().style.cursor = 'pointer'; });
  state.map.on('mouseleave', 'parcels-fill', () => { state.map.getCanvas().style.cursor = ''; });
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
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
    state.data = await response.json();
    state.cases = groupCases(state.data);
    renderCases();
    initMap(state.data);
  } catch (error) {
    ui.loading.classList.add('is-error');
    ui.loading.querySelector('p').textContent = 'Nie udało się załadować danych.';
    console.error(error);
  }
}

for (const button of ui.filters) {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    ui.filters.forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
    renderCases();
    setMapFilter();
  });
}

start();
