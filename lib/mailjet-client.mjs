export const MAILJET_SEND_API_URL = 'https://api.mailjet.com/v3.1/send';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CUSTOM_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const CAMPAIGN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_RESPONSE_BYTES = 128 * 1024;

export class MailjetError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}

function requiredConfig(environment) {
  const config = {
    apiKey: String(environment.MAILJET_API_KEY || ''),
    secretKey: String(environment.MAILJET_SECRET_KEY || ''),
    fromEmail: String(environment.MAIL_FROM_EMAIL || ''),
    fromName: String(environment.MAIL_FROM_NAME || ''),
    replyToEmail: String(environment.MAIL_REPLY_TO_EMAIL || ''),
  };
  if (!config.apiKey || config.apiKey.length > 256
      || !config.secretKey || config.secretKey.length > 256
      || !validEmail(config.fromEmail)
      || !config.fromName || config.fromName.length > 100
      || !validEmail(config.replyToEmail)) {
    throw new MailjetError('mailjet_config_invalid');
  }
  return config;
}

export function mailjetConfigurationStatus(environment = process.env) {
  const enabled = environment.MAILJET_SEND_ENABLED === 'true';
  try {
    requiredConfig(environment);
    return Object.freeze({ configured: true, enabled });
  } catch {
    return Object.freeze({ configured: false, enabled });
  }
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new MailjetError('mailjet_message_invalid');
  }
  const keys = Object.keys(message).sort();
  const expected = message.campaignId === undefined
    ? ['customId', 'html', 'subject', 'text', 'to']
    : ['campaignId', 'customId', 'html', 'subject', 'text', 'to'];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    throw new MailjetError('mailjet_message_invalid');
  }
  if (!validEmail(message.to)
      || typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > 160
      || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 20_000
      || typeof message.html !== 'string' || !message.html.trim() || message.html.length > 50_000
      || typeof message.customId !== 'string' || !CUSTOM_ID.test(message.customId)
      || (message.campaignId !== undefined
        && (typeof message.campaignId !== 'string' || !CAMPAIGN_ID.test(message.campaignId)))) {
    throw new MailjetError('mailjet_message_invalid');
  }
  return {
    to: message.to,
    subject: message.subject.trim(),
    text: message.text,
    html: message.html,
    customId: message.customId,
    ...(message.campaignId ? { campaignId: message.campaignId } : {}),
  };
}

async function boundedJson(response) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new MailjetError('mailjet_response_invalid');
  }
  const reader = response.body?.getReader?.();
  let text;
  if (!reader) {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new MailjetError('mailjet_response_invalid');
    }
  } else {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MailjetError('mailjet_response_invalid');
      }
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks, total).toString('utf8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MailjetError('mailjet_response_invalid');
  }
}

function requestFailure(status) {
  if (status === 401 || status === 403) return new MailjetError('mailjet_auth_failed');
  if (status === 429) return new MailjetError('mailjet_rate_limited', { retryable: true });
  if (status >= 500) return new MailjetError('mailjet_unavailable', { retryable: true });
  return new MailjetError('mailjet_rejected');
}

export function createMailjetSender({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new MailjetError('mailjet_client_invalid');
  }

  return async function sendMailjetMessage(input) {
    if (environment.MAILJET_SEND_ENABLED !== 'true') throw new MailjetError('mailjet_disabled');
    const config = requiredConfig(environment);
    const message = normalizeMessage(input);
    const authorization = Buffer.from(`${config.apiKey}:${config.secretKey}`, 'utf8').toString('base64');
    let response;
    try {
      response = await fetchImpl(MAILJET_SEND_API_URL, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/json',
          authorization: `Basic ${authorization}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          Messages: [{
            From: { Email: config.fromEmail, Name: config.fromName },
            To: [{ Email: message.to }],
            ReplyTo: { Email: config.replyToEmail },
            Subject: message.subject,
            TextPart: message.text,
            HTMLPart: message.html,
            CustomID: message.customId,
            ...(message.campaignId ? {
              CustomCampaign: message.campaignId,
              DeduplicateCampaign: true,
            } : {}),
          }],
          AdvanceErrorHandling: true,
        }),
      });
    } catch (error) {
      if (error instanceof MailjetError) throw error;
      throw new MailjetError('mailjet_unavailable', { retryable: true });
    }

    if (!response || typeof response.ok !== 'boolean' || typeof response.status !== 'number') {
      throw new MailjetError('mailjet_response_invalid');
    }
    if (!response.ok) throw requestFailure(response.status);

    let payload;
    try {
      payload = await boundedJson(response);
    } catch (error) {
      if (error instanceof MailjetError) throw error;
      throw new MailjetError('mailjet_response_invalid');
    }
    const result = payload?.Messages?.[0];
    if (!result || result.Status !== 'success') throw new MailjetError('mailjet_rejected');
    const recipient = result.To?.[0] || {};
    const messageId = String(recipient.MessageID || '');
    const messageUuid = String(recipient.MessageUUID || '');
    if (!PROVIDER_ID.test(messageId) || !PROVIDER_ID.test(messageUuid)) {
      throw new MailjetError('mailjet_response_invalid');
    }
    return Object.freeze({
      accepted: true,
      customId: message.customId,
      messageId,
      messageUuid,
    });
  };
}
