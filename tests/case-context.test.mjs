import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContextFacts,
  contextFingerprint,
  deterministicContext,
  generateAiContext,
  parseResponseContext,
} from '../lib/case-context.mjs';

const subject = {
  source_type: 'wniosek_decyzja',
  external_id: 'TEST/123',
  received_date: '2026-01-01',
  decision_date: '2026-01-31',
  status: 'decyzja wydana',
  office: 'Urząd testowy',
  voivodeship: 'wielkopolskie',
  city: 'Poznań',
  address: 'Testowa 1, Poznań',
  case_kind: 'Budowa',
  description: 'Budowa budynku mieszkalnego',
  parcel_ids: ['306401_1.0001.1/2'],
};

test('case context facts are deterministic and distinguish official dates from surroundings', () => {
  const facts = buildContextFacts(subject, {
    within_250m: 3,
    within_1km: 12,
    permits_within_1km: 9,
    notices_within_1km: 3,
    same_parcel_count: 1,
  }, [{ source_type: 'zgloszenie', received_date: '2025-12-01', status: 'Brak sprzeciwu', description: 'Sieć' }]);
  assert.equal(facts.case.days_to_decision, 30);
  assert.equal(facts.surroundings.other_cases_on_same_parcel, 1);
  assert.equal(contextFingerprint(facts), contextFingerprint(structuredClone(facts)));
  const fallback = deterministicContext(facts);
  assert.match(fallback.summary, /Budowa budynku mieszkalnego/);
  assert.match(fallback.signals.join(' '), /30 dni/);
  assert.match(fallback.limitations.join(' '), /nie potwierdza/);
});

test('OpenAI output parser accepts output_text and limits list length', () => {
  const parsed = parseResponseContext({
    output_text: JSON.stringify({
      summary: ' Krótkie   wyjaśnienie ',
      signals: ['A', 'B', 'C', 'D'],
      limitations: ['X'],
    }),
  });
  assert.equal(parsed.summary, 'Krótkie wyjaśnienie');
  assert.deepEqual(parsed.signals, ['A', 'B', 'C']);
});

test('OpenAI request uses Luna, structured output and does not store the response', async () => {
  const facts = buildContextFacts(subject, {}, []);
  let requestBody;
  const generated = await generateAiContext(facts, {
    apiKey: 'test-key-not-a-secret',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ summary: 'Podsumowanie', signals: ['Sygnał'], limitations: ['Ograniczenie'] }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(requestBody.model, 'gpt-5.6-luna');
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.reasoning.effort, 'none');
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(generated.context.summary, 'Podsumowanie');
});
