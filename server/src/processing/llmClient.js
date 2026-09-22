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
};

// The application must keep functioning if the LLM provider is unavailable —
// callers catch this and mark the item failed_translation (or revert to
// 'new' for systemic/quota failures), they never crash.
export async function callLLM(messages) {
  const providerName = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
  const provider = PROVIDERS[providerName];

  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER "${providerName}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const apiKey = process.env[provider.apiKeyEnv];
  const model = process.env[provider.modelEnv];

  if (!apiKey || !model) {
    throw new Error(`${provider.apiKeyEnv} / ${provider.modelEnv} not configured`);
  }

  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0.2 }),
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
