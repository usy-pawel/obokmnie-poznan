import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [server, migration, frontend, html] = await Promise.all([
  readFile(new URL('../server.js', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
]);

test('PostGIS schema keeps cases, parcels and their exact relationships', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS postgis/);
  assert.match(migration, /geometry\(Point, 4326\)/);
  assert.match(migration, /geometry\(MultiPolygon, 4326\)/);
  assert.match(migration, /PRIMARY KEY \(case_id, parcel_id\)/);
  assert.match(migration, /USING gist \(location\)/);
});

test('API exposes health, overview, search and case detail routes', () => {
  for (const route of ['/health', '/api/meta', '/api/map', '/api/search', '/api/cases/:caseKey']) {
    assert.ok(server.includes(`'${route}'`), `missing ${route}`);
  }
  assert.match(server, /ST_MakeEnvelope/);
  assert.match(server, /ST_SnapToGrid/);
  assert.match(server, /params\.slice\(0, 5\)/);
});

test('country frontend loads data by viewport and parcel detail on demand', () => {
  assert.match(html, /Co budują w Polsce/);
  assert.match(html, /Cała Polska/);
  assert.match(frontend, /\/api\/map/);
  assert.match(frontend, /\/api\/cases\//);
  assert.match(frontend, /selected-parcels/);
  assert.match(frontend, /ORTOFOTOMAPA/);
  assert.doesNotMatch(frontend, /wielkopolska-cases\.geojson/);
});
