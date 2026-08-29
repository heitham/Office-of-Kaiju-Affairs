/**
 * Field-weighted search over the manifest page index.
 *
 * Deliberately small: ~30 pages of a demo site, and the whole point is that the
 * agent gets a ranked answer in one call instead of crawling the navigation.
 */

import { tokenize, flatten, snippet, normalizePath } from './util.js';

const FIELD_WEIGHTS = {
  title: 6,
  keywords: 5,
  keyFacts: 4,
  headings: 3,
  summary: 2,
  breadcrumb: 2,
  text: 1
};

function fieldText(page, field) {
  switch (field) {
    case 'keyFacts':
      return (page.keyFacts || []).map((f) => `${f.label} ${f.value}`).join(' ');
    case 'headings':
      return (page.headings || []).map((h) => h.text).join(' ');
    default:
      return flatten(page[field]);
  }
}

/**
 * @param {ReturnType<import('./manifest.js').index>} manifest
 * @param {{query: string, limit?: number, section?: string}} options
 */
export function searchPages(manifest, { query, limit = 5, section } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const phrase = String(query).toLowerCase().trim();

  const scored = [];
  for (const page of manifest.pages) {
    if (section && String(page.section || '').toLowerCase() !== String(section).toLowerCase()) continue;

    let score = 0;
    const matched = new Set();
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const haystack = fieldText(page, field).toLowerCase();
      if (!haystack) continue;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += weight;
          matched.add(term);
        }
      }
      // Exact phrase in a high-value field is the strongest signal we have.
      if (phrase.length > 4 && haystack.includes(phrase)) score += weight * 2;
    }

    // Reward covering the whole query, not just one common word.
    score *= 0.5 + (matched.size / terms.length) * 0.5;

    if (score > 0) {
      scored.push({
        pageId: page.id || null,
        path: normalizePath(page.path),
        title: page.title || page.path,
        section: page.section || null,
        summary: page.summary || '',
        score: Math.round(score * 100) / 100,
        matchedTerms: [...matched],
        snippet: snippet(
          [page.summary, fieldText(page, 'keyFacts'), page.text].filter(Boolean).join(' '),
          terms
        )
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}
