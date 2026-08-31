import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RADAR_EMAIL_CONFIRM_VERSION, RADAR_EMAIL_REQUEST_VERSION,
  RADAR_MARKETING_CONSENT_VERSION, RADAR_SERVICE_CONSENT_VERSION,
  confirmationMessage, emailFingerprint, maskEmail, normalizeConfirmation,
  normalizeEmailRequest, normalizeMarketingPreference, normalizeRadarEmail,
} from '../lib/radar-email.mjs';

const environment = Object.freeze({
  RADAR_EMAIL_HASH_KEY: Buffer.alloc(32, 7).toString('base64url'),
  RADAR_PUBLIC_ORIGIN: 'https://www.radarzmian.pl',
});

function request(overrides = {}) {
  return {
    version: RADAR_EMAIL_REQUEST_VERSION,
    email: ' Osoba@Przykład.pl ',
    service_consent: true,
    service_consent_version: RADAR_SERVICE_CONSENT_VERSION,
    marketing_consent: false,
    marketing_consent_version: RADAR_MARKETING_CONSENT_VERSION,
    ...overrides,
  };
}

test('email request requires exact, versioned service and separate marketing choices', () => {
  assert.deepEqual(normalizeEmailRequest(request()), { email: 'osoba@xn--przykad-rjb.pl', marketingConsent: false });
  assert.equal(normalizeEmailRequest(request({ marketing_consent: true })).marketingConsent, true);
  assert.throws(() => normalizeEmailRequest(request({ service_consent: false })), /invalid_email_request/);
  assert.throws(() => normalizeEmailRequest({ ...request(), newsletter: true }), /invalid_email_request/);
  assert.throws(() => normalizeEmailRequest(request({ marketing_consent: 'false' })), /invalid_email_request/);
});

test('email normalization is bounded and rejects ambiguous addresses', () => {
  assert.equal(normalizeRadarEmail('User+tag@Example.COM'), 'user+tag@example.com');
  for (const invalid of ['', 'a@localhost', 'a@@example.com', 'a b@example.com', `${'a'.repeat(65)}@example.com`]) {
    assert.throws(() => normalizeRadarEmail(invalid), /invalid_email_request/);
  }
});

test('fingerprint is keyed, deterministic and changes with the secret', () => {
  const first = emailFingerprint('USER@example.com', environment);
  const same = emailFingerprint('user@example.com', environment);
  const other = emailFingerprint('user@example.com', {
    ...environment, RADAR_EMAIL_HASH_KEY: Buffer.alloc(32, 8).toString('base64url'),
  });
  assert.equal(first.length, 32);
  assert.deepEqual(first, same);
  assert.notDeepEqual(first, other);
  assert.throws(() => emailFingerprint('user@example.com', {}), /email_service_unavailable/);
});

test('confirmation token is exact, single-purpose and 32-byte base64url', () => {
  const token = Buffer.alloc(32, 1).toString('base64url');
  assert.equal(normalizeConfirmation({ version: RADAR_EMAIL_CONFIRM_VERSION, token }), token);
  assert.throws(() => normalizeConfirmation({ version: RADAR_EMAIL_CONFIRM_VERSION, token: `${token}x` }), /confirmation_invalid/);
  assert.throws(() => normalizeConfirmation({ version: RADAR_EMAIL_CONFIRM_VERSION, token, email: 'x@example.com' }), /confirmation_invalid/);
});

test('marketing preference can change independently without resubmitting the email', () => {
  assert.equal(normalizeMarketingPreference({
    version: RADAR_EMAIL_REQUEST_VERSION,
    marketing_consent: false,
    marketing_consent_version: RADAR_MARKETING_CONSENT_VERSION,
  }), false);
  assert.throws(() => normalizeMarketingPreference({
    version: RADAR_EMAIL_REQUEST_VERSION, marketing_consent: true,
  }), /invalid_email_request/);
});

test('status masking and confirmation content do not expose more address data', () => {
  assert.equal(maskEmail('jan.kowalski@example.com'), 'j***@example.com');
  const token = Buffer.alloc(32, 2).toString('base64url');
  const message = confirmationMessage({ email: 'user@example.com', token, customId: 'confirm:123' }, environment);
  assert.equal(message.to, 'user@example.com');
  assert.match(message.text, new RegExp(`/potwierdz-email#token=${token}`));
  assert.match(message.html, /ważny przez 24 godziny/);
  assert.doesNotMatch(message.html, /user@example\.com/);
  assert.throws(() => confirmationMessage(
    { email: 'user@example.com', token, customId: 'confirm:123' },
    { ...environment, RADAR_PUBLIC_ORIGIN: 'http://radarzmian.pl' },
  ), /email_service_unavailable/);
});
