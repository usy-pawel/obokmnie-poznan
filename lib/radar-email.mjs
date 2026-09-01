import { createHmac } from 'node:crypto';
import { domainToASCII } from 'node:url';

export const RADAR_EMAIL_REQUEST_VERSION = 'radar_email_request_v1';
export const RADAR_EMAIL_STATUS_VERSION = 'radar_email_status_v1';
export const RADAR_EMAIL_CONFIRM_VERSION = 'radar_email_confirm_v1';
export const RADAR_SERVICE_CONSENT_VERSION = 'radar_alerts_service_pl_v1';
export const RADAR_MARKETING_CONSENT_VERSION = 'radar_marketing_pl_v1';
export const RADAR_SERVICE_CONSENT_TEXT = 'Chcę otrzymywać e-maile o zmianach w monitorowanych miejscach. Wiem, że mogę zrezygnować w każdej chwili.';
export const RADAR_MARKETING_CONSENT_TEXT = 'Chcę też otrzymywać informacje o nowościach i ofertach RadarZmian.pl (opcjonalnie).';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOCAL_PART = /^[^\s@\u0000-\u001f\u007f]{1,64}$/u;
const DOMAIN = /^(?=.{1,189}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class RadarEmailError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function normalizeRadarEmail(value) {
  if (typeof value !== 'string') throw new RadarEmailError('invalid_email_request');
  const candidate = value.trim().normalize('NFC');
  const separator = candidate.lastIndexOf('@');
  if (separator < 1 || separator !== candidate.indexOf('@')) throw new RadarEmailError('invalid_email_request');
  const local = candidate.slice(0, separator).toLocaleLowerCase('en-US');
  const domain = domainToASCII(candidate.slice(separator + 1).toLocaleLowerCase('en-US'));
  const normalized = `${local}@${domain}`;
  if (normalized.length > 254 || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) {
    throw new RadarEmailError('invalid_email_request');
  }
  return normalized;
}

export function normalizeEmailRequest(body) {
  if (!exactObject(body, [
    'version', 'email', 'service_consent', 'service_consent_version',
    'marketing_consent', 'marketing_consent_version',
  ])
      || body.version !== RADAR_EMAIL_REQUEST_VERSION
      || body.service_consent !== true
      || body.service_consent_version !== RADAR_SERVICE_CONSENT_VERSION
      || typeof body.marketing_consent !== 'boolean'
      || body.marketing_consent_version !== RADAR_MARKETING_CONSENT_VERSION) {
    throw new RadarEmailError('invalid_email_request');
  }
  return Object.freeze({ email: normalizeRadarEmail(body.email), marketingConsent: body.marketing_consent });
}

export function normalizeConfirmation(body) {
  if (!exactObject(body, ['version', 'token'])
      || body.version !== RADAR_EMAIL_CONFIRM_VERSION
      || typeof body.token !== 'string'
      || !TOKEN.test(body.token)) throw new RadarEmailError('confirmation_invalid');
  return body.token;
}

export function normalizeMarketingPreference(body) {
  if (!exactObject(body, ['version', 'marketing_consent', 'marketing_consent_version'])
      || body.version !== RADAR_EMAIL_REQUEST_VERSION
      || typeof body.marketing_consent !== 'boolean'
      || body.marketing_consent_version !== RADAR_MARKETING_CONSENT_VERSION) {
    throw new RadarEmailError('invalid_email_request');
  }
  return body.marketing_consent;
}

function fingerprintKey(environment) {
  const encoded = String(environment.RADAR_EMAIL_HASH_KEY || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new RadarEmailError('email_service_unavailable');
  return Buffer.from(encoded, 'base64url');
}

export function emailFingerprint(email, environment = process.env) {
  return createHmac('sha256', fingerprintKey(environment)).update(normalizeRadarEmail(email)).digest();
}

export function maskEmail(email) {
  const normalized = normalizeRadarEmail(email);
  const [local, domain] = normalized.split('@');
  return `${local.slice(0, 1)}${local.length > 1 ? '***' : '*'}@${domain}`;
}

export function radarPublicOrigin(environment) {
  const value = String(environment.RADAR_PUBLIC_ORIGIN || 'https://www.radarzmian.pl');
  let url;
  try { url = new URL(value); } catch { throw new RadarEmailError('email_service_unavailable'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.pathname !== '/'
      || url.username || url.password || url.search || url.hash) {
    throw new RadarEmailError('email_service_unavailable');
  }
  return url.origin;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function confirmationMessage({ email, token, customId }, environment = process.env) {
  const normalizedEmail = normalizeRadarEmail(email);
  if (!TOKEN.test(token) || !/^[A-Za-z0-9_.:-]{1,100}$/.test(customId)) {
    throw new RadarEmailError('email_service_unavailable');
  }
  const url = `${radarPublicOrigin(environment)}/potwierdz-email#token=${encodeURIComponent(token)}`;
  const safeUrl = escapeHtml(url);
  return Object.freeze({
    to: normalizedEmail,
    subject: 'Potwierdź adres e-mail w RadarZmian.pl',
    text: `Potwierdź adres e-mail, aby otrzymywać powiadomienia o monitorowanych miejscach:\n\n${url}\n\nLink jest ważny przez 24 godziny. Jeśli to nie Ty, zignoruj tę wiadomość.`,
    html: `<p>Potwierdź adres e-mail, aby otrzymywać powiadomienia o monitorowanych miejscach.</p><p><a href="${safeUrl}">Potwierdź adres e-mail</a></p><p>Link jest ważny przez 24 godziny. Jeśli to nie Ty, zignoruj tę wiadomość.</p>`,
    customId,
  });
}
