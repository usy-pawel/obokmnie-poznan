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

const suggestions = await get('/api/suggestions?q=poz');
assert.ok(suggestions.length > 0 && suggestions.length <= 7, 'invalid suggestion count');
assert.ok(suggestions.every((item) => ['city', 'voivodeship'].includes(item.kind)));
assert.ok(suggestions.every((item) => item.label && item.context));

const overview = await get('/api/map?bbox=14,48.8,24.3,55.3&zoom=6');
assert.equal(overview.type, 'FeatureCollection');
assert.equal(overview.features.length, 16, 'country map should show 16 voivodeships');
assert.ok(overview.features.every((feature) => feature.properties.cluster === true));
assert.ok(overview.features.every((feature) => feature.properties.cluster_scope === 'voivodeship'));
assert.ok(overview.features.every((feature) => feature.properties.label && feature.properties.bounds.length === 4));

const wielkopolskie = overview.features.find((feature) => feature.properties.region === 'wielkopolskie');
assert.ok(wielkopolskie, 'Wielkopolskie is missing from country overview');
const provinceBbox = wielkopolskie.properties.bounds.join(',');
const provinceAreas = await get(`/api/map?bbox=${provinceBbox}&zoom=8&region=wielkopolskie`);
assert.ok(provinceAreas.features.length > 0, 'Wielkopolskie powiat map is empty');
assert.ok(provinceAreas.features.every((feature) => feature.properties.cluster_scope === 'powiat'));
assert.ok(provinceAreas.features.every((feature) => feature.properties.label.startsWith('30')));

const poznan = await get('/api/map?bbox=16.7,52.25,17.15,52.6&zoom=12');
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
  voivodeships: meta.voivodeships,
  country_clusters: overview.features.length,
  wielkopolska_powiaty: provinceAreas.features.length,
  poznan_cases: poznan.features.length,
  selected_parcels: detail.parcels.length,
  suggestions: suggestions.length,
}));
