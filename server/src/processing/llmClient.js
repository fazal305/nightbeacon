// Both providers speak the same OpenAI-compatible chat-completions shape,
// so one function handles either — only the base URL, key, and model differ.
// Selected via LLM_PROVIDER so switching providers is a config change, not a
// code change (this is exactly what let Nightbeacon move off OpenRouter's
// exhausted 50-req/day free-tier cap onto Groq's far more generous one
// without touching translate.js at all).
const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    apiKeyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    label: 'Groq',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    label: 'OpenRouter',
  },
  // Local, free, no API key: Ollama's OpenAI-compatible endpoint
  // (`ollama pull qwen2.5:7b`, then OLLAMA_MODEL=qwen2.5:7b).
  ollama: {
    url: () => `${(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/v1/chat/completions`,
    apiKeyEnv: null,
    modelEnv: 'OLLAMA_MODEL',
    label: 'Ollama',
  },
};

// The application must keep functioning if the LLM provider is unavailable —
// callers catch this and mark the item failed_translation (or revert to
// 'new' for systemic/quota failures), they never crash.
//
// `providerName` lets a stage use its own provider (e.g. drafting via
// DRAFT_LLM_PROVIDER) independently of LLM_PROVIDER.
export async function callLLM(messages, { providerName = process.env.LLM_PROVIDER || 'groq', temperature = 0.2 } = {}) {
  providerName = providerName.toLowerCase();
  const provider = PROVIDERS[providerName];

  if (!provider) {
    throw new Error(`Unknown LLM provider "${providerName}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : null;
  const model = process.env[provider.modelEnv];

  if ((provider.apiKeyEnv && !apiKey) || !model) {
    throw new Error(`${[provider.apiKeyEnv, provider.modelEnv].filter(Boolean).join(' / ')} not configured`);
  }

  const body = { model, messages, temperature };
  // Groq's open-weight "reasoning" models (gpt-oss family) spend a large
  // share of their token budget on an internal chain-of-thought trace by
  // default — measured ~260 reasoning tokens for a one-sentence translation,
  // more than the actual answer. A task like translation doesn't need heavy
  // reasoning; capping effort to "low" cut total tokens per call by ~60%
  // (389 -> 162 measured) with identical output quality, which matters a lot
  // against Groq's per-minute token ceiling at real ingestion volume.
  if (providerName === 'groq' && model.includes('gpt-oss')) {
    body.reasoning_effort = 'low';
  }

  const url = typeof provider.url === 'function' ? provider.url() : provider.url;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 120000)),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${provider.label} request failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${provider.label} returned no content`);
  }
  return { content, model };
}
