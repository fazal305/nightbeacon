import { pool } from '../db/pool.js';
import { looksLikeEnglish } from './detectLanguage.js';
import { classify } from './classificationRules.js';
import { publishConfig } from '../publishing/config.js';

// Classify first, translate only what matters. Before a post is translated,
// its ORIGINAL text gets a quick priority guess from keyword lists in the
// languages the sources write in. Posts that don't reach
// TRANSLATE_MIN_PRIORITY (default "medium") are not translated: they go
// straight to the feed with their original text and the guessed priority.
// Always translated anyway:
//   - English posts (nothing to translate, free);
//   - posts from official channels (official-sources.md);
//   - stories several channels report (3+) — also re-queued later if the
//     story grows after its first report was skipped.
// TRANSLATE_MIN_PRIORITY=off translates everything, as before.

const HIGH = {
  ar: ['قتل', 'قتلي', 'شهيد', 'شهداء', 'استشهاد', 'استشهد', 'انفجار', 'غاره', 'غارات', 'قصف', 'صاروخ', 'صواريخ', 'هجوم', 'اغتيال',
    'طائره مسيره', 'مسيرات', 'استهداف', 'استهدف', 'كمين', 'جرحي', 'اصابات', 'عاجل', 'تفجير', 'اشتباك'],
  fa: ['کشته', 'شهید', 'شهادت', 'انفجار', 'حمله', 'موشک', 'پهپاد', 'ترور', 'بمباران', 'زخمی', 'مجروح', 'فوری', 'اصابت', 'هدف قرار'],
  ru: ['убит', 'погиб', 'взрыв', 'удар', 'атак', 'ракет', 'дрон', 'беспилотник', 'бпла', 'обстрел', 'бомбардир', 'ранен', 'срочно',
    'молния', 'покушени', 'ликвидир', 'жертв'],
  uk: ['вибух', 'загин', 'обстріл', 'поранен', 'терміново', 'бпла', 'ракет', 'атак'],
  he: ['נהרג', 'הרוג', 'פיצוץ', 'תקיפה', 'טיל', 'רקטה', 'כטב"ם', 'מחבל', 'פיגוע', 'פצוע', 'ירי', 'חיסול', 'אזעקה', 'צבע אדום', 'דחוף'],
  tr: ['öldü', 'saldırı', 'patlama', 'füze', 'roket', 'şehit', 'yaralı', 'bombardıman', 'son dakika', 'insansız hava'],
  ur: ['ہلاک', 'دھماکہ', 'حملہ', 'میزائل', 'شہید', 'زخمی', 'فوری'],
};
const MEDIUM = {
  ar: ['اشتباكات', 'اعتقال', 'عقوبات', 'وقف اطلاق النار', 'هدنه', 'عمليه', 'اقتحام', 'توغل', 'بيان', 'تصريح', 'مفاوضات', 'اجتياح', 'انسحاب'],
  fa: ['درگیری', 'بازداشت', 'تحریم', 'آتش بس', 'عملیات', 'بیانیه', 'مذاکره', 'یورش'],
  ru: ['столкновен', 'арест', 'санкци', 'перемири', 'задержан', 'штурм', 'наступлени', 'заявлени', 'переговор'],
  uk: ['арешт', 'санкц', 'перемир', 'наступ', 'заява'],
  he: ['עימות', 'מעצר', 'סנקציות', 'הפסקת אש', 'מבצע', 'פשיטה', 'הודעה'],
  tr: ['çatışma', 'gözaltı', 'yaptırım', 'ateşkes', 'operasyon', 'açıklama'],
  ur: ['گرفتار', 'جھڑپ', 'پابندی', 'جنگ بندی'],
};

export const PRIORITY_RANK = { informational: 0, low: 1, medium: 2, high: 3 };

// Arabic-script spelling variants (hamza forms, taa marbuta, alef maqsura,
// diacritics, tatweel) and case, so keywords match however a post spells them.
export function normalizeForTriage(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\u06CC/g, 'ي')
    .replace(/[‌‏‎]/g, ' ')
    .replace(/\u06A9/g, 'ك');
}

const flat = (lists) => Object.values(lists).flat().map(normalizeForTriage);
const HIGH_WORDS = flat(HIGH);
const MEDIUM_WORDS = flat(MEDIUM);

// Priority guess from the original text (any language). English keywords
// (the regular classifier) count too, for mixed-language posts.
export function triagePriority(text) {
  const t = normalizeForTriage(text);
  if (!t.trim()) return 'informational';
  const english = classify(text).priority;
  let p = HIGH_WORDS.some((w) => t.includes(w)) ? 'high' : MEDIUM_WORDS.some((w) => t.includes(w)) ? 'medium' : 'low';
  if (PRIORITY_RANK[english] > PRIORITY_RANK[p]) p = english;
  return p;
}

export function translateBar(env = process.env) {
  const bar = String(env.TRANSLATE_MIN_PRIORITY || 'medium').toLowerCase();
  return bar in PRIORITY_RANK ? bar : null; // null = off, translate everything
}

export const higherPriority = (a, b) => (PRIORITY_RANK[b] > PRIORITY_RANK[a] ? b : a);

function officialUsernames() {
  try {
    return [...publishConfig().officialSources.keys()];
  } catch {
    return [];
  }
}

// Splits claimed posts: returns the ones to translate; the rest go straight
// to 'ready' (original text, guessed priority). `items` need id + raw_text.
export async function triageBatch(items, { bar = translateBar() } = {}) {
  if (!bar || items.length === 0) return { translate: items, skipped: [] };
  const { rows: info } = await pool.query(
    `SELECT ri.id, lower(s.channel_username) = ANY($2::text[]) AS official, coalesce(st.item_count, 1) AS reports
     FROM raw_items ri JOIN sources s ON s.id = ri.source_id LEFT JOIN stories st ON st.id = ri.story_id
     WHERE ri.id = ANY($1::bigint[])`,
    [items.map((i) => i.id), officialUsernames()]
  );
  const byId = new Map(info.map((r) => [String(r.id), r]));
  const translate = [];
  const skipped = [];
  for (const item of items) {
    const english = looksLikeEnglish(item.raw_text);
    const priority = triagePriority(item.raw_text);
    const meta = byId.get(String(item.id)) || {};
    item.triage_priority = priority;
    if (english !== false || PRIORITY_RANK[priority] >= PRIORITY_RANK[bar] || meta.official || meta.reports >= 3) {
      translate.push(item);
    } else {
      skipped.push({ item, priority });
    }
  }
  if (translate.length) {
    for (const p of ['high', 'medium', 'low', 'informational']) {
      const ids = translate.filter((i) => i.triage_priority === p).map((i) => i.id);
      if (ids.length) await pool.query(`UPDATE raw_items SET triage_priority = $2 WHERE id = ANY($1::bigint[])`, [ids, p]);
    }
  }
  for (const { item, priority } of skipped) {
    const { category } = classify(item.raw_text);
    await pool.query(
      `UPDATE raw_items SET status = 'ready', priority = $2, triage_priority = $2, category = $3, translation_skipped = true,
              ready_at = clock_timestamp(), updated_at = now()
       WHERE id = $1`,
      [item.id, priority, category]
    );
  }
  return { translate, skipped: skipped.map((s) => s.item) };
}

// A skipped post whose story is now reported by 3+ channels is worth
// translating after all (recent ones only).
export async function requeueCorroborated() {
  const { rowCount } = await pool.query(
    `UPDATE raw_items ri SET status = 'new', translation_skipped = false, updated_at = now()
     FROM stories st
     WHERE ri.translation_skipped AND ri.status = 'ready' AND st.id = ri.story_id AND st.item_count >= 3
       AND ri.telegram_date > now() - interval '3 hours'`
  );
  return rowCount;
}
