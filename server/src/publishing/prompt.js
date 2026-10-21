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

// The Israeli flag is never used on any channel. Removing it can leave a
// dangling "⚡" from the "🇮🇷⚡🇮🇱" headline style, so that is tidied too.
export function removeBannedFlags(text) {
  if (!text) return text;
  return text
    .replace(/\u{1F1EE}\u{1F1F1}/gu, '')
    .replace(/(\p{Regional_Indicator}{2})⚡(?=[ \t]|$)/gmu, '$1')
    .replace(/(^|[ \t])⚡(?=\p{Regional_Indicator}{2})/gmu, '$1')
    .replace(/^[ \t]*⚡[ \t]+/gmu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '');
}

// Official statements are posted word for word (only translated). For the
// check, links, @handles, #tags, emoji, punctuation and case are ignored —
// the posting rules drop links/handles, and header/footer lines are added.
export function wordsOnly(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+|t\.me\/\S+/gi, ' ')
    .replace(/[@#][\p{L}\p{N}_]+/gu, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function keepsStatementVerbatim(draft, statement) {
  const s = wordsOnly(statement);
  return s.length > 0 && wordsOnly(draft).includes(s);
}

export function statementText(item) {
  return item.translated_text || item.raw_text;
}

export function officialOrganisation(item, officialSources) {
  return officialSources?.get(String(item.channel_username || '').toLowerCase()) || null;
}

// targets: [{ channel, style }]
export function buildDraftMessages({ item, targets, terminology = [], officialSources = new Map() }) {
  const multi = targets.length > 1;
  const rules = [
    'You write posts for the operator\'s Telegram news channels.',
    'Write a post about the report below for each channel listed, in English, matching THAT channel\'s house style exactly: ' +
      'length, structure, emoji use, capitalisation, hashtags and any recurring sign-off, as shown in its rules and examples.',
    'Use only facts stated in the report. Never invent details, numbers, names, places or times. Keep every figure exactly as reported.',
    'When the news is a statement by a party, attribute it with the neutral verb "said" — the same for every side ("CENTCOM said…", "The IRGC said…"). ' +
      'Never use the Israeli flag emoji (🇮🇱); for Israeli actors use no flag.',
    'Do not use loaded verbs such as "claimed", "alleged", "admitted" or "boasted" for any side.',
    'Never say where the report came from: no Telegram channel names or @handles, no "reported by N channels", no "according to sources / local channels / media reports", ' +
      'no links, no source or credit line. Name a person or organisation only when the news itself is their statement or claim.',
    `If the report is not news worth posting on a channel (an advert, a channel promotion, a greeting, too vague to state a fact, or off-topic for that channel), use exactly ${SKIP_TOKEN} for it.`,
  ];
  if (item.has_media) {
    rules.push(
      'The post will be published with the source\'s photo/video attached, so keep each post under 1000 characters ' +
        '(Telegram\'s caption limit) and don\'t write "see video" or describe the media beyond what the report says.'
    );
  }
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

  const organisations = [...new Set(officialSources.values())];
  if (organisations.length) {
    rules.push(
      `Official statements: for these organisations — ${organisations.join(', ')} — write a post presenting their statement ` +
        '(e.g. "Hezbollah said…", a statement or communiqué) ONLY if the report comes from that organisation\'s own official channel (see "Source" below). ' +
        `If the report is not from their official channel and is mainly a statement or announcement by one of them, use exactly ${SKIP_TOKEN}. ` +
        'Other news reports are unaffected.'
    );
  }
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
    organisations.length
      ? officialOrganisation(item, officialSources)
        ? `Source: the official channel of ${officialOrganisation(item, officialSources)}`
        : 'Source: not an official channel of any organisation listed above'
      : null,
    officialOrganisation(item, officialSources)
      ? `This is an official statement of ${officialOrganisation(item, officialSources)}. Use the English ` +
        `${item.translated_text ? 'translation' : 'text'} above WORD FOR WORD as the body of the post: do not shorten, ` +
        'paraphrase, reorder, correct, summarise or add a single word, and do not change any names or terms in it. ' +
        'Only add the channel\'s own header line and footer around it, and leave out links and @channel handles.'
      : null,
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

// Scheduled summary of several stories for one channel. Same factual rules
// as single posts; each story is summarised in a line or two.
export function buildDigestMessages({ channel, style, stories, since, timeZone, terminology = [], officialSources = new Map() }) {
  const organisations = [...new Set(officialSources.values())];
  const rules = [
    `You write the scheduled news summary for the Telegram channel "${channel.name}".`,
    'Summarise the most important developments below in ONE post, in English, in this channel\'s house style ' +
      '(emoji, capitalisation, footer — see its rules and examples). Open with a short title line for the summary, ' +
      'then one entry per story: one or two short lines, most important first, related stories may be merged.',
    'Use only facts stated in the reports. Never invent details, numbers, names, places or times. Keep every figure exactly as reported.',
    'Attribute statements with the neutral verb "said" for every side; do not use "claimed", "alleged", "admitted" or "boasted".',
    'Never say where a report came from: no Telegram channel names or @handles, no "reported by N channels", no "according to sources", no links, no source or credit lines.',
    'Never use the Israeli flag emoji (🇮🇱).',
    'Keep the whole post under 3500 characters.',
    `If there is nothing worth summarising, reply exactly ${SKIP_TOKEN}.`,
    'Reply with the post text only.',
  ];
  if (organisations.length) {
    rules.push(
      `Statements by ${organisations.join(', ')}: include one only if its story is marked "official statement"; ` +
        'then use its exact words (a short exact excerpt is fine) — never paraphrase it. Leave out statements by them marked "unofficial channel".'
    );
  }
  if (terminology.length) {
    rules.push('Always use these names:\n' + terminology.map((r) => `- write "${r.replacement}" instead of "${r.term}"`).join('\n'));
  }
  const system = [
    rules.join('\n'),
    style.guide ? `Posting rules from the editor:\n${style.guide}` : null,
    `Recent posts from this channel (style reference only — do not reuse their facts):\n${examplesBlock(style.examples)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const sinceLocal = new Date(since).toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const user = [
    `Stories since ${sinceLocal} (${timeZone}), most important first:`,
    ...stories.map((s, i) => {
      const text = (s.translated_text || s.raw_text || '').slice(0, 700);
      const org = officialSources.get(String(s.channel_username || '').toLowerCase());
      const tags = [
        s.priority,
        s.reports > 1 ? `${s.reports} reports` : null,
        s.dedup_status === 'update' ? 'update' : null,
        organisations.length ? (org ? `official statement of ${org}` : 'unofficial channel') : null,
      ].filter(Boolean);
      return `\n[${i + 1}] (${tags.join(', ')}) ${new Date(s.telegram_date).toISOString()}\n${text}`;
    }),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
