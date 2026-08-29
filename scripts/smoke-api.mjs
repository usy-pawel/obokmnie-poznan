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

const overview = await get('/api/map?bbox=14,48.8,24.3,55.3&zoom=6');
assert.equal(overview.type, 'FeatureCollection');
assert.ok(overview.features.length > 0, 'country map is empty');
assert.ok(overview.features.every((feature) => feature.properties.cluster === true));

const poznan = await get('/api/map?bbox=16.7,52.25,17.15,52.6&zoom=12');
assert.equal(poznan.type, 'FeatureCollection');
assert.ok(poznan.features.length > 0, 'Poznań map is empty');
assert.ok(poznan.features.every((feature) => feature.properties.case_key));

const detail = await get(`/api/cases/${encodeURIComponent(poznan.features[0].properties.case_key)}`);
assert.equal(detail.case_key, poznan.features[0].properties.case_key);
assert.ok(Array.isArray(detail.parcels));

console.log(JSON.stringify({
  published_cases: meta.published_cases,
  voivodeships: meta.voivodeships,
  country_clusters: overview.features.length,
  poznan_cases: poznan.features.length,
  selected_parcels: detail.parcels.length,
}));
