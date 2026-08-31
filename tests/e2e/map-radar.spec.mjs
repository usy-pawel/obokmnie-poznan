import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

const indexHtml = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
const maplibreStub = await readFile(new URL('./fixtures/maplibre-stub.js', import.meta.url), 'utf8');
const maplibreReal = await readFile(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl.js', import.meta.url), 'utf8');
const maplibreCss = await readFile(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl.css', import.meta.url), 'utf8');
const sri = (content) => `sha384-${createHash('sha384').update(content).digest('base64')}`;
const maplibreRealSri = sri(maplibreReal);
const maplibreCssSri = sri(maplibreCss);
const COLD_START_BUDGET_MS = 2_500;
const REAL_MAP_START_BUDGET_MS = 6_000;
const parcelId = '146501_8.0001.1';

function appOrigin() {
  const port = Number(process.env.RADAR_E2E_PORT);
  if (!Number.isInteger(port) || port < 1) throw new Error('Missing RADAR_E2E_PORT from the local web server');
  return `http://127.0.0.1:${port}`;
}

function collection(features) {
  return { type: 'FeatureCollection', features };
}

function cluster({ scope, label, region = 'Mazowieckie', count = 4, bounds }) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [21.01, 52.23] },
    properties: {
      cluster: true,
      cluster_scope: scope,
      label,
      region,
      count,
      bounds,
    },
  };
}

const currentCase = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [21.02, 52.235] },
  properties: {
    cluster: false,
    case_key: 'pozwolenie:current',
    case_id: 'current',
    source_type: 'pozwolenie',
    parcel_count: 1,
    external_id: 'WA-2026-001',
    received_date: '2026-08-20',
    status: 'decyzja ostateczna',
    description: 'Pozwolenie na budowę osiedla mieszkaniowego z zielonym dziedzińcem i garażem podziemnym',
    address: 'ul. Testowa 10, Warszawa',
    city: 'Warszawa',
    voivodeship: 'Mazowieckie',
  },
};

const historicalCase = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [21.02, 52.235] },
  properties: {
    cluster: false,
    historical: true,
    case_key: 'pozwolenie:history',
    case_id: 'history',
    source_type: 'pozwolenie',
    parcel_count: 1,
    external_id: 'WA-2024-009',
    received_date: '2024-05-10',
    status: 'zakończona',
    description: 'Pozwolenie na przebudowę budynku usługowego na tej samej działce',
    address: 'ul. Testowa 10, Warszawa',
    city: 'Warszawa',
    voivodeship: 'Mazowieckie',
  },
};

const emptyPoint = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [21.02, 52.24] },
  properties: {
    cluster: false,
    case_key: 'pozwolenie:without-parcel',
    case_id: 'without-parcel',
    parcel_count: 0,
    description: 'Punkt bez potwierdzonej działki',
  },
};

function caseDetail(key) {
  const historical = key === 'pozwolenie:history';
  return {
    case_key: key,
    external_id: historical ? 'WA-2024-009' : 'WA-2026-001',
    decision_date: historical ? '2024-06-15' : '2026-08-28',
    office: 'Urząd m.st. Warszawy',
    case_kind: historical ? 'przebudowa' : 'budowa budynku mieszkalnego',
    parcel_ids: [parcelId],
    parcels: [{
      parcel_id: parcelId,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [21.019, 52.234],
          [21.021, 52.234],
          [21.021, 52.236],
          [21.019, 52.236],
          [21.019, 52.234],
        ]],
      },
    }],
    location: { type: 'Point', coordinates: [21.02, 52.235] },
  };
}

async function fulfillJson(route, payload, { status = 200, delayMs = 0 } = {}) {
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  });
}

async function installDeterministicRoutes(page, {
  contextDelayMs = 0,
  mapDelayMs = 20,
  realMap = false,
} = {}) {
  const origin = appOrigin();
  const maplibreScriptUrl = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
  const maplibreCssUrl = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css';
  const mapStyleUrl = 'https://tiles.openfreemap.org/styles/positron';
  const diagnostics = { mapRequests: [], pageErrors: [], unexpectedRequests: [] };
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const allowed = url.origin === origin
      || url.href === maplibreScriptUrl
      || url.href === maplibreCssUrl
      || url.href === mapStyleUrl;
    if (allowed) await route.continue();
    else {
      diagnostics.unexpectedRequests.push({ origin: url.origin, pathname: url.pathname });
      await route.abort('blockedbyclient');
    }
  });
  await page.route(`${origin}/`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: realMap
      ? indexHtml
      : indexHtml
        .replace(maplibreRealSri, sri(maplibreStub))
        .replace(maplibreCssSri, sri('')),
  }));
  await page.route(maplibreScriptUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript; charset=utf-8',
    headers: { 'access-control-allow-origin': '*' },
    body: realMap ? maplibreReal : maplibreStub,
  }));
  await page.route(maplibreCssUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/css; charset=utf-8',
    headers: { 'access-control-allow-origin': '*' },
    body: realMap ? maplibreCss : '',
  }));
  await page.route(mapStyleUrl, (route) => fulfillJson(route, {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f5f1e9' } }],
  }));
  await page.route(`${origin}/api/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/meta') {
      await fulfillJson(route, {
        published_cases: 2,
        period_start: '2024-01-01',
        period_end: '2026-08-30',
      });
      return;
    }
    if (url.pathname === '/api/radar/profile') {
      await fulfillJson(route, { error: 'router_disabled' }, { status: 404 });
      return;
    }
    if (url.pathname === '/api/map') {
      const zoom = Number(url.searchParams.get('zoom'));
      const range = url.searchParams.get('range');
      const region = url.searchParams.get('region');
      diagnostics.mapRequests.push({ zoom, range, region: region || null });
      let payload;
      if (!region) {
        payload = collection([cluster({
          scope: 'voivodeship',
          label: 'Mazowieckie',
          count: 12,
          bounds: [[19, 50.8], [23.2, 53.5]],
        })]);
      } else if (zoom < 8.5) {
        payload = collection([cluster({
          scope: 'area',
          label: 'Warszawa i okolice',
          count: 8,
          bounds: [[20, 51.5], [22, 52.8]],
        })]);
      } else if (zoom < 10.5) {
        payload = collection([cluster({
          scope: 'powiat',
          label: 'Warszawa',
          count: 5,
          bounds: [[20.7, 52.0], [21.3, 52.5]],
        })]);
      } else if (zoom < 14.2) {
        payload = collection([cluster({
          scope: 'local',
          label: 'Śródmieście',
          count: 2,
          bounds: [[20.98, 52.20], [21.06, 52.27]],
        })]);
      } else {
        payload = collection(range === '1y'
          ? [currentCase, emptyPoint]
          : [currentCase, historicalCase, emptyPoint]);
      }
      await fulfillJson(route, payload, { delayMs: mapDelayMs });
      return;
    }
    if (url.pathname.startsWith('/api/cases/') && url.pathname.endsWith('/context')) {
      await fulfillJson(route, {
        generated_by: 'deterministic',
        summary: 'Testowe podsumowanie danych urzędowych.',
        signals: ['Ta sama działka ma historię spraw.'],
        limitations: ['Dane nie potwierdzają realizacji inwestycji.'],
      }, { delayMs: contextDelayMs });
      return;
    }
    if (url.pathname.startsWith('/api/cases/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/cases/'.length));
      await fulfillJson(route, caseDetail(key));
      return;
    }
    if (url.pathname === '/api/suggestions') {
      await fulfillJson(route, []);
      return;
    }
    await fulfillJson(route, { error: 'not_found' }, { status: 404 });
  });
  return diagnostics;
}

async function drillDownToCases(page) {
  await expect(page.locator('#cases-heading')).toHaveText('Wybierz województwo');
  await page.getByRole('button', { name: 'Mazowieckie, 12 spraw' }).click();
  await expect(page.locator('#location-scope')).toHaveText('Mazowieckie');
  await expect(page.locator('#cases-heading')).toHaveText('Mazowieckie');
  await page.getByRole('button', { name: 'Warszawa i okolice, 8 spraw' }).click();
  await expect(page.locator('#cases-heading')).toHaveText('Powiaty na mapie');
  await page.getByRole('button', { name: 'Warszawa, 5 spraw' }).click();
  await expect(page.locator('#cases-heading')).toHaveText('Sprawy w okolicy');
  await page.getByRole('button', { name: 'Śródmieście, 2 spraw' }).click();
  await expect(page.locator('#cases-heading')).toHaveText('Sprawy na mapie');
  await expect(page.locator('.case-card')).toHaveCount(1);
}

test('hierarchia mapy, wybór działki i historia pozostają spójne', async ({ page }, testInfo) => {
  const diagnostics = await installDeterministicRoutes(page, { contextDelayMs: 500 });
  await page.goto(`${appOrigin()}/`);

  const mapBox = await page.locator('.map-card').boundingBox();
  const listBox = await page.locator('.cases-panel').boundingBox();
  expect(mapBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  if (testInfo.project.name.startsWith('mobile')) {
    expect(listBox.y).toBeGreaterThan(mapBox.y);
    expect(Math.abs(listBox.width - mapBox.width)).toBeLessThan(3);
  } else {
    expect(listBox.x).toBeGreaterThan(mapBox.x);
  }

  await drillDownToCases(page);
  const zooms = await page.evaluate(() => window.__mapTest.calls.easeTo.map((call) => call.zoom));
  expect(zooms).toEqual(expect.arrayContaining([7, 8.5, 10.5, 14.2]));

  const sourceFeatures = await page.evaluate(() => window.__mapTest.sourceData('cases').features);
  expect(sourceFeatures).toHaveLength(1);
  expect(sourceFeatures[0].properties.case_key).toBe('pozwolenie:current');

  await page.evaluate((feature) => {
    window.__mapTest.triggerLayer('click', 'case-points', feature);
  }, sourceFeatures[0]);
  const selected = page.locator('.case-card[data-case-id="pozwolenie:current"]');
  await expect(selected).toHaveClass(/is-selected/);
  await expect(selected.locator('.case-details')).toBeVisible();
  await expect(selected.locator('.case-title')).toHaveText('Budowa osiedla mieszkaniowego z zielonym dziedzińcem i garażem podziemnym');
  await expect(selected.locator('.case-card-button')).toBeFocused();
  const radarAction = selected.locator('.radar-action');
  await expect(radarAction).toBeEnabled();
  await radarAction.focus();
  await expect(radarAction).toBeFocused();
  const sourceLink = selected.locator('.source-link');
  await sourceLink.focus();
  await expect(selected.locator('.context-state')).toHaveText('Podsumowanie danych urzędowych');
  await expect(sourceLink).toBeFocused();

  await page.getByRole('button', { name: '3 lata' }).click();
  await expect(page.locator('.case-card')).toHaveCount(2);
  await expect(page.locator('.case-card[data-case-id="pozwolenie:history"]')).toContainText('historia');
  const fitBoundsBeforeHistory = await page.evaluate(() => window.__mapTest.calls.fitBounds.length);
  const requestCountBeforeHistory = diagnostics.mapRequests.length;
  await page.locator('.case-card[data-case-id="pozwolenie:history"] .case-card-button').click();
  const history = page.locator('.case-card[data-case-id="pozwolenie:history"]');
  await expect(history).toHaveClass(/is-selected/);
  await expect(history.locator('.case-details')).toBeVisible();
  await page.waitForTimeout(250);
  expect(diagnostics.mapRequests.length).toBe(requestCountBeforeHistory);
  expect(await page.evaluate(() => window.__mapTest.calls.fitBounds.length)).toBe(fitBoundsBeforeHistory);

  const resizeBefore = await page.evaluate(() => window.__mapTest.calls.resize);
  await page.locator('.map-card').evaluate((element) => { element.hidden = true; });
  await expect.poll(() => page.evaluate(() => window.__mapTest.calls.resize)).toBeGreaterThan(resizeBefore);
  const resizeWhileHidden = await page.evaluate(() => window.__mapTest.calls.resize);
  await page.locator('.map-card').evaluate((element) => { element.hidden = false; });
  await expect.poll(() => page.evaluate(() => window.__mapTest.calls.resize)).toBeGreaterThan(resizeWhileHidden);
  await expect(page.locator('#map canvas[data-map-ready="true"]')).toBeVisible();
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.unexpectedRequests).toEqual([]);
});

test('zimny start klienta mieści się w budżecie i nie blokuje interfejsu overlayem', async ({ page }, testInfo) => {
  const diagnostics = await installDeterministicRoutes(page, { mapDelayMs: 300 });
  const startedAt = Date.now();
  await page.goto(`${appOrigin()}/`, { waitUntil: 'domcontentloaded' });

  const mapBox = await page.locator('.map-card').boundingBox();
  const loadingBox = await page.locator('#map-loading').boundingBox();
  expect(mapBox).not.toBeNull();
  expect(loadingBox).not.toBeNull();
  expect(loadingBox.width).toBeLessThan(mapBox.width / 2);
  expect(loadingBox.height).toBeLessThan(mapBox.height / 2);
  await expect(page.locator('#map-loading')).toHaveCSS('pointer-events', 'none');

  await expect(page.locator('#cases-heading')).toHaveText('Wybierz województwo');
  await expect(page.locator('#map-loading')).toHaveAttribute('aria-hidden', 'true');
  const elapsedMs = Date.now() - startedAt;
  const coldStart = {
    schema_version: 'radar_e2e_client_shell_cold_start_v1',
    scenario: 'fresh_client_shell_no_cache',
    map_implementation: 'deterministic_stub',
    project: testInfo.project.name,
    viewport: page.viewportSize(),
    elapsed_ms: elapsedMs,
    budget_ms: COLD_START_BUDGET_MS,
    map_requests: diagnostics.mapRequests.length,
    heading: await page.locator('#cases-heading').textContent(),
    loading_hidden: await page.locator('#map-loading').getAttribute('aria-hidden'),
    contains_secrets: false,
  };
  await testInfo.attach('cold-start.json', {
    body: Buffer.from(`${JSON.stringify(coldStart, null, 2)}\n`),
    contentType: 'application/json',
  });
  expect(elapsedMs).toBeLessThanOrEqual(COLD_START_BUDGET_MS);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.unexpectedRequests).toEqual([]);
});

test('fallback Radaru zapisuje obserwację i odtwarza ją po odświeżeniu', async ({ page }) => {
  const diagnostics = await installDeterministicRoutes(page);
  await page.goto(`${appOrigin()}/`);
  await drillDownToCases(page);

  const card = page.locator('.case-card[data-case-id="pozwolenie:current"]');
  await card.locator('.case-card-button').click();
  await expect(card.locator('.case-details')).toBeVisible();
  await expect(card.locator('.radar-action')).toBeEnabled();
  await card.locator('.radar-action').click();
  await expect(page.locator('#radar-panel')).toBeVisible();
  await expect(page.locator('.radar-watch')).toContainText(parcelId);
  await expect(card.locator('.radar-action')).toHaveText('✓ Działka jest obserwowana');

  await page.reload();
  await expect(page.locator('#cases-heading')).toHaveText('Wybierz województwo');
  await page.locator('#radar-toggle').click();
  await expect(page.locator('#radar-panel')).toBeVisible();
  await expect(page.locator('.radar-watch')).toContainText(parcelId);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.unexpectedRequests).toEqual([]);
});

test('prawdziwy MapLibre obsługuje kliknięcie i tapnięcie punktu', async ({ page }, testInfo) => {
  const diagnostics = await installDeterministicRoutes(page, { realMap: true });
  const startedAt = Date.now();
  await page.goto(`${appOrigin()}/`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cases-heading')).toHaveText('Wybierz województwo');
  const elapsedMs = Date.now() - startedAt;
  expect(elapsedMs).toBeLessThanOrEqual(REAL_MAP_START_BUDGET_MS);

  await drillDownToCases(page);
  const canvas = page.locator('#map canvas.maplibregl-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(200);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (testInfo.project.name.startsWith('mobile')) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);

  const selected = page.locator('.case-card[data-case-id="pozwolenie:current"]');
  await expect(selected).toHaveClass(/is-selected/);
  await expect(selected.locator('.case-details')).toBeVisible();
  const realMapStart = {
    schema_version: 'radar_e2e_real_map_start_v1',
    scenario: 'fresh_context_pinned_maplibre_local_style',
    project: testInfo.project.name,
    elapsed_ms: elapsedMs,
    budget_ms: REAL_MAP_START_BUDGET_MS,
    maplibre_version: await page.evaluate(() => window.maplibregl.version),
    contains_secrets: false,
  };
  await testInfo.attach('real-map-start.json', {
    body: Buffer.from(`${JSON.stringify(realMapStart, null, 2)}\n`),
    contentType: 'application/json',
  });
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.unexpectedRequests).toEqual([]);
});
