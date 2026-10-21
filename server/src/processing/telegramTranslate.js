import { Api } from 'telegram';
import { getTelegramClient, withTimeout, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';

// Telegram doesn't document a per-call cap for messages.translateText's
// text-array form (unlike the LLM providers, which publish req/min limits).
// Kept conservative so a single flood-wait only costs a small chunk of the
// tick's batch, not the whole thing.
export const TRANSLATE_CHUNK_SIZE = 20;

export function isTelegramFloodWait(message) {
  return /wait of \d+ seconds is required/i.test(message || '');
}

// Text-based translateText — passing peer + message ids instead would make
// GramJS resolve the peer first, which is exactly what flood-waited the
// ingestion session (contacts.ResolveUsername). Passing raw text directly
// skips peer resolution entirely and lets multiple posts translate in one
// MTProto call instead of one call per item.
export async function translateBatch(texts) {
  const client = await getTelegramClient();
  const response = await withTimeout(
    client.invoke(
      new Api.messages.TranslateText({
        text: texts.map((text) => new Api.TextWithEntities({ text, entities: [] })),
        toLang: 'en',
      })
    ),
    REQUEST_TIMEOUT_MS,
    'translateText'
  );
  return response.result.map((t) => t.text);
}
