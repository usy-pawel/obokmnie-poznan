import {
  createRadarClient,
  isRetryableRadarError,
  monitorCreateBody,
  monitorIncludesParcel,
  monitorLabel,
  monitorTargetKey,
  radarErrorMessage,
  removeMonitorBackup,
  reusablePendingCreate,
} from './radar-client.js?v=radar-1';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const ORTHO_TILE_URL = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';
const LIST_SIZE = 80;
const RADAR_STORAGE_KEY = 'obokmnie-radar-v1';
const RADAR_SEEN_KEY = 'obokmnie-radar-seen-v1';
const RADAR_PENDING_KEY = 'obokmnie-radar-pending-v1';
const RANGE_COPY = {
  '1y': 'ostatnich 12 miesięcy',
  '3y': 'ostatnich 3 lat',
  '5y': 'ostatnich 5 lat',
  all: 'całej historii od 2016 roku',
};

const state = {
  map: null,
  mapResizeObserver: null,
  features: [],
  filter: 'all',
  range: '1y',
  query: '',
  region: null,
  selectedCaseKey: null,
  selectedDetail: null,
  selectedContext: null,
  caseRequestController: null,
  routeError: null,
  routeInitialized: false,
  shareNotice: '',
  listLimit: LIST_SIZE,
  baseLayer: 'streets',
  lastFittedQuery: '',
  requestController: null,
  requestTimer: null,
  suggestions: [],
  suggestionIndex: -1,
  suggestionController: null,
  suggestionTimer: null,
  radarOpen: false,
  radarMode: 'checking',
  radarAuthenticated: false,
  radarWatches: readRadarWatches(),
  radarPendingCreates: readRadarPendingCreates(),
  radarMonitors: [],
  radarEvents: [],
  radarLoading: false,
  radarError: false,
  radarNotice: '',
  radarCursor: '0',
  radarHasMore: false,
  radarBusy: new Set(),
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
  radarToggle: document.querySelector('#radar-toggle'),
  radarCount: document.querySelector('#radar-count'),
  radarPanel: document.querySelector('#radar-panel'),
  radarClose: document.querySelector('#radar-close'),
  radarMode: document.querySelector('#radar-mode'),
  radarWatches: document.querySelector('#radar-watches'),
  radarEvents: document.querySelector('#radar-events'),
  radarMore: document.querySelector('#radar-more'),
  radarState: document.querySelector('#radar-state'),
  canonical: document.querySelector('#canonical-link'),
  robots: document.querySelector('#robots-meta'),
  emptyMessage: document.querySelector('#empty-state p'),
};

const radarClient = createRadarClient();

function readRadarWatches() {
  try {
    const watches = JSON.parse(localStorage.getItem(RADAR_STORAGE_KEY) || '[]');
    return Array.isArray(watches) ? watches.filter((watch) => watch?.parcelId && watch?.watchedAt).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveRadarWatches() {
  localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(state.radarWatches));
}

function readRadarPendingCreates() {
  try {
    const pending = JSON.parse(localStorage.getItem(RADAR_PENDING_KEY) || '[]');
    return Array.isArray(pending) ? pending.filter((body) => (
      body?.version === 'radar_monitor_create_v1'
      && typeof body.idempotency_key === 'string'
      && monitorTargetKey(body.target)
    )).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveRadarPendingCreates() {
  localStorage.setItem(RADAR_PENDING_KEY, JSON.stringify(state.radarPendingCreates));
}

function radarEventLabel(type) {
  if (type === 'new') return 'Nowa sprawa';
  if (type === 'removed') return 'Sprawa zniknęła z bieżących danych';
  return 'Zmieniono sprawę';
}

function radarFieldLabel(field) {
  return ({
    received_date: 'data wpływu', decision_date: 'data decyzji', status: 'status', office: 'organ',
    voivodeship: 'województwo', city: 'miejscowość', address: 'adres', case_kind: 'rodzaj zamierzenia',
    description: 'opis', parcel_ids: 'działki', source_active: 'obecność w źródle', case: 'nowa sprawa',
  })[field] || field;
}

function eventMatchesWatch(event) {
  const parcels = event.snapshot?.parcel_ids || [];
  return state.radarWatches.some((watch) => !watch.serverPaused && parcels.includes(watch.parcelId)
    && new Date(event.occurred_at) > new Date(watch.watchedAt));
}

function parcelMonitorStatus(parcelId) {
  if (state.radarMode === 'server') {
    return state.radarMonitors.find((monitor) => monitorIncludesParcel(monitor, parcelId))?.status || null;
  }
  const watch = state.radarWatches.find((item) => item.parcelId === parcelId);
  if (!watch) return null;
  return watch.serverPaused ? 'paused' : 'active';
}

function appendRadarEvent(event) {
  const article = document.createElement('article');
  article.className = `radar-event is-${event.event_type}`;
  const top = document.createElement('div');
  const kind = document.createElement('strong');
  kind.textContent = radarEventLabel(event.event_type);
  const date = document.createElement('time');
  date.textContent = formatDate(event.detected_at || event.occurred_at);
  top.append(kind, date);
  const title = document.createElement('h3');
  title.textContent = shortTitle(event.snapshot?.description) || 'Sprawa budowlana';
  const place = document.createElement('p');
  place.textContent = event.snapshot?.address || event.snapshot?.city || event.snapshot?.external_id || '';
  article.append(top, title, place);
  if (event.changed_fields?.length) {
    const fields = document.createElement('small');
    fields.textContent = `Zakres: ${event.changed_fields.map(radarFieldLabel).join(', ')}`;
    article.append(fields);
  }
  ui.radarEvents.append(article);
}

function renderBrowserWatch(watch) {
  const chip = document.createElement('span');
  chip.className = 'radar-watch';
  const label = document.createElement('span');
  label.textContent = `${watch.label || watch.parcelId}${watch.serverPaused ? ' · wstrzymany' : ''}`;
  label.title = watch.parcelId;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Przestań obserwować działkę ${watch.parcelId}`);
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    state.radarWatches = state.radarWatches.filter((item) => item.parcelId !== watch.parcelId);
    saveRadarWatches();
    void loadRadar();
    renderCases();
    ui.radarClose.focus();
  });
  chip.append(label);
  if (watch.serverPaused) {
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.textContent = 'Wznów';
    resume.setAttribute('aria-label', `Wznów na tym urządzeniu: działka ${watch.parcelId}`);
    resume.addEventListener('click', async () => {
      watch.serverPaused = false;
      saveRadarWatches();
      state.radarNotice = `Obserwacja działki ${watch.parcelId} została wznowiona na tym urządzeniu.`;
      await loadRadar();
      renderCases();
      ui.radarClose.focus();
    });
    chip.append(resume);
  }
  chip.append(remove);
  ui.radarWatches.append(chip);
}

function handleExpiredRadarProfile(error) {
  if (error?.status !== 401) return false;
  state.radarAuthenticated = false;
  state.radarMonitors = [];
  state.radarEvents = [];
  state.radarCursor = '0';
  state.radarHasMore = false;
  return true;
}

async function mutateServerMonitor(monitor, action) {
  if (state.radarBusy.has(monitor.monitor_id)) return;
  if (action === 'delete' && !window.confirm(`Usunąć monitoring „${monitorLabel(monitor.target)}”?`)) return;
  state.radarBusy.add(monitor.monitor_id);
  state.radarNotice = '';
  renderRadar();
  try {
    if (action === 'delete') {
      await radarClient.deleteMonitor(monitor.monitor_id);
      state.radarMonitors = state.radarMonitors.filter((item) => item.monitor_id !== monitor.monitor_id);
      state.radarEvents = state.radarEvents.filter((event) => (
        !event.matched_monitor_ids?.includes(monitor.monitor_id)
      ));
      state.radarWatches = removeMonitorBackup(state.radarWatches, monitor.monitor_id);
      state.radarPendingCreates = state.radarPendingCreates.filter((body) => (
        monitorTargetKey(body.target) !== monitorTargetKey(monitor.target)
      ));
      saveRadarWatches();
      saveRadarPendingCreates();
      state.radarNotice = 'Monitoring został usunięty.';
    } else {
      const updated = action === 'pause'
        ? await radarClient.pauseMonitor(monitor.monitor_id)
        : await radarClient.resumeMonitor(monitor.monitor_id);
      state.radarMonitors = state.radarMonitors.map((item) => (
        item.monitor_id === updated.monitor_id ? updated : item
      ));
      for (const watch of state.radarWatches) {
        if (watch.serverMonitorId === monitor.monitor_id) watch.serverPaused = action === 'pause';
      }
      saveRadarWatches();
      state.radarNotice = action === 'pause' ? 'Monitoring został wstrzymany.' : 'Monitoring został wznowiony.';
    }
    renderCases();
  } catch (error) {
    state.radarNotice = handleExpiredRadarProfile(error)
      ? 'Sesja Radaru wygasła. Możesz ponownie uruchomić monitoring bez zakładania konta.'
      : radarErrorMessage(error);
  } finally {
    state.radarBusy.delete(monitor.monitor_id);
    renderRadar();
    if (action === 'delete' || !state.radarAuthenticated) ui.radarClose.focus();
    else focusMonitorAction(monitor.monitor_id);
  }
}

function renderServerMonitor(monitor) {
  const item = document.createElement('article');
  item.className = 'radar-monitor';
  item.dataset.monitorId = monitor.monitor_id;
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = monitorLabel(monitor.target);
  const status = document.createElement('span');
  status.className = `radar-monitor-status is-${monitor.status}`;
  status.textContent = monitor.status === 'paused' ? 'Wstrzymany' : 'Aktywny';
  copy.append(title, status);
  const actions = document.createElement('div');
  actions.className = 'radar-monitor-actions';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.disabled = state.radarBusy.has(monitor.monitor_id);
  toggle.textContent = monitor.status === 'paused' ? 'Wznów' : 'Wstrzymaj';
  toggle.dataset.monitorAction = 'toggle';
  toggle.setAttribute('aria-label', `${toggle.textContent} monitoring: ${monitorLabel(monitor.target)}`);
  toggle.addEventListener('click', () => {
    void mutateServerMonitor(monitor, monitor.status === 'paused' ? 'resume' : 'pause');
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'is-danger';
  remove.disabled = state.radarBusy.has(monitor.monitor_id);
  remove.textContent = 'Usuń';
  remove.setAttribute('aria-label', `Usuń monitoring: ${monitorLabel(monitor.target)}`);
  remove.addEventListener('click', () => { void mutateServerMonitor(monitor, 'delete'); });
  actions.append(toggle, remove);
  item.append(copy, actions);
  ui.radarWatches.append(item);
}

function focusMonitorAction(monitorId) {
  const item = [...ui.radarWatches.querySelectorAll('.radar-monitor')]
    .find((candidate) => candidate.dataset.monitorId === monitorId);
  item?.querySelector('[data-monitor-action="toggle"]')?.focus();
}

async function retryBrowserMigration(watch) {
  const busyKey = `migration:${watch.serverKey}`;
  if (state.radarBusy.has(busyKey)) return;
  state.radarBusy.add(busyKey);
  state.radarNotice = `Ponawiam przenoszenie działki ${watch.parcelId}…`;
  renderRadar();
  try {
    const created = await migrateBrowserWatch(watch);
    state.radarMonitors = [...new Map([...state.radarMonitors, created]
      .map((monitor) => [monitor.monitor_id, monitor])).values()];
    state.radarNotice = `Działka ${watch.parcelId} jest już bezpiecznie monitorowana.`;
    renderCases();
  } catch (error) {
    markMigrationFailure(watch, error);
    state.radarNotice = handleExpiredRadarProfile(error)
      ? 'Sesja Radaru wygasła. Uruchom monitoring ponownie.'
      : `Nie udało się przenieść działki ${watch.parcelId}. ${radarErrorMessage(error)}`;
  } finally {
    state.radarBusy.delete(busyKey);
    renderRadar();
    if (watch.serverMonitorId) focusMonitorAction(watch.serverMonitorId);
    else focusMigrationAction(watch.serverKey);
  }
}

function renderMigrationFailure(watch) {
  const item = document.createElement('article');
  item.className = 'radar-monitor is-error';
  item.dataset.migrationKey = watch.serverKey;
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `Działka ${watch.parcelId}`;
  const status = document.createElement('span');
  status.className = 'radar-monitor-status is-error';
  status.textContent = 'Nieprzeniesiona';
  copy.append(title, status);
  const actions = document.createElement('div');
  actions.className = 'radar-monitor-actions';
  const retryable = watch.serverMigrationRetryable !== false;
  if (!retryable) {
    const explanation = document.createElement('small');
    explanation.textContent = 'Tej obserwacji nie można przenieść automatycznie.';
    copy.append(explanation);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'is-danger';
  remove.textContent = 'Usuń';
  remove.dataset.migrationAction = 'remove';
  remove.setAttribute('aria-label', `Usuń nieprzeniesioną obserwację: działka ${watch.parcelId}`);
  remove.addEventListener('click', () => {
    state.radarWatches = state.radarWatches.filter((item) => item !== watch);
    saveRadarWatches();
    state.radarNotice = `Nieprzeniesiona obserwacja działki ${watch.parcelId} została usunięta.`;
    renderRadar();
    renderCases();
    ui.radarClose.focus();
  });
  if (retryable) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.disabled = state.radarBusy.has(`migration:${watch.serverKey}`);
    retry.textContent = 'Ponów';
    retry.dataset.migrationAction = 'retry';
    retry.setAttribute('aria-label', `Ponów przenoszenie monitoringu: działka ${watch.parcelId}`);
    retry.addEventListener('click', () => { void retryBrowserMigration(watch); });
    actions.append(retry);
  }
  actions.append(remove);
  item.append(copy, actions);
  ui.radarWatches.append(item);
}

function focusMigrationAction(serverKey) {
  const item = [...ui.radarWatches.querySelectorAll('.radar-monitor')]
    .find((candidate) => candidate.dataset.migrationKey === serverKey);
  item?.querySelector('[data-migration-action="retry"], [data-migration-action="remove"]')?.focus();
}

function renderRadar() {
  ui.radarPanel.hidden = !state.radarOpen;
  ui.radarToggle.setAttribute('aria-expanded', String(state.radarOpen));
  ui.radarWatches.replaceChildren();
  ui.radarEvents.replaceChildren();

  if (state.radarMode === 'server') {
    state.radarMonitors.forEach(renderServerMonitor);
    state.radarWatches.filter((watch) => watch.serverMigrationError && !watch.serverMonitorId)
      .forEach(renderMigrationFailure);
  }
  else state.radarWatches.forEach(renderBrowserWatch);

  const activeMonitorIds = new Set(state.radarMonitors
    .filter((monitor) => monitor.status === 'active')
    .map((monitor) => monitor.monitor_id));
  const visibleEvents = state.radarMode === 'server'
    ? state.radarEvents.filter((event) => event.matched_monitor_ids?.some((id) => activeMonitorIds.has(id)))
    : state.radarEvents.filter(eventMatchesWatch);
  const uniqueEvents = [...new Map(visibleEvents.map((event) => [event.event_id || event.match_id, event])).values()];
  uniqueEvents.forEach(appendRadarEvent);
  ui.radarMore.hidden = state.radarMode !== 'server' || !state.radarHasMore;
  ui.radarMore.disabled = state.radarLoading;

  const lastSeen = new Date(localStorage.getItem(RADAR_SEEN_KEY) || 0);
  const unseen = uniqueEvents.filter((event) => new Date(event.occurred_at) > lastSeen).length;
  ui.radarCount.textContent = String(unseen);
  ui.radarCount.hidden = unseen === 0;
  if (state.radarMode === 'checking') {
    ui.radarMode.textContent = 'Sprawdzam bezpieczne przechowywanie monitoringu…';
  } else if (state.radarMode === 'server') {
    ui.radarMode.textContent = 'Monitoring jest bezpiecznie zapisany i dostępny bez konta ani hasła.';
  } else {
    ui.radarMode.textContent = 'Monitoring jest zapisany na tym urządzeniu. Gdy synchronizacja będzie dostępna, zostanie bezpiecznie przeniesiony.';
  }
  const failedMigrations = state.radarWatches.filter((watch) => watch.serverMigrationError && !watch.serverMonitorId).length;
  const monitorCount = state.radarMode === 'server'
    ? state.radarMonitors.length + failedMigrations
    : state.radarWatches.length;
  if (state.radarNotice) ui.radarState.textContent = state.radarNotice;
  else if (!monitorCount) ui.radarState.textContent = 'Nie obserwujesz jeszcze żadnej działki. Rozwiń sprawę na mapie i wybierz „Obserwuj działkę”.';
  else if (state.radarLoading) ui.radarState.textContent = 'Sprawdzam zmiany…';
  else if (state.radarError) ui.radarState.textContent = 'Nie udało się sprawdzić zmian. Spróbuj ponownie później.';
  else if (!uniqueEvents.length) ui.radarState.textContent = 'Brak nowych zmian od momentu rozpoczęcia obserwacji.';
  else ui.radarState.textContent = `Znaleziono ${uniqueEvents.length} ${uniqueEvents.length === 1 ? 'zmianę' : 'zmian'}.`;
}

async function loadBrowserRadar() {
  state.radarLoading = true;
  state.radarError = false;
  renderRadar();
  if (!state.radarWatches.length) {
    state.radarEvents = [];
    state.radarLoading = false;
    renderRadar();
    return;
  }
  const params = new URLSearchParams();
  for (const watch of state.radarWatches) params.append('parcel', watch.parcelId);
  params.set('since', state.radarWatches.reduce((earliest, watch) => (
    watch.watchedAt < earliest ? watch.watchedAt : earliest
  ), state.radarWatches[0].watchedAt));
  try {
    const response = await fetch(`/api/radar?${params}`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    state.radarEvents = payload.events || [];
  } catch {
    state.radarEvents = [];
    state.radarError = true;
  } finally {
    state.radarLoading = false;
    renderRadar();
  }
}

async function loadServerRadar() {
  if (!state.radarAuthenticated) {
    state.radarMonitors = [];
    state.radarEvents = [];
    state.radarHasMore = false;
    renderRadar();
    return;
  }
  state.radarLoading = true;
  state.radarError = false;
  renderRadar();
  try {
    const [list, feed] = await Promise.all([
      radarClient.listMonitors(),
      radarClient.readEvents(state.radarCursor),
    ]);
    state.radarMonitors = list.monitors || [];
    state.radarEvents = [...new Map([...state.radarEvents, ...(feed.events || [])]
      .map((event) => [event.match_id, event])).values()];
    state.radarCursor = feed.next_after_match_id || state.radarCursor;
    state.radarHasMore = feed.has_more === true;
  } catch (error) {
    state.radarError = true;
    state.radarNotice = handleExpiredRadarProfile(error)
      ? 'Sesja Radaru wygasła. Możesz ponownie uruchomić monitoring bez zakładania konta.'
      : radarErrorMessage(error);
  } finally {
    state.radarLoading = false;
    renderRadar();
  }
}

async function ensureRadarProfile() {
  if (state.radarAuthenticated) return false;
  await radarClient.createProfile();
  state.radarAuthenticated = true;
  return true;
}

async function migrateBrowserWatch(watch) {
  const created = await radarClient.createMonitor(monitorCreateBody(
    { kind: 'parcel', parcel_id: watch.parcelId },
    {
      idempotencyKey: watch.serverKey,
      source: 'local_storage_v1',
      observedSince: watch.watchedAt,
    },
  ));
  watch.serverMonitorId = created.monitor_id;
  watch.serverPaused = created.status === 'paused';
  delete watch.serverMigrationError;
  delete watch.serverMigrationRetryable;
  saveRadarWatches();
  return created;
}

function markMigrationFailure(watch, error) {
  watch.serverMigrationError = error?.code || 'request_failed';
  watch.serverMigrationRetryable = isRetryableRadarError(error);
  saveRadarWatches();
}

async function migrateBrowserWatches({ profileCreated = false } = {}) {
  if (!state.radarWatches.length) return { migrated: 0, failed: 0 };
  if (profileCreated) {
    for (const watch of state.radarWatches) {
      delete watch.serverMonitorId;
      delete watch.serverMigrationError;
    }
  }
  for (const watch of state.radarWatches) {
    if (!watch.serverKey) watch.serverKey = crypto.randomUUID();
  }
  saveRadarWatches();
  let migrated = 0;
  let failed = 0;
  for (const watch of state.radarWatches) {
    if (watch.serverMonitorId) continue;
    if (watch.serverMigrationError && watch.serverMigrationRetryable === false) {
      failed += 1;
      continue;
    }
    try {
      const created = await migrateBrowserWatch(watch);
      state.radarMonitors = [...new Map([...state.radarMonitors, created]
        .map((monitor) => [monitor.monitor_id, monitor])).values()];
      migrated += 1;
    } catch (error) {
      markMigrationFailure(watch, error);
      failed += 1;
    }
  }
  return { migrated, failed };
}

async function reconcilePendingCreates() {
  let recovered = 0;
  let failed = 0;
  for (const body of [...state.radarPendingCreates]) {
    try {
      await radarClient.createMonitor(body);
      state.radarPendingCreates = state.radarPendingCreates.filter((item) => (
        item.idempotency_key !== body.idempotency_key
      ));
      saveRadarPendingCreates();
      recovered += 1;
    } catch (error) {
      if (!isRetryableRadarError(error)) {
        state.radarPendingCreates = state.radarPendingCreates.filter((item) => (
          item.idempotency_key !== body.idempotency_key
        ));
        saveRadarPendingCreates();
      }
      failed += 1;
    }
  }
  return { recovered, failed };
}

let radarInitialization;

async function initializeRadar() {
  if (radarInitialization) return radarInitialization;
  radarInitialization = (async () => {
    try {
      const probe = await radarClient.probeProfile();
      state.radarMode = probe.available ? 'server' : 'browser';
      state.radarAuthenticated = probe.authenticated;
      if (probe.available && (state.radarWatches.length || state.radarPendingCreates.length)) {
        const profileCreated = await ensureRadarProfile();
        const migration = await migrateBrowserWatches({ profileCreated });
        const pending = await reconcilePendingCreates();
        if (migration.failed || pending.failed) {
          state.radarNotice = 'Część obserwacji wymaga ponowienia. Pozostałe są już bezpiecznie zsynchronizowane.';
        } else if (migration.migrated || pending.recovered) {
          state.radarNotice = 'Dotychczasowe obserwacje są teraz bezpiecznie zsynchronizowane.';
        }
      }
    } catch {
      state.radarMode = 'browser';
      state.radarAuthenticated = false;
      state.radarNotice = 'Synchronizacja monitoringu jest chwilowo niedostępna. Obserwacje pozostają na tym urządzeniu.';
    }
    await loadRadar();
    renderCases();
  })();
  return radarInitialization;
}

async function loadRadar() {
  if (state.radarMode === 'checking') return;
  if (state.radarMode === 'server') return loadServerRadar();
  return loadBrowserRadar();
}

async function watchSelectedParcels(detail) {
  if (state.radarMode === 'checking') await initializeRadar();
  const parcels = [...new Set((detail?.parcels || []).map((parcel) => parcel.parcel_id).filter(Boolean))]
    .filter((parcelId) => !parcelMonitorStatus(parcelId));
  if (!parcels.length) return;
  if (state.radarMode === 'server') {
    let target = parcels.length === 1
      ? { kind: 'parcel', parcel_id: parcels[0] }
      : { kind: 'parcel_set', parcel_ids: parcels.sort() };
    const busyKey = `create:${target.kind}:${parcels.join('|')}`;
    if (state.radarBusy.has(busyKey)) return;
    state.radarBusy.add(busyKey);
    state.radarNotice = 'Zapisuję monitoring…';
    state.radarOpen = true;
    renderRadar();
    try {
      const profileCreated = await ensureRadarProfile();
      if (profileCreated) {
        await migrateBrowserWatches({ profileCreated: true });
        const remaining = parcels.filter((parcelId) => !parcelMonitorStatus(parcelId));
        if (!remaining.length) {
          state.radarNotice = 'Monitoring został ponownie uruchomiony.';
          return;
        }
        target = remaining.length === 1
          ? { kind: 'parcel', parcel_id: remaining[0] }
          : { kind: 'parcel_set', parcel_ids: remaining.sort() };
      }
      const targetKey = monitorTargetKey(target);
      const body = reusablePendingCreate(state.radarPendingCreates, target, crypto.randomUUID());
      if (!state.radarPendingCreates.some((item) => monitorTargetKey(item.target) === targetKey)) {
        state.radarPendingCreates.push(body);
        saveRadarPendingCreates();
      }
      const created = await radarClient.createMonitor(body);
      state.radarPendingCreates = state.radarPendingCreates.filter((item) => (
        item.idempotency_key !== body.idempotency_key
      ));
      saveRadarPendingCreates();
      state.radarMonitors = [...new Map([...state.radarMonitors, created]
        .map((monitor) => [monitor.monitor_id, monitor])).values()];
      state.radarNotice = 'Monitoring został uruchomiony.';
    } catch (error) {
      if (!isRetryableRadarError(error)) {
        state.radarPendingCreates = state.radarPendingCreates.filter((item) => (
          monitorTargetKey(item.target) !== monitorTargetKey(target)
        ));
        saveRadarPendingCreates();
      }
      state.radarNotice = handleExpiredRadarProfile(error)
        ? 'Sesja Radaru wygasła. Spróbuj ponownie uruchomić monitoring.'
        : radarErrorMessage(error);
    } finally {
      state.radarBusy.delete(busyKey);
      renderRadar();
      renderCases();
      window.requestAnimationFrame(() => ui.radarPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    return;
  }

  const now = new Date().toISOString();
  const known = new Set(state.radarWatches.map((watch) => watch.parcelId));
  for (const parcel of detail.parcels || []) {
    if (!parcel.parcel_id || known.has(parcel.parcel_id) || state.radarWatches.length >= 20) continue;
    state.radarWatches.push({
      parcelId: parcel.parcel_id,
      label: `${detail.address || detail.city || 'Działka'} · ${parcel.parcel_id}`,
      watchedAt: now,
    });
    known.add(parcel.parcel_id);
  }
  saveRadarWatches();
  state.radarOpen = true;
  void loadRadar();
  renderCases();
  window.requestAnimationFrame(() => ui.radarPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

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

function publicCasePath(key) {
  return `/sprawa/${encodeURIComponent(key)}`;
}

function caseKeyFromPath(pathname = window.location.pathname) {
  const match = /^\/sprawa\/([^/]+)\/?$/u.exec(pathname);
  if (!match) return null;
  try {
    const key = decodeURIComponent(match[1]);
    return key && !/[\u0000-\u001f]/u.test(key) ? key : null;
  } catch {
    return null;
  }
}

function updateCanonical(key = null) {
  ui.canonical.href = new URL(key ? publicCasePath(key) : '/', window.location.origin).href;
  ui.robots.content = key ? 'noindex,follow' : 'index,follow';
}

function updateCaseRoute(key, { replace = false } = {}) {
  const path = key ? publicCasePath(key) : '/';
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current !== path) window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  updateCanonical(key);
}

function featureFromDetail(detail) {
  return {
    type: 'Feature',
    geometry: detail.location,
    properties: {
      ...detail,
      cluster: false,
      parcel_count: (detail.parcels || []).length,
    },
  };
}

function keepSelectedFeature(detail) {
  if (!detail?.location) return;
  const key = caseKey(detail);
  if (!state.features.some((feature) => !feature.properties.cluster && caseKey(feature.properties) === key)) {
    state.features.unshift(featureFromDetail(detail));
    state.map?.getSource('cases')?.setData({ type: 'FeatureCollection', features: state.features });
  }
}

function closeSelectedCase({ updateHistory = true } = {}) {
  state.caseRequestController?.abort();
  state.caseRequestController = null;
  state.selectedCaseKey = null;
  state.selectedDetail = null;
  state.selectedContext = null;
  state.routeError = null;
  state.shareNotice = '';
  state.map?.getSource('selected-parcels')?.setData(emptyCollection());
  if (updateHistory) updateCaseRoute(null);
  else updateCanonical();
  renderCases();
}

async function shareCase(detail) {
  const key = caseKey(detail);
  const url = new URL(publicCasePath(key), window.location.origin).href;
  const title = shortTitle(detail.description) || 'Sprawa budowlana';
  try {
    if (navigator.share) {
      await navigator.share({ title, text: `${title} — RadarZmian`, url });
      state.shareNotice = 'Udostępniono sprawę.';
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      state.shareNotice = 'Skopiowano bezpośredni adres sprawy.';
    } else {
      state.shareNotice = 'Bezpośredni adres sprawy jest widoczny w pasku przeglądarki.';
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    state.shareNotice = 'Nie udało się udostępnić sprawy. Skopiuj adres z paska przeglądarki.';
  }
  renderCases();
}

function parcelFeatures(detail) {
  return (detail?.parcels || []).map((parcel) => ({
    type: 'Feature',
    geometry: parcel.geometry,
    properties: { parcel_id: parcel.parcel_id },
  }));
}

function hasSameParcels(left, right) {
  const leftIds = new Set((left?.parcels || []).map((parcel) => parcel.parcel_id).filter(Boolean));
  const rightIds = new Set((right?.parcels || []).map((parcel) => parcel.parcel_id).filter(Boolean));
  return leftIds.size > 0 && leftIds.size === rightIds.size
    && [...leftIds].every((parcelId) => rightIds.has(parcelId));
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
  const focusedControl = ui.list.contains(document.activeElement)
    ? {
        caseKey: document.activeElement.closest('.case-card')?.dataset.caseId,
        control: document.activeElement.dataset.caseControl,
      }
    : null;
  const cases = state.features.filter((feature) => !feature.properties.cluster);
  const clusters = state.features.filter((feature) => feature.properties.cluster);
  const provinces = clusters.filter((feature) => feature.properties.cluster_scope === 'voivodeship');
  if (state.routeError && !state.selectedCaseKey) {
    const errorHeading = state.routeError === 'withdrawn'
      ? 'Sprawa została wycofana'
      : state.routeError === 'not_found'
        ? 'Nie znaleziono sprawy'
        : 'Sprawa jest chwilowo niedostępna';
    const errorNote = state.routeError === 'withdrawn'
      ? 'Sprawa nie jest już publikowana w aktualnych danych. Nie pokazujemy nieaktualnych szczegółów.'
      : state.routeError === 'not_found'
        ? 'Ten adres nie prowadzi do opublikowanej sprawy. Sprawdź link albo wróć do mapy.'
        : 'Nie udało się teraz pobrać sprawy. Odśwież stronę za chwilę; bezpośredni adres pozostaje bez zmian.';
    ui.list.replaceChildren();
    ui.list.classList.remove('is-province-list', 'is-cluster-list');
    ui.casesEyebrow.textContent = 'Bezpośredni adres sprawy';
    ui.casesHeading.textContent = errorHeading;
    ui.resultCount.textContent = '0';
    ui.listNote.textContent = errorNote;
    ui.emptyMessage.textContent = `${errorHeading}. ${errorNote} Wróć do mapy, aby wyszukać aktualne sprawy.`;
    ui.empty.hidden = false;
    ui.loadMore.hidden = true;
    return;
  }
  ui.emptyMessage.textContent = 'Brak spraw dla wybranych kryteriów.';
  if (provinces.length && !state.query && !state.selectedCaseKey) {
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
    const radarAction = fragment.querySelector('.radar-action');
    const monitorStatuses = resolvedParcelIds.map(parcelMonitorStatus);
    const allMonitored = Boolean(monitorStatuses.length) && monitorStatuses.every(Boolean);
    const hasPaused = monitorStatuses.some((status) => status === 'paused');
    radarAction.disabled = !detail || !resolvedParcelIds.length || allMonitored || state.radarMode === 'checking';
    if (allMonitored && hasPaused) radarAction.textContent = 'Monitoring wstrzymany — wznów w Radarze';
    else radarAction.textContent = allMonitored ? '✓ Działka jest obserwowana' : '◉ Obserwuj działkę w Radarze';
    radarAction.addEventListener('click', () => { void watchSelectedParcels(detail); });
    const shareAction = fragment.querySelector('.share-action');
    shareAction.disabled = !detail;
    shareAction.addEventListener('click', () => { if (detail) void shareCase(detail); });
    fragment.querySelector('.share-state').textContent = selected ? state.shareNotice : '';
    button.setAttribute('aria-expanded', String(selected));
    button.addEventListener('click', () => { void selectCase(key, { moveMap: true }); });
    ui.list.append(fragment);
  }
  if (focusedControl?.caseKey) {
    window.requestAnimationFrame(() => {
      const card = [...ui.list.querySelectorAll('.case-card')]
        .find((element) => element.dataset.caseId === focusedControl.caseKey);
      const selector = focusedControl.control
        ? `[data-case-control="${focusedControl.control}"]`
        : '.case-card-button';
      (card?.querySelector(selector) || card?.querySelector('.case-card-button'))
        ?.focus({ preventScroll: true });
    });
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
  const incoming = (collection.features || []).filter((feature) => (
    feature.properties?.cluster || Number(feature.properties?.parcel_count || 0) > 0
  ));
  if (state.selectedDetail && !incoming.some((feature) => (
    !feature.properties.cluster && caseKey(feature.properties) === state.selectedCaseKey
  ))) {
    incoming.unshift(featureFromDetail(state.selectedDetail));
  }
  state.features = incoming;
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
  const {
    moveMap = false,
    showAerial = false,
    scrollToCard = false,
    toggle = true,
    updateHistory = true,
    preserveRouteOnError = false,
  } = options;
  if (state.selectedCaseKey === key && state.selectedDetail && toggle) {
    closeSelectedCase({ updateHistory });
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
  const previousDetail = state.selectedDetail;
  state.caseRequestController?.abort();
  const controller = new AbortController();
  state.caseRequestController = controller;
  state.routeError = null;
  state.shareNotice = '';
  state.selectedCaseKey = key;
  state.selectedDetail = null;
  state.selectedContext = null;
  if (updateHistory) updateCaseRoute(key);
  else updateCanonical(key);
  renderCases();
  try {
    const response = await fetch(`/api/cases/${encodeURIComponent(key)}`, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const detail = await response.json();
    if (state.caseRequestController !== controller || state.selectedCaseKey !== key) return;
    state.selectedDetail = detail;
    keepSelectedFeature(state.selectedDetail);
    state.selectedContext = { status: 'loading' };
    const features = parcelFeatures(state.selectedDetail);
    if (!features.length) throw new Error('Brak geometrii działki');
    state.map.getSource('selected-parcels')?.setData({ type: 'FeatureCollection', features });
    renderCases();
    void loadCaseContext(key);
    if (moveMap) {
      if (showAerial) setBaseLayer('aerial');
      if (!hasSameParcels(previousDetail, state.selectedDetail)) {
        const bounds = boundsForFeatures(features);
        if (bounds) state.map.fitBounds(bounds, { padding: 70, maxZoom: 17, duration: 800 });
        else if (state.selectedDetail.location) state.map.flyTo({ center: state.selectedDetail.location.coordinates, zoom: 16 });
      }
    }
    if (scrollToCard) scrollSelectedCard();
  } catch (error) {
    if (error.name === 'AbortError' || state.caseRequestController !== controller || state.selectedCaseKey !== key) return;
    state.selectedCaseKey = null;
    state.selectedDetail = null;
    state.selectedContext = null;
    state.map.getSource('selected-parcels')?.setData(emptyCollection());
    if (preserveRouteOnError) {
      state.routeError = error.status === 410
        ? 'withdrawn'
        : error.status === 404
          ? 'not_found'
          : 'unavailable';
      updateCanonical(key);
    } else {
      updateCaseRoute(null, { replace: true });
    }
    renderCases();
    if (!preserveRouteOnError) ui.listNote.textContent = 'Nie udało się pobrać szczegółów tej sprawy.';
  } finally {
    if (state.caseRequestController === controller) state.caseRequestController = null;
  }
}

function initializePublicRoute() {
  if (state.routeInitialized) return;
  state.routeInitialized = true;
  const key = caseKeyFromPath();
  updateCanonical(key);
  if (key) {
    void selectCase(key, {
      moveMap: true,
      scrollToCard: true,
      toggle: false,
      updateHistory: false,
      preserveRouteOnError: true,
    });
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
  const mapElement = document.querySelector('#map');
  if (typeof ResizeObserver !== 'undefined') {
    state.mapResizeObserver?.disconnect();
    state.mapResizeObserver = new ResizeObserver(() => { state.map?.resize(); });
    state.mapResizeObserver.observe(mapElement);
  }
  const resizeVisibleMap = () => {
    if (document.hidden) return;
    window.requestAnimationFrame(() => { state.map?.resize(); });
  };
  window.addEventListener('resize', resizeVisibleMap);
  document.addEventListener('visibilitychange', resizeVisibleMap);

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
    initializePublicRoute();
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

ui.radarToggle.addEventListener('click', () => {
  state.radarOpen = !state.radarOpen;
  if (state.radarOpen) localStorage.setItem(RADAR_SEEN_KEY, new Date().toISOString());
  renderRadar();
  if (state.radarOpen) void loadRadar();
});
ui.radarClose.addEventListener('click', () => {
  state.radarOpen = false;
  renderRadar();
  ui.radarToggle.focus();
});
ui.radarMore.addEventListener('click', async () => {
  await loadServerRadar();
  if (ui.radarMore.hidden) ui.radarClose.focus();
  else ui.radarMore.focus();
});

window.addEventListener('popstate', () => {
  const key = caseKeyFromPath();
  if (!key) {
    closeSelectedCase({ updateHistory: false });
    return;
  }
  void selectCase(key, {
    moveMap: true,
    scrollToCard: true,
    toggle: false,
    updateHistory: false,
    preserveRouteOnError: true,
  });
});

initializeMap();
loadMeta().catch(() => { ui.heroCount.textContent = '—'; });
void initializeRadar();
