// Multilingual sentence embeddings for cross-language duplicate detection,
// computed from the ORIGINAL text — nothing is translated just to be
// deduplicated.
//
// Default provider is a local Ollama server (zero API cost, no new npm
// dependency — plain HTTP). A multilingual model is required for Arabic /
// Urdu / Persian / English posts to land near each other; `bge-m3` is the
// recommended default (`ollama pull bge-m3`). `paraphrase-multilingual` is a
// smaller, faster alternative.
//
// EMBEDDING_PROVIDER=none (the default) disables semantic matching entirely;
// dedup then relies on exact + fuzzy matching only.

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const REQUEST_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS || 15000);
// After a failure, skip embedding calls for this long instead of making
// every dedup item wait for a timeout while Ollama is down. Dedup carries on
// with cheap checks only; it never blocks the pipeline on the embedder.
const FAILURE_COOLDOWN_MS = Number(process.env.EMBEDDING_FAILURE_COOLDOWN_MS || 60000);

let disabledUntil = 0;

export function embeddingConfig() {
  const provider = (process.env.EMBEDDING_PROVIDER || 'none').toLowerCase();
  return {
    provider,
    enabled: provider !== 'none',
    model: process.env.EMBEDDING_MODEL || 'bge-m3',
    url: (process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/$/, ''),
  };
}

// Returns an array of vectors (same order as texts), or null when embeddings
// are disabled or temporarily unavailable.
export async function embedTexts(texts) {
  const cfg = embeddingConfig();
  if (!cfg.enabled || texts.length === 0) return null;
  if (Date.now() < disabledUntil) return null;
  if (cfg.provider !== 'ollama') {
    throw new Error(`Unknown EMBEDDING_PROVIDER "${cfg.provider}" — expected "ollama" or "none"`);
  }

  try {
    const res = await fetch(`${cfg.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama embed failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error('Ollama embed returned an unexpected shape');
    }
    return data.embeddings.map(l2normalize);
  } catch (err) {
    disabledUntil = Date.now() + FAILURE_COOLDOWN_MS;
    console.error(`[dedup] embeddings unavailable, using cheap checks only for ${FAILURE_COOLDOWN_MS / 1000}s:`, err.message);
    return null;
  }
}

export function l2normalize(v) {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

// Vectors are stored L2-normalized, so cosine similarity is a dot product.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// Test hook: lets tests reset the failure cooldown between cases.
export function _resetEmbeddingCooldown() {
  disabledUntil = 0;
}
