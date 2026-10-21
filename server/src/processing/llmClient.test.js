import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM, isDailyLimit, stripThinking } from './llmClient.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const { model } = JSON.parse(init.body);
    calls.push(model);
    const [status, body] = handler(model);
    return {
      ok: status === 200,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return calls;
}
const answer = (text) => [200, JSON.stringify({ choices: [{ message: { content: text } }] })];

test('llm: a model at its daily limit is skipped for the next one, and stays skipped', async () => {
  process.env.GROQ_API_KEY = 'k';
  const calls = fakeFetch((model) =>
    model === 'tired-a' ? [429, '{"error":{"message":"Rate limit reached for model tired-a on tokens per day (TPD)"}}'] : answer(`from ${model}`)
  );
  const r1 = await callLLM([], { providerName: 'groq', model: 'tired-a, fresh-b' });
  assert.deepEqual([r1.content, r1.model], ['from fresh-b', 'fresh-b']);
  await callLLM([], { providerName: 'groq', model: 'tired-a,fresh-b' });
  assert.deepEqual(calls, ['tired-a', 'fresh-b', 'fresh-b'], 'exhausted model not retried within the hour');
});

test('llm: a request too large for one model\'s per-minute limit goes to the next model', async () => {
  process.env.GROQ_API_KEY = 'k';
  const calls = fakeFetch((model) => (model === 'small-tpm' ? [413, 'Request too large ... tokens per minute (TPM): Limit 8000'] : answer('ok')));
  const r = await callLLM([], { providerName: 'groq', model: 'small-tpm,big-tpm' });
  assert.equal(r.model, 'big-tpm');
  await callLLM([], { providerName: 'groq', model: 'small-tpm,big-tpm' });
  assert.deepEqual(calls, ['small-tpm', 'big-tpm', 'small-tpm', 'big-tpm'], 'not set aside: smaller requests still fit');
});

test('llm: unknown models are skipped; a per-minute 429 is not treated as daily; all exhausted -> rate limit error', async () => {
  process.env.GROQ_API_KEY = 'k';
  fakeFetch((model) => (model === 'gone-x' ? [404, 'model_not_found'] : [429, 'rate limit tokens per minute (TPM)']));
  await assert.rejects(callLLM([], { providerName: 'groq', model: 'gone-x,busy-y' }), /429/);
  fakeFetch(() => [429, 'Rate limit reached on requests per day (RPD)']);
  await assert.rejects(callLLM([], { providerName: 'groq', model: 'day-1,day-2' }), /rate limit/i);
  assert.equal(isDailyLimit(429, 'tokens per minute (TPM)'), false);
  assert.equal(stripThinking('<think>plan</think>\n\nPost text'), 'Post text');
});

test('llm: a list of providers falls through to the next when one is out of allowance', async () => {
  process.env.GROQ_API_KEY = 'k';
  process.env.GEMINI_API_KEY = 'g';
  const hosts = [];
  globalThis.fetch = async (url, init) => {
    hosts.push(new URL(url).hostname);
    const { model } = JSON.parse(init.body);
    const groq = url.includes('groq');
    return {
      ok: !groq,
      status: groq ? 429 : 200,
      text: async () => 'Rate limit reached on tokens per day (TPD)',
      json: async () => ({ choices: [{ message: { content: `from ${model}` } }] }),
    };
  };
  const r = await callLLM([], { providerName: 'groq,gemini', model: 'groq-only-model' });
  assert.equal(r.content, 'from gemini-flash-latest', 'gemini uses its own default model, not the groq override');
  assert.deepEqual(hosts, ['api.groq.com', 'generativelanguage.googleapis.com']);
  delete process.env.GEMINI_API_KEY;
});

test('llm: OpenRouter-style "not a valid model" ids are skipped', async () => {
  process.env.OPENROUTER_API_KEY = 'o';
  globalThis.fetch = async (url, init) => {
    const { model } = JSON.parse(init.body);
    const bad = model === 'gone/model:free';
    return {
      ok: !bad,
      status: bad ? 400 : 200,
      text: async () => '{"error":{"message":"gone/model:free is not a valid model ID"}}',
      json: async () => ({ choices: [{ message: { content: `from ${model}` } }] }),
    };
  };
  const r = await callLLM([], { providerName: 'openrouter', model: 'gone/model:free,good/model:free' });
  assert.equal(r.content, 'from good/model:free');
});

test('llm: a provider whose models all do not exist hands over to the next provider', async () => {
  process.env.GEMINI_API_KEY = 'g';
  process.env.OPENROUTER_API_KEY = 'o';
  process.env.OPENROUTER_MODEL = 'free/model:free';
  globalThis.fetch = async (url) => {
    const gemini = url.includes('googleapis');
    return {
      ok: !gemini,
      status: gemini ? 404 : 200,
      text: async () => 'models/x is not found for API version v1beta',
      json: async () => ({ choices: [{ message: { content: 'from openrouter' } }] }),
    };
  };
  const r = await callLLM([], { providerName: 'gemini,openrouter' });
  assert.equal(r.content, 'from openrouter');
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_MODEL;
});
