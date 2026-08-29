/**
 * Shared helpers for the Kaiju Affairs WebMCP runtime.
 * No dependencies, no build step — plain ES modules served statically.
 */

/** Normalise a URL or path to the canonical form used as a manifest page key. */
export function normalizePath(input) {
  if (!input) return '/';
  let p = String(input).trim();
  // Accept absolute URLs and strip origin.
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { /* fall through */ }
  }
  p = p.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  // Treat /a/b, /a/b/ and /a/b/index.html as the same page.
  p = p.replace(/\/index\.html?$/i, '/');
  if (p.length > 1 && !p.endsWith('/')) p += '/';
  return p.toLowerCase();
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'the', 'to', 'was', 'what',
  'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your'
]);

/** Lower-case word tokens, stop-words removed. Keeps digits (zone 4, ¥50000). */
export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Flatten anything the manifest might hand us into searchable plain text. */
export function flatten(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (typeof value === 'object') return Object.values(value).map(flatten).join(' ');
  return String(value);
}

/** Extract a ~240 char snippet around the first query term hit. */
export function snippet(text, terms, length = 240) {
  const source = flatten(text).replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const lower = source.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return source.slice(0, length) + (source.length > length ? '…' : '');
  const start = Math.max(0, at - Math.floor(length / 3));
  const end = Math.min(source.length, start + length);
  return (start > 0 ? '…' : '') + source.slice(start, end).trim() + (end < source.length ? '…' : '');
}

/**
 * Build an MCP tool result. `structuredContent` carries the machine-readable
 * payload; `content` carries the human/model-readable rendering of the same
 * data so agents without structured-output support still work.
 */
export function result(structured, text) {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured
  };
}

/** Build an MCP error result (a failed tool call, not a thrown exception). */
export function failure(message, hint) {
  const payload = { ok: false, error: message };
  if (hint) payload.hint = hint;
  return {
    isError: true,
    content: [{ type: 'text', text: hint ? `${message}\n\n${hint}` : message }],
    structuredContent: payload
  };
}

/** Absolute URL for a manifest path, for citations the agent can hand back. */
export function absolute(path) {
  try { return new URL(normalizePath(path), location.origin).href; }
  catch { return normalizePath(path); }
}

export function clamp(n, min, max) {
  const value = Number.isFinite(Number(n)) ? Number(n) : min;
  return Math.min(max, Math.max(min, value));
}
