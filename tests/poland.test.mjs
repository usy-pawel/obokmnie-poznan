import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [server, serviceHealth, migration, integrityMigration, cityIndexMigration, contextMigration, historyIndexMigration, radarMigration, serverRadarMigration, publicationHistoryMigration, radarSubscriptions, frontend, html, styles, importer, migrateScript] = await Promise.all([
  readFile(new URL('../server.js', import.meta.url), 'utf8'),
  readFile(new URL('../lib/service-health.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/003_data_integrity.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/004_exact_city_index.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/006_case_contexts.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/007_history_range_indexes.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/009_change_radar.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/011_server_radar.sql', import.meta.url), 'utf8'),
  readFile(new URL('../migrations/012_case_publication_history.sql', import.meta.url), 'utf8'),
  readFile(new URL('../lib/radar-subscriptions.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
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
  assert.match(contextMigration, /CREATE TABLE IF NOT EXISTS case_contexts/);
  assert.match(contextMigration, /source_fingerprint/);
  assert.match(historyIndexMigration, /cases_published_received_date_idx/);
  assert.match(historyIndexMigration, /cases_published_voivodeship_date_idx/);
  assert.match(radarMigration, /CREATE TABLE IF NOT EXISTS case_events/);
  assert.match(radarMigration, /CREATE TRIGGER cases_change_radar/);
  assert.match(radarMigration, /snapshot->'parcel_ids'/);
  assert.match(serverRadarMigration, /match_parcel_ids/);
  assert.match(serverRadarMigration, /radar_project_import/);
  assert.match(serverRadarMigration, /radar_backfill_watch/);
  assert.match(serverRadarMigration, /radar_purge_expired_profiles/);
  assert.match(serverRadarMigration, /radar_recover_missing_projections/);
  assert.match(serverRadarMigration, /radar_charge_global_rate/);
  assert.match(serverRadarMigration, /pg_advisory_xact_lock/);
  assert.match(publicationHistoryMigration, /ever_published/);
  assert.doesNotMatch(publicationHistoryMigration, /UPDATE cases\s+SET ever_published/);
  assert.match(publicationHistoryMigration, /OLD\.published/);
  assert.match(publicationHistoryMigration, /preserve_case_publication_history/);
  assert.match(importer, /OBOKMNIE_PERIOD_START/);
  assert.match(importer, /OBOKMNIE_SKIP_ULDK/);
  assert.match(importer, /Oczekiwano 18 archiwów GUNB/);
  assert.match(importer, /DELETE FROM case_parcels cp USING cases c/);
  assert.ok(
    importer.indexOf('refs = stage.execute') < importer.indexOf('UPDATE cases SET location=NULL,published=false'),
    'publication should switch only after all historical links are loaded',
  );
});

test('API exposes health, private maintenance, public case, overview, search, radar, detail and lazy context routes', () => {
  for (const route of ['/health', '/sprawa/:caseKey', '/api/data-status', '/api/internal/maintenance/preflight', '/api/meta', '/api/map', '/api/search', '/api/suggestions', '/api/radar', '/api/cases/:caseKey', '/api/cases/:caseKey/context']) {
    assert.ok(server.includes(`'${route}'`), `missing ${route}`);
  }
  assert.match(server, /ST_MakeEnvelope/);
  assert.match(server, /cluster_scope: 'voivodeship'/);
  assert.match(server, /ST_ClusterKMeans\(location, 8\)/);
  assert.match(server, /ST_ClusterKMeans\(location, 12\)/);
  assert.match(server, /cluster_scope: 'local'/);
  assert.match(server, /!query && !region/);
  assert.match(server, /min\(left\(cp\.parcel_id,4\)\) AS powiat/);
  assert.match(server, /VOIVODESHIPS/);
  assert.match(server, /c\.voivodeship=\$6/);
  assert.match(server, /params\.slice\(0, 5\)/);
  assert.match(server, /exact_city/);
  assert.match(server, /parcel_count/);
  assert.match(server, /NOT ST_IsEmpty/);
  assert.match(server, /LIMIT 7/);
  assert.match(server, /to_char\(c\.received_date,'YYYY-MM-DD'\)/);
  assert.match(server, /contextInFlight/);
  assert.match(server, /OPENAI_API_KEY/);
  assert.match(server, /createRadarSubscriptionsRouter/);
  assert.match(server, /case_withdrawn/);
  assert.match(server, /ever_published \? 410 : 404/);
  assert.match(server, /RADAR_SERVER_ENABLED === '1'/);
  assert.match(radarSubscriptions, /__Host-radar_profile/);
  assert.match(radarSubscriptions, /__Host-radar_csrf/);
  assert.match(radarSubscriptions, /Cache-Control', 'no-store/);
  assert.match(radarSubscriptions, /RADAR_LIMITS/);
  assert.match(server, /other_cases_on_same_parcel|same_parcel_count/);
  assert.match(server, /DATE_RANGES/);
  assert.match(server, /make_interval\(months=>/);
  assert.match(server, /AS historical/);
  assert.match(serviceHealth, /FORTY_EIGHT_HOURS_MS/);
  assert.match(serviceHealth, /last_success/);
  assert.match(importer, /seed_existing_parcels/);
  assert.match(importer, /case_fingerprint/);
  assert.match(importer, /set_config\('obokmnie\.import_id'/);
  assert.match(importer, /radar_watch_projection/);
  assert.match(importer, /radar_project_import/);
  assert.match(importer, /run_radar_housekeeping/);
  assert.match(importer, /finished_at=clock_timestamp\(\)/);
  assert.doesNotMatch(importer, /cursor\.executemany\(upsert_case, values\)\s+connection\.commit\(\)/);
  assert.match(importer, /source_active=false/);
  assert.match(importer, /validate_publication/);
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
  assert.match(frontend, /RADAR_STORAGE_KEY/);
  assert.match(frontend, /watchSelectedParcels/);
  assert.match(html, /id="radar-panel"/);
  assert.match(html, /class="radar-action"/);
  assert.match(frontend, /loadCaseContext/);
  assert.match(frontend, /publicCasePath/);
  assert.match(frontend, /navigator\.share/);
  assert.match(frontend, /caseKeyFromPath/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /name="robots" content="index,follow"/);
  assert.match(server, /content="noindex,follow"/);
  assert.match(html, /data-case-control="share"/);
  assert.match(html, /id="empty-state" role="status" aria-live="polite"/);
  assert.match(server, /case sensitive routing/);
  assert.match(frontend, /Kontekst jest chwilowo niedostępny/);
  assert.doesNotMatch(frontend, /W promieniu 250 m|W promieniu 1 km/);
  assert.match(frontend, /loadSuggestions/);
  assert.match(frontend, /aria-activedescendant/);
  assert.match(frontend, /renderProvinceChoices/);
  assert.match(frontend, /renderClusterChoices/);
  assert.match(frontend, /cameraForBounds/);
  assert.match(frontend, /state\.requestController === controller/);
  assert.doesNotMatch(styles, /\.map-loading\s*\{[^}]*inset:\s*0/s);
  assert.match(styles, /\.map-loading\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(html, /data-base-layer="streets" aria-pressed="true"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /Kontekst sprawy i działki/);
  assert.match(html, /data-range="3y"/);
  assert.match(html, /data-range="all"/);
  assert.match(frontend, /range: '1y'/);
  assert.match(frontend, /params\.set\('range', state\.range\)/);
  const rangeHandler = frontend.slice(
    frontend.indexOf('ui.rangeButtons.forEach'),
    frontend.indexOf("ui.search.addEventListener('input'"),
  );
  assert.doesNotMatch(rangeHandler, /lastFittedQuery/);
  assert.match(frontend, /is-historical/);
  assert.doesNotMatch(frontend, /wielkopolska-cases\.geojson/);
});
