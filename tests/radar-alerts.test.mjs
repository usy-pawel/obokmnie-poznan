import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RADAR_ALERT_CONTENT_VERSION,
  alertMessage,
  dispatchRadarAlerts,
  startRadarAlertDispatcher,
} from '../lib/radar-alerts.mjs';

const environment = Object.freeze({ RADAR_PUBLIC_ORIGIN: 'https://www.radarzmian.pl' });
const input = Object.freeze({
  alertId: '12',
  eventId: '42',
  email: 'User@Example.com',
  eventType: 'changed',
  changedFields: ['status', 'address', 'status', 'unknown'],
  snapshot: { case_key: 'pozwolenie:123/ABC', address: 'ul. Testowa 1' },
  contentVersion: RADAR_ALERT_CONTENT_VERSION,
});

test('alert message has stable identifiers and safe case and management links', () => {
  const message = alertMessage(input, environment);
  assert.equal(message.to, 'user@example.com');
  assert.equal(message.customId, 'alert:12:radar_alert_v1');
  assert.equal(message.campaignId, 'rza_radar_alert_v1_42');
  assert.match(message.subject, /Zmiana w sprawie/);
  assert.match(message.text, /Zmieniły się: status, adres\./);
  assert.match(message.text, /https:\/\/www\.radarzmian\.pl\/sprawa\/pozwolenie%3A123%2FABC/);
  assert.match(message.text, /https:\/\/www\.radarzmian\.pl\/\?radar=1/);
});

test('alert HTML escapes source data and rejects incomplete database rows', () => {
  const message = alertMessage({
    ...input,
    snapshot: { case_key: 'case:<safe>', address: '<img src=x onerror=alert(1)>' },
  }, environment);
  assert.doesNotMatch(message.html, /<img/u);
  assert.match(message.html, /&lt;img/);
  assert.throws(() => alertMessage({ ...input, eventId: 'not-an-id' }, environment), /invalid/);
  assert.throws(() => alertMessage({ ...input, snapshot: {} }, environment), /invalid/);
});

test('disabled dispatcher does not touch the database', async () => {
  let queries = 0;
  const result = await dispatchRadarAlerts({
    database: { query: async () => { queries += 1; } },
    mailSender: null,
  });
  assert.deepEqual(result, { enabled: false, claimed: 0, sent: 0, retried: 0, failed: 0 });
  assert.equal(queries, 0);
  assert.doesNotThrow(() => startRadarAlertDispatcher({ database: {}, mailSender: null })());
});
