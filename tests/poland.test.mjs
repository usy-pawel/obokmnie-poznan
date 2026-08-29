import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [server, migration, integrityMigration, cityIndexMigration, frontend, html, importer, migrateScript] = await Promise.all([
  readFile(new URL('../server.js', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/003_data_integrity.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/004_exact_city_index.sql', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/import-poland-postgis.py', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/migrate.mjs', import.meta.url), 'utf8'),
]);

test('PostGIS schema keeps cases, parcels and their exact relationships', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS postgis/);
  assert.match(migration, /geometry\(Point, 4326\)/);
  assert.match(migration, /geometry\(MultiPolygon, 4326\)/);
  assert.match(migration, /PRIMARY KEY \(case_id, parcel_id\)/);
  assert.match(migration, /USING gist \(location\)/);
  assert.match(integrityMigration, /voivodeship_teryt_code/);
  assert.match(integrityMigration, /ST_MakeValid/);
  assert.match(integrityMigration, /parcels_geom_valid/);
  assert.match(importer, /voivodeship_teryt_code/);
  assert.match(cityIndexMigration, /lower\(city\)/);
  assert.match(migrateScript, /pg_advisory_lock/);
});

test('API exposes health, overview, search and case detail routes', () => {
  for (const route of ['/health', '/api/meta', '/api/map', '/api/search', '/api/suggestions', '/api/cases/:caseKey']) {
    assert.ok(server.includes(`'${route}'`), `missing ${route}`);
  }
  assert.match(server, /ST_MakeEnvelope/);
  assert.match(server, /ST_SnapToGrid/);
  assert.match(server, /params\.slice\(0, 5\)/);
  assert.match(server, /exact_city/);
  assert.match(server, /parcel_count/);
  assert.match(server, /NOT ST_IsEmpty/);
  assert.match(server, /LIMIT 7/);
  assert.match(server, /to_char\(c\.received_date,'YYYY-MM-DD'\)/);
});

test('country frontend loads data by viewport and parcel detail on demand', () => {
  assert.match(html, /Co budują w Polsce/);
  assert.match(html, /Cała Polska/);
  assert.match(frontend, /\/api\/map/);
  assert.match(frontend, /\/api\/cases\//);
  assert.match(frontend, /selected-parcels/);
  assert.match(frontend, /ORTOFOTOMAPA/);
  assert.match(frontend, /baseLayer: 'streets'/);
  assert.match(frontend, /scrollSelectedCard/);
  assert.match(frontend, /detail\?\.parcels/);
  assert.match(frontend, /loadSuggestions/);
  assert.match(frontend, /aria-activedescendant/);
  assert.match(html, /data-base-layer="streets" aria-pressed="true"/);
  assert.match(html, /role="combobox"/);
  assert.doesNotMatch(frontend, /wielkopolska-cases\.geojson/);
});
