import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const file = new URL('../public/data/strzeszyn-parcels.geojson', import.meta.url);
const data = JSON.parse(await readFile(file, 'utf8'));

function allPoints(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
}

test('contains eight parcel geometries for six unique cases', () => {
  assert.equal(data.type, 'FeatureCollection');
  assert.equal(data.features.length, 8);
  assert.equal(new Set(data.features.map((feature) => feature.properties.case_id)).size, 6);
});

test('all features are exact ULDK polygons inside the Strzeszyn control extent', () => {
  for (const feature of data.features) {
    assert.match(feature.geometry.type, /^(?:Polygon|MultiPolygon)$/);
    assert.equal(feature.properties.location_quality, 'dokładny');
    assert.match(feature.properties.parcel_id, /^306401_1\./);
    assert.match(feature.properties.case_id, /(WNIOSEK|ZGŁOSZENIE)/);
    for (const [longitude, latitude] of allPoints(feature.geometry)) {
      assert.ok(longitude >= 16.82 && longitude <= 16.89, `longitude ${longitude}`);
      assert.ok(latitude >= 52.44 && latitude <= 52.48, `latitude ${latitude}`);
    }
  }
});

test('every feature contains the public-facing fields', () => {
  for (const feature of data.features) {
    for (const key of ['received_date', 'status', 'description', 'address', 'parcel_id', 'gunb_url']) {
      assert.ok(feature.properties[key], `${feature.id} is missing ${key}`);
    }
  }
});
