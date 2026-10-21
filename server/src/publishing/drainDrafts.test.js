import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerLoop } from './drainDrafts.js';
import { providerConfigured, isProviderUnavailable } from '../processing/llmClient.js';

test('drafting drain: a provider drafts until the queue is empty, resting when it is out of allowance', async () => {
  const queue = [[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]];
  const ctx = { config: {}, stop: false, total: 0, stats: {}, deadline: Date.now() + 60_000 };
  let calls = 0;
  await providerLoop('gemini', ctx, {
    claim: async () => (queue.length ? [queue.shift()] : []),
    draft: async (group, _config, { providerName }) => {
      assert.equal(providerName, 'gemini');
      calls++;
      if (calls === 1) return { results: [{ id: group[0].id, outcome: 'failed' }], systemic: true };
      return { results: [{ id: group[0].id, outcome: 'approved' }], systemic: false };
    },
    restMs: 0,
    pacingMs: 0,
  });
  assert.equal(ctx.total, 2);
  assert.equal(ctx.stats.gemini.state, 'finished');
  assert.equal(ctx.stop, true);
});

test('free LLM providers: keyless Pollinations is always usable, others need their keys', () => {
  assert.equal(providerConfigured('pollinations'), true);
  const saved = { ...process.env };
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = 'x';
  assert.equal(providerConfigured('cloudflare'), false);
  process.env.CLOUDFLARE_ACCOUNT_ID = 'abc';
  assert.equal(providerConfigured('cloudflare'), true);
  assert.equal(providerConfigured('nope'), false);
  process.env = saved;
  // A bad key or a server error moves on to the next provider.
  assert.equal(isProviderUnavailable(new Error('GitHub Models request failed (401): bad credentials')), true);
  assert.equal(isProviderUnavailable(new Error('NVIDIA request failed (503): busy')), true);
});
