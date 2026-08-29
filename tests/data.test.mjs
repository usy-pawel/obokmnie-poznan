import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import test from 'node:test';

const dataDirectory = new URL('../public/data/', import.meta.url);
const parcelDirectory = new URL('../public/data/wielkopolska-parcels/', import.meta.url);
const casesFile = new URL('wielkopolska-cases.geojson', dataDirectory);
const manifestFile = new URL('wielkopolska-parcel-manifest.json', dataDirectory);
const metricsFile = new URL('wielkopolska-build-metrics.json', dataDirectory);
const cases = JSON.parse(await readFile(casesFile, 'utf8'));
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const metrics = JSON.parse(await readFile(metricsFile, 'utf8'));

function allPoints(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
}

test('publishes a province-scale collection of unique exact cases', () => {
  assert.equal(cases.type, 'FeatureCollection');
  assert.equal(cases.features.length, metrics.published_cases);
  assert.ok(cases.features.length > 10_000, `only ${cases.features.length} cases`);
  assert.equal(new Set(cases.features.map((feature) => feature.properties.case_id)).size, cases.features.length);
  assert.ok(cases.features.every((feature) => feature.geometry.type === 'Point'));
  assert.ok(cases.features.every((feature) => feature.properties.location_quality === 'dokładny'));
});

test('parcel manifest describes every generated shard', async () => {
  const files = (await readdir(parcelDirectory)).filter((name) => name.endsWith('.geojson')).sort();
  const manifestFiles = Object.values(manifest.shards).map((item) => item.url.split('/').at(-1)).sort();
  assert.deepEqual(files, manifestFiles);
  assert.equal(files.length, metrics.parcel_shards);
  assert.ok(files.length > 20);
});

test('parcel geometries remain inside the Wielkopolska control region', async () => {
  let geometryCount = 0;
  for (const [shardId, info] of Object.entries(manifest.shards)) {
    const collection = JSON.parse(await readFile(new URL(`${shardId}.geojson`, parcelDirectory), 'utf8'));
    assert.equal(collection.features.length, info.features);
    geometryCount += collection.features.length;
    for (const feature of collection.features) {
      assert.match(feature.geometry.type, /^(?:Polygon|MultiPolygon)$/);
      assert.equal(feature.properties.location_quality, 'dokładny');
      assert.equal(feature.properties.parcel_shard, shardId);
      for (const [longitude, latitude] of allPoints(feature.geometry)) {
        assert.ok(longitude >= 15.5 && longitude <= 19.2, `longitude ${longitude}`);
        assert.ok(latitude >= 50.8 && latitude <= 53.7, `latitude ${latitude}`);
      }
    }
  }
  assert.equal(geometryCount, metrics.parcel_geometries_published);
});

test('every public case contains required fields and an existing parcel shard', () => {
  for (const feature of cases.features) {
    for (const key of ['received_date', 'status', 'description', 'address', 'city', 'parcel_ids', 'gunb_url', 'parcel_shard']) {
      assert.ok(feature.properties[key], `${feature.id} is missing ${key}`);
    }
    assert.ok(manifest.shards[feature.properties.parcel_shard], `${feature.id} references a missing shard`);
  }
});

test('build metrics agree with generated collections', () => {
  assert.equal(metrics.published_cases, cases.features.length);
  assert.ok(metrics.unique_cases >= metrics.published_cases);
  assert.equal(metrics.parcel_ids_requested, metrics.parcel_ids_resolved + metrics.parcel_ids_failed + metrics.parcel_ids_outside_control);
  assert.ok(metrics.source_type_counts.wniosek_decyzja > 0);
  assert.ok(metrics.source_type_counts.zgloszenie > 0);
});

test('regional data is split into mobile-friendly static files', async () => {
  assert.ok((await stat(casesFile)).size < 20_000_000);
  assert.ok((await stat(manifestFile)).size < 200_000);
  assert.ok(metrics.largest_shard_bytes < 8_000_000, `largest shard is ${metrics.largest_shard_bytes} bytes`);
});
