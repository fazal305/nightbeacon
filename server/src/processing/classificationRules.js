// Deterministic, rule-based classification. Kept as plain data + a small
// scoring function — no LLM call, because keyword matching is reliable enough
// for category/priority and an LLM would add latency, cost, and a failure
// mode for something a regex already does well (per the project's principle:
// prefer deterministic rules, use an LLM only where it adds real value).
//
// Categories are evaluated in order; the first category whose keywords match
// wins (an item can only have one category, but can gain descriptive tags
// from every list that matched).

export const CATEGORIES = [
  {
    name: 'security-incident',
    keywords: [
      'attack', 'strike', 'airstrike', 'explosion', 'bomb', 'bombing', 'shelling',
      'gunfire', 'clash', 'clashes', 'raid', 'ambush', 'assassination', 'killed',
      'casualties', 'wounded', 'injured', 'missile', 'rocket', 'drone strike',
    ],
  },
  {
    name: 'military',
    keywords: [
      'military', 'army', 'troops', 'soldiers', 'deployment', 'ceasefire',
      'withdrawal', 'offensive', 'operation', 'forces', 'battalion', 'airbase',
    ],
  },
  {
    name: 'political',
    keywords: [
      'election', 'president', 'minister', 'parliament', 'government', 'coup',
      'resignation', 'summit', 'diplomat', 'negotiation', 'treaty', 'policy',
    ],
  },
  {
    name: 'economic',
    keywords: [
      'sanctions', 'economy', 'inflation', 'currency', 'trade', 'oil price',
      'exports', 'imports', 'market', 'gdp', 'investment', 'debt',
    ],
  },
  {
    name: 'humanitarian',
    keywords: [
      'refugees', 'displaced', 'humanitarian', 'aid', 'famine', 'shortage',
      'earthquake', 'flood', 'disaster', 'evacuation', 'relief',
    ],
  },
  {
    name: 'civil-unrest',
    keywords: [
      'protest', 'protesters', 'demonstration', 'riot', 'strike action',
      'arrest', 'arrested', 'crackdown', 'curfew',
    ],
  },
];

const HIGH_PRIORITY_KEYWORDS = [
  'killed', 'casualties', 'explosion', 'bombing', 'airstrike', 'assassination',
  'attack', 'missile', 'rocket', 'mass casualty', 'breaking',
];

const MEDIUM_PRIORITY_KEYWORDS = [
  'clash', 'clashes', 'protest', 'arrest', 'sanctions', 'raid', 'curfew',
  'evacuation', 'ceasefire', 'coup',
];

function normalize(text) {
  return (text || '').toLowerCase();
}

function matchedKeywords(text, keywords) {
  return keywords.filter((kw) => text.includes(kw));
}

/**
 * Classifies a piece of English-language text (already-translated or
 * originally-English) into a single category, a priority level, and a set
 * of descriptive tags (every keyword hit across every category, not just the
 * winning one — useful for search/filtering even when it wasn't the primary
 * category).
 */
export function classify(text) {
  const normalized = normalize(text);
  if (!normalized.trim()) {
    return { category: null, priority: 'informational', tags: [] };
  }

  let category = null;
  const tags = new Set();

  for (const cat of CATEGORIES) {
    const hits = matchedKeywords(normalized, cat.keywords);
    if (hits.length > 0) {
      if (!category) category = cat.name;
      hits.forEach((h) => tags.add(h));
    }
  }

  let priority = 'informational';
  if (matchedKeywords(normalized, HIGH_PRIORITY_KEYWORDS).length > 0) {
    priority = 'high';
  } else if (matchedKeywords(normalized, MEDIUM_PRIORITY_KEYWORDS).length > 0) {
    priority = 'medium';
  } else if (category) {
    priority = 'low';
  }

  return { category, priority, tags: Array.from(tags) };
}
