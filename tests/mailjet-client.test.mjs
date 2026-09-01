import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAILJET_SEND_API_URL,
  createMailjetSender,
  mailjetConfigurationStatus,
} from '../lib/mailjet-client.mjs';

const environment = Object.freeze({
  MAILJET_API_KEY: 'test-public-key',
  MAILJET_SECRET_KEY: 'test-private-key',
  MAIL_FROM_EMAIL: 'kontakt@radarzmian.pl',
  MAIL_FROM_NAME: 'RadarZmian.pl',
  MAIL_REPLY_TO_EMAIL: 'kontakt@radarzmian.pl',
  MAILJET_SEND_ENABLED: 'true',
});

const message = Object.freeze({
  to: 'odbiorca@example.com',
  subject: 'Potwierdź monitoring',
  text: 'Potwierdź adres.',
  html: '<p>Potwierdź adres.</p>',
  customId: 'confirm:profile-123',
});

test('configuration status exposes no credentials and keeps sending behind a separate gate', () => {
  assert.deepEqual(mailjetConfigurationStatus(environment), { configured: true, enabled: true });
  assert.deepEqual(mailjetConfigurationStatus({ ...environment, MAILJET_SEND_ENABLED: 'false' }), {
    configured: true,
    enabled: false,
  });
  assert.deepEqual(mailjetConfigurationStatus({ MAILJET_API_KEY: 'partial' }), {
    configured: false,
    enabled: false,
  });
  assert.doesNotMatch(JSON.stringify(mailjetConfigurationStatus(environment)), /test-public|test-private/);
});

test('disabled sender performs no request', async () => {
  let calls = 0;
  const send = createMailjetSender({
    environment: { ...environment, MAILJET_SEND_ENABLED: 'false' },
    fetchImpl: async () => { calls += 1; },
  });
  await assert.rejects(send(message), /mailjet_disabled/);
  assert.equal(calls, 0);
});

test('sender uses the fixed v3.1 endpoint, bounded payload and inspects per-message success', async () => {
  let request;
  const send = createMailjetSender({
    environment,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        Messages: [{
          Status: 'success',
          To: [{ MessageID: '123', MessageUUID: 'uuid-123' }],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(await send(message), {
    accepted: true,
    customId: 'confirm:profile-123',
    messageId: '123',
    messageUuid: 'uuid-123',
  });
  assert.equal(request.url, MAILJET_SEND_API_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal(
    request.options.headers.authorization,
    `Basic ${Buffer.from('test-public-key:test-private-key').toString('base64')}`,
  );
  assert.deepEqual(JSON.parse(request.options.body), {
    Messages: [{
      From: { Email: 'kontakt@radarzmian.pl', Name: 'RadarZmian.pl' },
      To: [{ Email: 'odbiorca@example.com' }],
      ReplyTo: { Email: 'kontakt@radarzmian.pl' },
      Subject: 'Potwierdź monitoring',
      TextPart: 'Potwierdź adres.',
      HTMLPart: '<p>Potwierdź adres.</p>',
      CustomID: 'confirm:profile-123',
    }],
    AdvanceErrorHandling: true,
  });
});

test('alert campaign asks Mailjet to deduplicate one recipient within a stable campaign', async () => {
  let payload;
  const send = createMailjetSender({
    environment,
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        Messages: [{
          Status: 'success',
          To: [{ MessageID: '456', MessageUUID: 'uuid-456' }],
        }],
      }), { status: 200 });
    },
  });
  await send({ ...message, customId: 'alert:1:radar_alert_v1', campaignId: 'rza_radar_alert_v1_42' });
  assert.equal(payload.Messages[0].CustomCampaign, 'rza_radar_alert_v1_42');
  assert.equal(payload.Messages[0].DeduplicateCampaign, true);
});

test('invalid messages and partial Mailjet failures fail closed without leaking provider details', async () => {
  let calls = 0;
  const invalid = createMailjetSender({
    environment,
    fetchImpl: async () => { calls += 1; },
  });
  await assert.rejects(invalid({ ...message, email: 'extra@example.com' }), /mailjet_message_invalid/);
  assert.equal(calls, 0);

  const rejected = createMailjetSender({
    environment,
    fetchImpl: async () => new Response(JSON.stringify({
      Messages: [{
        Status: 'error',
        Errors: [{ ErrorMessage: 'recipient odbiorca@example.com api test-private-key' }],
      }],
    }), { status: 200 }),
  });
  await assert.rejects(
    rejected(message),
    (error) => error.code === 'mailjet_rejected'
      && !/odbiorca|test-private/.test(error.message),
  );
});

test('request failures have stable retry classification and no raw response body', async () => {
  for (const [status, code, retryable] of [
    [401, 'mailjet_auth_failed', false],
    [429, 'mailjet_rate_limited', true],
    [503, 'mailjet_unavailable', true],
    [400, 'mailjet_rejected', false],
  ]) {
    const send = createMailjetSender({
      environment,
      fetchImpl: async () => new Response('secret provider detail', { status }),
    });
    await assert.rejects(send(message), (error) => (
      error.code === code && error.retryable === retryable && !/secret/.test(error.message)
    ));
  }
});

test('oversized provider responses are rejected before parsing', async () => {
  const send = createMailjetSender({
    environment,
    fetchImpl: async () => new Response('x'.repeat(129 * 1024), { status: 200 }),
  });
  await assert.rejects(send(message), /mailjet_response_invalid/);
});

test('success without a bounded provider receipt is rejected', async () => {
  const send = createMailjetSender({
    environment,
    fetchImpl: async () => new Response(JSON.stringify({
      Messages: [{ Status: 'success', To: [{}] }],
    }), { status: 200 }),
  });
  await assert.rejects(send(message), /mailjet_response_invalid/);
});

test('transport errors are retryable but never expose their message', async () => {
  const send = createMailjetSender({
    environment,
    fetchImpl: async () => { throw new Error('socket failed with test-private-key'); },
  });
  await assert.rejects(send(message), (error) => (
    error.code === 'mailjet_unavailable'
      && error.retryable === true
      && !/socket|test-private/.test(error.message)
  ));
});
