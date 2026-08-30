import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response.json();
}

const health = await get('/health');
assert.equal(health.ok, true);
assert.equal(health.database, true);

const meta = await get('/api/meta');
assert.ok(meta.published_cases > 0, 'no published cases');
assert.ok(meta.voivodeships > 0, 'no voivodeships');
assert.equal(meta.range, '1y');

const historicalMeta = await get('/api/meta?range=all');
assert.equal(historicalMeta.range, 'all');
assert.ok(historicalMeta.published_cases >= meta.published_cases, 'historical range is smaller than default');

const suggestions = await get('/api/suggestions?q=poz');
assert.ok(suggestions.length > 0 && suggestions.length <= 7, 'invalid suggestion count');
assert.ok(suggestions.every((item) => ['city', 'voivodeship'].includes(item.kind)));
assert.ok(suggestions.every((item) => item.label && item.context));

const radar = await get('/api/radar');
assert.deepEqual(radar.events, []);

let radarProfileSmoke = false;
if (process.env.SMOKE_EXPECT_RADAR_SERVER === '1') {
  const response = await fetch(`${baseUrl}/api/radar/profile`);
  assert.equal(response.status, 401, `radar profile smoke returned ${response.status}`);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.match(response.headers.get('vary') || '', /Cookie/);
  assert.deepEqual(await response.json(), { error: 'profile_unavailable' });
  radarProfileSmoke = true;
}

const overview = await get('/api/map?bbox=14,48.8,24.3,55.3&zoom=6');
assert.equal(overview.type, 'FeatureCollection');
assert.equal(overview.features.length, 16, 'country map should show 16 voivodeships');
assert.ok(overview.features.every((feature) => feature.properties.cluster === true));
assert.ok(overview.features.every((feature) => feature.properties.cluster_scope === 'voivodeship'));
assert.ok(overview.features.every((feature) => feature.properties.label && feature.properties.bounds.length === 4));

const historicalOverview = await get('/api/map?bbox=14,48.8,24.3,55.3&zoom=6&range=all');
assert.equal(historicalOverview.features.length, 16, 'historical country map should show 16 voivodeships');

const wielkopolskie = overview.features.find((feature) => feature.properties.region === 'wielkopolskie');
assert.ok(wielkopolskie, 'Wielkopolskie is missing from country overview');
const provinceBbox = wielkopolskie.properties.bounds.join(',');
const provinceAreas = await get(`/api/map?bbox=${provinceBbox}&zoom=7&region=wielkopolskie`);
assert.ok(provinceAreas.features.length > 0, 'Wielkopolskie powiat map is empty');
assert.ok(provinceAreas.features.length <= 8, 'province overview has too many areas');
assert.ok(provinceAreas.features.every((feature) => feature.properties.cluster_scope === 'area'));
const areaBbox = provinceAreas.features[0].properties.bounds.join(',');
const powiatAreas = await get(`/api/map?bbox=${areaBbox}&zoom=8.6&region=wielkopolskie`);
assert.ok(powiatAreas.features.length > 0, 'powiat map is empty');
assert.ok(powiatAreas.features.every((feature) => feature.properties.cluster_scope === 'powiat'));
assert.ok(powiatAreas.features.every((feature) => feature.properties.label.startsWith('Powiat 30')));
const powiatBbox = powiatAreas.features[0].properties.bounds.join(',');
const localAreas = await get(`/api/map?bbox=${powiatBbox}&zoom=10.5&region=wielkopolskie`);
assert.ok(localAreas.features.length > 0 && localAreas.features.length <= 12, 'invalid local groups');
assert.ok(localAreas.features.every((feature) => feature.properties.cluster_scope === 'local'));

const poznan = await get('/api/map?bbox=16.7,52.25,17.15,52.6&zoom=14.2');
assert.equal(poznan.type, 'FeatureCollection');
assert.ok(poznan.features.length > 0, 'Poznań map is empty');
assert.ok(poznan.features.every((feature) => feature.properties.case_key));
assert.ok(poznan.features.every((feature) => feature.properties.parcel_count > 0));

const detail = await get(`/api/cases/${encodeURIComponent(poznan.features[0].properties.case_key)}`);
assert.equal(detail.case_key, poznan.features[0].properties.case_key);
assert.ok(Array.isArray(detail.parcels));
assert.ok(detail.parcels.length > 0, 'selected case has no parcel geometry');

console.log(JSON.stringify({
  published_cases: meta.published_cases,
  historical_cases: historicalMeta.published_cases,
  voivodeships: meta.voivodeships,
  country_clusters: overview.features.length,
  wielkopolska_areas: provinceAreas.features.length,
  area_powiaty: powiatAreas.features.length,
  local_groups: localAreas.features.length,
  poznan_cases: poznan.features.length,
  selected_parcels: detail.parcels.length,
  suggestions: suggestions.length,
  radar_events: radar.events.length,
  radar_profile_smoke: radarProfileSmoke,
}));
