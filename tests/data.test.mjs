import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const parcelsFile = new URL('../public/data/poznan-parcels.geojson', import.meta.url);
const casesFile = new URL('../public/data/poznan-cases.geojson', import.meta.url);
const metricsFile = new URL('../public/data/poznan-build-metrics.json', import.meta.url);
const parcels = JSON.parse(await readFile(parcelsFile, 'utf8'));
const cases = JSON.parse(await readFile(casesFile, 'utf8'));
const metrics = JSON.parse(await readFile(metricsFile, 'utf8'));

function allPoints(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
}

test('publishes all 833 exact Poznań cases as unique points', () => {
  assert.equal(cases.type, 'FeatureCollection');
  assert.equal(cases.features.length, 833);
  assert.equal(new Set(cases.features.map((feature) => feature.properties.case_id)).size, 833);
  assert.ok(cases.features.every((feature) => feature.geometry.type === 'Point'));
  assert.ok(cases.features.every((feature) => feature.properties.location_quality === 'dokładny'));
});

test('publishes more than 1,800 exact ULDK parcel geometries', () => {
  assert.equal(parcels.type, 'FeatureCollection');
  assert.ok(parcels.features.length > 1800, `only ${parcels.features.length} parcel geometries`);
  assert.ok(new Set(parcels.features.map((feature) => feature.properties.case_id)).size > 750);
});

test('parcel geometries use supported types and stay within the Poznań control region', () => {
  for (const feature of parcels.features) {
    assert.match(feature.geometry.type, /^(?:Polygon|MultiPolygon)$/);
    assert.equal(feature.properties.location_quality, 'dokładny');
    assert.match(feature.properties.case_id, /(WNIOSEK|ZGŁOSZENIE)/);
    for (const [longitude, latitude] of allPoints(feature.geometry)) {
      assert.ok(longitude >= 16.65 && longitude <= 17.25, `longitude ${longitude}`);
      assert.ok(latitude >= 52.2 && latitude <= 52.62, `latitude ${latitude}`);
    }
  }
});

test('every public case contains required fields', () => {
  for (const feature of cases.features) {
    for (const key of ['received_date', 'status', 'description', 'address', 'parcel_ids', 'gunb_url']) {
      assert.ok(feature.properties[key], `${feature.id} is missing ${key}`);
    }
  }
});

test('build metrics agree with generated collections', () => {
  assert.equal(metrics.published_cases, cases.features.length);
  assert.equal(metrics.parcel_geometries_published, parcels.features.length);
  assert.equal(metrics.eligible_exact_cases, 833);
  assert.ok(metrics.parcel_ids_resolved > 1600);
});

test('static data remains small enough for the city T-MVP', async () => {
  const parcelSize = (await stat(parcelsFile)).size;
  const caseSize = (await stat(casesFile)).size;
  assert.ok(parcelSize < 8_000_000, `parcel GeoJSON is ${parcelSize} bytes`);
  assert.ok(caseSize < 1_500_000, `case GeoJSON is ${caseSize} bytes`);
});
