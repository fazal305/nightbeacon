// Deterministic, rule-based "is this already English" check — not an LLM call.
// Per the project's classification principles: prefer deterministic rules over
// an LLM call wherever a simple rule is reliable enough. Detecting "contains a
// non-Latin script" is reliable; full language identification is not needed
// just to decide whether translation is worth invoking at all.
const NON_LATIN_SCRIPT = /[؀-ۿݐ-ݿ֐-׿Ѐ-ӿ一-鿿぀-ヿ가-힯]/;

export function looksLikeEnglish(text) {
  if (!text || !text.trim()) return null; // nothing to judge (media-only post)
  return !NON_LATIN_SCRIPT.test(text);
}
