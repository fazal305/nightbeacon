// Deterministic, rule-based "does this already have readable English content"
// check — not an LLM call. Per the project's classification principles:
// prefer deterministic rules over an LLM call wherever a simple rule is
// reliable enough. Skips translation for purely-English posts AND for
// mixed-language posts that already contain a meaningful amount of English
// (a bilingual post an analyst can partly read already isn't worth an LLM
// call, especially under real free-tier quota pressure — see docs/POLLING.md
// and the ADR on translation provider limits).
const NON_LATIN_SCRIPT = /[؀-ۿݐ-ݿ֐-׿Ѐ-ӿ一-鿿぀-ヿ가-힯]/g;
const LATIN_LETTER = /[A-Za-z]/g;

// Below this fraction of Latin letters (of all script letters present), the
// English content is too sparse to be useful on its own — e.g. a single
// English hashtag or @mention buried in an otherwise fully foreign-script
// post still needs translating for the post to be readable.
const MIN_ENGLISH_FRACTION = 0.15;

export function looksLikeEnglish(text) {
  if (!text || !text.trim()) return null; // nothing to judge (media-only post)

  const latinCount = (text.match(LATIN_LETTER) || []).length;
  const nonLatinCount = (text.match(NON_LATIN_SCRIPT) || []).length;

  if (nonLatinCount === 0) return true; // purely Latin script already

  const totalScriptLetters = latinCount + nonLatinCount;
  if (totalScriptLetters === 0) return null; // no letters at all (emoji/links only)

  return latinCount / totalScriptLetters >= MIN_ENGLISH_FRACTION;
}
