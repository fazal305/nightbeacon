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
  // Google Gemini's OpenAI-compatible endpoint. Free key (no card) at
  // https://aistudio.google.com/apikey — a much larger free allowance than
  // Groq's, so it's a good fallback: DRAFT_LLM_PROVIDER=groq,gemini.
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-flash-latest,gemini-2.5-flash,gemini-2.0-flash',
    label: 'Gemini',
  },
  // Cerebras: free tier, very fast. Key at https://cloud.cerebras.ai
  cerebras: {
    url: 'https://api.cerebras.ai/v1/chat/completions',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    modelEnv: 'CEREBRAS_MODEL',
    defaultModel: 'llama-3.3-70b,llama3.1-8b',
    label: 'Cerebras',
  },
  // Mistral: free "Experiment" plan. Key at https://console.mistral.ai
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    apiKeyEnv: 'MISTRAL_API_KEY',
    modelEnv: 'MISTRAL_MODEL',
    defaultModel: 'mistral-small-latest,open-mistral-nemo',
    label: 'Mistral',
  },
  // GitHub Models: free with a GitHub token (Settings → Developer settings →
  // Personal access tokens → fine-grained, permission "Models: read").
  github: {
    url: 'https://models.github.ai/inference/chat/completions',
    apiKeyEnv: 'GITHUB_MODELS_TOKEN',
    modelEnv: 'GITHUB_MODELS_MODEL',
    defaultModel: 'openai/gpt-4.1-mini,openai/gpt-4o-mini,meta/Llama-3.3-70B-Instruct',
    label: 'GitHub Models',
  },
  // NVIDIA NIM: free developer access. Key at https://build.nvidia.com
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKeyEnv: 'NVIDIA_API_KEY',
    modelEnv: 'NVIDIA_MODEL',
    defaultModel: 'meta/llama-3.3-70b-instruct,meta/llama-3.1-8b-instruct',
    label: 'NVIDIA',
  },
  // SambaNova Cloud: free tier. Key at https://cloud.sambanova.ai
  sambanova: {
    url: 'https://api.sambanova.ai/v1/chat/completions',
    apiKeyEnv: 'SAMBANOVA_API_KEY',
    modelEnv: 'SAMBANOVA_MODEL',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct,Meta-Llama-3.1-8B-Instruct',
    label: 'SambaNova',
  },
  // Cohere: free trial key (1,000 calls a month) at https://dashboard.cohere.com
  cohere: {
    url: 'https://api.cohere.ai/compatibility/v1/chat/completions',
    apiKeyEnv: 'COHERE_API_KEY',
    modelEnv: 'COHERE_MODEL',
    defaultModel: 'command-a-03-2025,command-r-08-2024',
    label: 'Cohere',
  },
  // Cloudflare Workers AI: same account ID and token as the translator
  // (daily free allowance shared with it).
  cloudflare: {
    url: () => `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    extraEnv: ['CLOUDFLARE_ACCOUNT_ID'],
    modelEnv: 'CLOUDFLARE_LLM_MODEL',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/meta/llama-3.1-8b-instruct',
    label: 'Cloudflare',
  },
  // Hugging Face inference router: same HF_TOKEN as the translator (small
  // monthly free credit).
  huggingface: {
    url: 'https://router.huggingface.co/v1/chat/completions',
    apiKeyEnv: 'HF_TOKEN',
    modelEnv: 'HF_LLM_MODEL',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct,Qwen/Qwen2.5-72B-Instruct',
    label: 'Hugging Face',
  },
  // Pollinations: free, no key at all — slow and rate-limited, so it is the
  // last resort that keeps drafting going when every quota is spent.
  pollinations: {
    url: 'https://text.pollinations.ai/openai',
    apiKeyEnv: null,
    modelEnv: 'POLLINATIONS_MODEL',
    defaultModel: 'openai,mistral',
    label: 'Pollinations',
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
  return status === 429 && /per ?day|TPD|RPD|free-models-per-day/i.test(body);
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
// A provider that can't take the request right now (out of its free
// allowance, request too large for it, unreachable, no key): try the next.
export function isProviderUnavailable(err) {
  return /rate limit|429|413|402|\((401|403|5\d\d)\)|quota|credits|returned no content|unavailable|not configured|every configured model|not a valid model|no endpoints found|fetch failed|timeout|aborted|ECONN/i.test(err?.message || '');
}

// `providerName` may be a list, e.g. "groq,gemini": providers are tried in
// order and the next one takes over when one is unavailable. `model`
// applies to the first provider; the others use their own model setting.
export async function callLLM(messages, opts = {}) {
  const names = String(opts.providerName || process.env.LLM_PROVIDER || 'groq')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  let lastError = null;
  for (let i = 0; i < names.length; i++) {
    try {
      return await callProvider(messages, { ...opts, providerName: names[i], model: i === 0 ? opts.model : undefined });
    } catch (err) {
      lastError = err;
      if (i === names.length - 1 || !isProviderUnavailable(err)) throw err;
      console.warn(`[llm] ${names[i]} unavailable (${err.message.slice(0, 80)}) — using ${names[i + 1]}`);
    }
  }
  throw lastError;
}

async function callProvider(
  messages,
  { providerName = process.env.LLM_PROVIDER || 'groq', temperature = 0.2, model: modelOverride } = {}
) {
  providerName = providerName.toLowerCase();
  const provider = PROVIDERS[providerName];

  if (!provider) {
    throw new Error(`Unknown LLM provider "${providerName}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : null;
  const models = String(modelOverride || process.env[provider.modelEnv] || provider.defaultModel || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const missingExtra = (provider.extraEnv || []).some((name) => !process.env[name]);
  if ((provider.apiKeyEnv && !apiKey) || missingExtra || models.length === 0) {
    throw new Error(`${[provider.apiKeyEnv, ...(provider.extraEnv || []), provider.modelEnv].filter(Boolean).join(' / ')} not configured`);
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
      } else if (err.status === 404 || /decommissioned|model_not_found|does not exist|not a valid model|no endpoints found/i.test(err.message)) {
        modelBlockedUntil.set(key, Infinity);
        console.warn(`[llm] model "${model}" is not available on ${provider.label} — skipping it`);
      } else {
        throw err;
      }
    }
  }
  // Every model is out of its daily allowance or doesn't exist ("rate limit"
  // / "unavailable" lets callLLM move on to the next provider).
  if (lastError && !lastError.dailyLimit && lastError.status !== 413) {
    throw new Error(`${provider.label} unavailable: none of the configured models can be used (${lastError.message.slice(0, 120)})`);
  }
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

// Whether a provider has what it needs (key and model) to be tried at all.
export function providerConfigured(name) {
  const provider = PROVIDERS[String(name).toLowerCase()];
  if (!provider) return false;
  if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) return false;
  if ((provider.extraEnv || []).some((env) => !process.env[env])) return false;
  return Boolean(process.env[provider.modelEnv] || provider.defaultModel);
}
