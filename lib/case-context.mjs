import { createHash } from 'node:crypto';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    signals: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    limitations: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['summary', 'signals', 'limitations'],
};

function compactText(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim();
}

function differenceInDays(start, end) {
  if (!start || !end) return null;
  const startDate = new Date(`${String(start).slice(0, 10)}T12:00:00Z`);
  const endDate = new Date(`${String(end).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) return null;
  return Math.max(0, Math.round((endDate - startDate) / 86_400_000));
}

export function buildContextFacts(subject, nearby, relatedCases) {
  const sameParcelCases = Array.isArray(relatedCases) ? relatedCases : [];
  return {
    case: {
      type: subject.source_type,
      number: subject.external_id,
      received_date: subject.received_date,
      decision_date: subject.decision_date || null,
      days_to_decision: differenceInDays(subject.received_date, subject.decision_date),
      status: compactText(subject.status, 'brak statusu'),
      authority: compactText(subject.office),
      location: compactText(subject.address || subject.city || subject.voivodeship),
      investment_type: compactText(subject.case_kind),
      official_description: compactText(subject.description, 'Sprawa budowlana'),
      parcel_ids: subject.parcel_ids || [],
    },
    surroundings: {
      cases_within_250m: Number(nearby?.within_250m || 0),
      cases_within_1km: Number(nearby?.within_1km || 0),
      permits_within_1km: Number(nearby?.permits_within_1km || 0),
      notices_within_1km: Number(nearby?.notices_within_1km || 0),
      other_cases_on_same_parcel: Number(nearby?.same_parcel_count || sameParcelCases.length || 0),
      recent_same_parcel_cases: sameParcelCases.slice(0, 5).map((item) => ({
        type: item.source_type,
        received_date: item.received_date,
        status: compactText(item.status),
        description: compactText(item.description),
      })),
    },
  };
}

export function contextFingerprint(facts) {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

export function deterministicContext(facts) {
  const subject = facts.case;
  const surroundings = facts.surroundings;
  const type = subject.type === 'zgloszenie' ? 'zgłoszenia' : 'wniosku i decyzji';
  const timing = subject.decision_date
    ? `Decyzję odnotowano ${subject.decision_date}${subject.days_to_decision === null ? '' : `, ${subject.days_to_decision} dni po wpływie wniosku`}.`
    : 'Rejestr nie zawiera daty decyzji dla tej sprawy.';
  const signals = [timing];
  if (surroundings.other_cases_on_same_parcel) {
    signals.push(`Na tych samych działkach znaleziono ${surroundings.other_cases_on_same_parcel} innych spraw w bieżącym zakresie danych.`);
  }
  signals.push(`W promieniu 1 km widocznych jest ${surroundings.cases_within_1km} innych spraw, w tym ${surroundings.permits_within_1km} pozwoleń i ${surroundings.notices_within_1km} zgłoszeń.`);
  return {
    summary: `To wpis z rejestru ${type} dotyczący: ${subject.official_description}`,
    signals: signals.slice(0, 3),
    limitations: [
      'Wpis nie potwierdza rozpoczęcia ani zakończenia budowy.',
      'Dane o sąsiedztwie pokazują inne sprawy urzędowe, a nie pewne inwestycje.',
    ],
  };
}

export function parseResponseContext(payload) {
  const raw = payload?.output_text || payload?.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === 'output_text')?.text;
  if (!raw) throw new Error('OpenAI response did not contain output text');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.signals) || !Array.isArray(parsed.limitations)) {
    throw new Error('OpenAI response did not match the case context schema');
  }
  return {
    summary: compactText(parsed.summary).slice(0, 600),
    signals: parsed.signals.map((item) => compactText(item)).filter(Boolean).slice(0, 3),
    limitations: parsed.limitations.map((item) => compactText(item)).filter(Boolean).slice(0, 3),
  };
}

export async function generateAiContext(facts, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const model = options.model || process.env.OPENAI_CONTEXT_MODEL || 'gpt-5.6-luna';
  const baseUrl = options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  if (baseUrl !== 'https://api.openai.com/v1') throw new Error('OPENAI_BASE_URL must be https://api.openai.com/v1');
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: 'none' },
      max_output_tokens: 450,
      instructions: [
        'Objaśniasz po polsku publiczne dane o sprawie budowlanej.',
        'Używaj wyłącznie faktów z przekazanego JSON. Nie wyszukuj i nie dopowiadaj informacji.',
        'Nie identyfikuj właściciela ani inwestora. Nie twierdź, że inwestycja powstanie, ruszyła lub została ukończona.',
        'Status decyzji oznacza wyłącznie wpis urzędowy; nie przesądza ostateczności ani realizacji.',
        'Podaj krótkie podsumowanie, do trzech istotnych sygnałów i do trzech ograniczeń interpretacji.',
      ].join(' '),
      input: JSON.stringify(facts),
      text: {
        format: {
          type: 'json_schema',
          name: 'case_context',
          strict: true,
          schema: OUTPUT_SCHEMA,
        },
      },
    }),
    signal: AbortSignal.timeout(Number(options.timeoutMs || 25_000)),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 180)}`);
  }
  return { context: parseResponseContext(await response.json()), model };
}
