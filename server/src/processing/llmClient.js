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

// Groq's free limits are counted per model (the 429 names the model), so a
// stage can list several models — "a,b,c" — and spread its work over all
// their daily allowances: a model that hits a per-day limit is set aside for
// an hour, one that doesn't exist (404 / decommissioned) for the process.
const DAILY_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const modelBlockedUntil = new Map(); // "provider:model" -> timestamp

export function isDailyLimit(status, body) {
  return status === 429 && /per day|TPD|RPD|free-models-per-day/i.test(body);
}

// Reasoning models (e.g. qwen3) may prefix the answer with <think>…</think>.
export function stripThinking(content) {
  return content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

// The application must keep functioning if the LLM provider is unavailable —
// callers catch this and mark the item failed_translation (or revert to
// 'new' for systemic/quota failures), they never crash.
//
// `providerName` lets a stage use its own provider (e.g. drafting via
// DRAFT_LLM_PROVIDER) independently of LLM_PROVIDER; `model` overrides the
// provider's model env (one id or a comma-separated list).
export async function callLLM(
  messages,
  { providerName = process.env.LLM_PROVIDER || 'groq', temperature = 0.2, model: modelOverride } = {}
) {
  providerName = providerName.toLowerCase();
  const provider = PROVIDERS[providerName];

  if (!provider) {
    throw new Error(`Unknown LLM provider "${providerName}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : null;
  const models = String(modelOverride || process.env[provider.modelEnv] || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  if ((provider.apiKeyEnv && !apiKey) || models.length === 0) {
    throw new Error(`${[provider.apiKeyEnv, provider.modelEnv].filter(Boolean).join(' / ')} not configured`);
  }

  let lastError = null;
  for (const model of models) {
    const key = `${providerName}:${model}`;
    if ((modelBlockedUntil.get(key) || 0) > Date.now()) continue;
    try {
      return await callModel(provider, providerName, apiKey, model, messages, temperature);
    } catch (err) {
      lastError = err;
      if (err.dailyLimit) {
        modelBlockedUntil.set(key, Date.now() + DAILY_LIMIT_COOLDOWN_MS);
        if (models.length > 1) console.warn(`[llm] ${model} reached its daily limit — using the next model for an hour`);
      } else if (err.status === 413) {
        // This request is bigger than the model's per-minute token limit
        // (e.g. 8k TPM): no point waiting, a model with a larger limit may take it.
        if (models.length > 1) console.warn(`[llm] request too large for ${model} — trying the next model`);
      } else if (err.status === 404 || /decommissioned|model_not_found|does not exist/i.test(err.message)) {
        modelBlockedUntil.set(key, Infinity);
        console.warn(`[llm] model "${model}" is not available on ${provider.label} — skipping it`);
      } else {
        throw err;
      }
    }
  }
  // Every model is out of its daily allowance ("rate limit" marks it systemic).
  throw lastError || new Error(`${provider.label} rate limit: every configured model reached its daily limit`);
}

async function callModel(provider, providerName, apiKey, model, messages, temperature) {
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
    const text = await res.text().catch(() => '');
    const err = new Error(`${provider.label} request failed (${res.status}): ${text.slice(0, 200)}`);
    err.status = res.status;
    err.dailyLimit = isDailyLimit(res.status, text);
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${provider.label} returned no content`);
  }
  return { content: stripThinking(content), model };
}
