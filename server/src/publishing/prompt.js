// Builds the drafting prompt. Pure (no I/O) so it can be tested directly.
//
// Each channel's own recent posts are its style reference; the model is told
// to match them and to use ONLY facts present in the source report. When one
// report needs drafts for several channels, they're written in ONE call
// (a JSON object keyed by channel) — the report and the rules are sent once
// instead of once per channel. A report that isn't worth posting gets SKIP.

export const SKIP_TOKEN = 'SKIP';
const MAX_EXAMPLES_CHARS_PER_CHANNEL = 2500;

function examplesBlock(examples) {
  const out = [];
  let used = 0;
  for (const ex of examples || []) {
    if (used + ex.length > MAX_EXAMPLES_CHARS_PER_CHANNEL) break;
    out.push(ex);
    used += ex.length;
  }
  return out.length > 0
    ? out.map((e, i) => `--- example ${i + 1} ---\n${e}`).join('\n')
    : '(no example posts available: write a concise, factual news post, 1–3 short paragraphs)';
}

function channelSection({ channel, style }, item) {
  const lines = [`Channel "${channel.key}" — ${channel.name}${channel.telegram ? ` (${channel.telegram})` : ''}`];
  if (style.guide) lines.push(`Posting rules from the editor:\n${style.guide}`);
  if (channel.sourceCredit === 'channel' && item.channel_username) {
    lines.push(`End the post with a final line: "Source: @${item.channel_username}".`);
  } else {
    lines.push('Do not mention the source Telegram channel by name.');
  }
  lines.push(`Recent posts from this channel (style reference only — do not reuse their facts):\n${examplesBlock(style.examples)}`);
  return lines.join('\n');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Swaps each term for its replacement (whole words, any case), longest term
// first so "Israel Defense Forces" wins over a shorter overlapping rule.
// Applied to every draft, so the house terminology holds even when the
// model slips back to the source's wording.
export function applyTerminology(text, rules) {
  if (!text || !rules?.length) return text;
  let out = text;
  for (const { term, replacement } of [...rules].sort((a, b) => b.term.length - a.term.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(term)}(?![\\p{L}\\p{N}_])`, 'giu');
    out = out.replace(re, replacement);
  }
  return out;
}

// targets: [{ channel, style }]
export function buildDraftMessages({ item, targets, terminology = [] }) {
  const multi = targets.length > 1;
  const rules = [
    'You write posts for the operator\'s Telegram news channels.',
    'Write a post about the report below for each channel listed, in English, matching THAT channel\'s house style exactly: ' +
      'length, structure, emoji use, capitalisation, hashtags and any recurring sign-off, as shown in its rules and examples.',
    'Use only facts stated in the report. Never invent details, numbers, names, places or times. Keep every figure exactly as reported.',
    'When the news is a statement by a party, attribute it with the neutral verb "said" — the same for every side ("CENTCOM said…", "The IRGC said…"). ' +
      'Do not use loaded verbs such as "claimed", "alleged", "admitted" or "boasted" for any side.',
    'Never say where the report came from: no Telegram channel names or @handles, no "reported by N channels", no "according to sources / local channels / media reports", ' +
      'no links, no source or credit line. Name a person or organisation only when the news itself is their statement or claim.',
    `If the report is not news worth posting on a channel (an advert, a channel promotion, a greeting, too vague to state a fact, or off-topic for that channel), use exactly ${SKIP_TOKEN} for it.`,
  ];
  if (item.dedup_status === 'update') {
    rules.push('This report UPDATES an earlier story (new figures or details). Make the new information the lead.');
  }
  rules.push(
    multi
      ? `Reply with ONLY a JSON object mapping each channel key to its post text (or "${SKIP_TOKEN}"): {${targets
          .map((t) => `"${t.channel.key}": "..."`)
          .join(', ')}}. No other text, no Markdown fences.`
      : 'Reply with the post text only — no preamble, no quotes, no explanation.'
  );

  if (terminology.length) {
    rules.push(
      'Always use these names (house terminology), including inside quotes you paraphrase:\n' +
        terminology.map((r) => `- write "${r.replacement}" instead of "${r.term}"`).join('\n')
    );
  }
  const system = [rules.join('\n'), ...targets.map((t) => channelSection(t, item))].join('\n\n');

  const report = [
    item.translated_text && item.translated_text !== item.raw_text
      ? `English translation:\n${item.translated_text}\n\nOriginal text:\n${item.raw_text}`
      : `Report:\n${item.raw_text}`,
    `Time: ${new Date(item.telegram_date).toISOString()}`,
    item.category ? `Category: ${item.category}` : null,
    item.priority ? `Priority: ${item.priority}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: report },
  ];
}

// Normalises one post: strips wrapping quotes/fences, enforces Telegram's
// 4096-character limit, detects SKIP.
export function parseDraft(content) {
  let text = String(content ?? '').trim();
  text = text.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.toUpperCase() === SKIP_TOKEN || /^SKIP\b/.test(text)) return { skip: true, text: null };
  if (text.length > 4096) text = `${text.slice(0, 4095).trimEnd()}…`;
  return { skip: false, text };
}

// Multi-channel reply -> Map(key -> { skip, text }) for the keys present.
export function parseMultiDraft(content, keys) {
  const raw = String(content || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('multi-channel draft reply is not a JSON object');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const out = new Map();
  for (const key of keys) {
    if (typeof parsed[key] === 'string') out.set(key, parseDraft(parsed[key]));
  }
  return out;
}
