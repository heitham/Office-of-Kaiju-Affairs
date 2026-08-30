/**
 * Coupling check — the guard on the one seam where content and code are joined.
 *
 *   node tools/check-coupling.mjs [path/to/manifest.json]
 *
 * arena/answer-keys.json states what a correct answer to each race task looks
 * like. Those answers are only correct as long as the published content still
 * says what it said: the same fee, the same thresholds, the same zone rule, the
 * same anchors. The CMS regenerates the manifest from rendered HTML on every
 * full publish, so a content edit can move a number under us silently.
 *
 * This turns that silent drift into a loud failure. It runs the real rule
 * engine and the real search ranking against the real manifest and compares the
 * results to the answer key. If a reskin changes ¥12,000 to ¥15,000, this fails
 * and names the task it broke — instead of a judge finding out on camera.
 */

import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.location = { origin: 'https://kaiju-affairs.example', pathname: '/', href: 'https://kaiju-affairs.example/' };

const { index } = await import(join(root, 'runtime/src/manifest.js'));
const { evaluate } = await import(join(root, 'runtime/src/rules.js'));
const { searchPages } = await import(join(root, 'runtime/src/search.js'));
const { createTools } = await import(join(root, 'runtime/src/tools.js'));

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** Prefer what would actually deploy; fall back through publish, then mock. */
async function resolveManifest() {
  const explicit = process.argv[2];
  const candidates = explicit
    ? [resolve(explicit)]
    : [join(root, 'dist/manifest.json'), join(root, 'site/manifest.json'), join(root, 'runtime/mock/manifest.json')];
  for (const path of candidates) if (await exists(path)) return path;
  throw new Error('no manifest found');
}

const manifestPath = await resolveManifest();
const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
const manifest = index(raw);
const keys = JSON.parse(await readFile(join(root, 'arena/answer-keys.json'), 'utf8'));
const task = (id) => keys.tasks.find((t) => t.id === id);

const isMock = /mock/.test(manifestPath) || /MOCK/i.test(raw.generator?.name || '');
const failures = [];
const notes = [];

function check(label, condition, detail) {
  if (condition) console.log(`  ok    ${label}`);
  else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failures.push(label);
  }
}

/** Everything on a page an agent could read, as one lower-case haystack. */
function pageText(page) {
  if (!page) return '';
  return [
    page.title, page.summary, (page.keywords || []).join(' '),
    (page.keyFacts || []).map((f) => `${f.label} ${f.value}`).join(' '),
    (page.headings || []).map((h) => h.text).join(' '),
    page.text
  ].join(' ').toLowerCase();
}

/** Shortest click depth from the home page, over the manifest's link graph. */
function clickDepth(manifest, target) {
  const adjacency = new Map(manifest.pages.map((p) => [normalizePathish(p.path), (p.links?.internal || []).map(normalizePathish)]));
  const goal = normalizePathish(target);
  const queue = [['/', 0]];
  const seen = new Set(['/']);
  while (queue.length) {
    const [path, depth] = queue.shift();
    if (path === goal) return depth;
    for (const next of adjacency.get(path) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push([next, depth + 1]); }
    }
  }
  return Infinity;
}

const normalizePathish = (p) => {
  let x = String(p || '').split('#')[0].split('?')[0];
  if (!x.startsWith('/')) x = '/' + x;
  if (x.length > 1 && !x.endsWith('/')) x += '/';
  return x.toLowerCase();
};

const sameSet = (a, b) => {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

console.log(`\ncoupling check\n  manifest: ${manifestPath.replace(root + '/', '')}${isMock ? '  (MOCK)' : ''}`);
console.log(`  pages: ${manifest.pages.length}  services: ${manifest.services.length}  rulesets: ${manifest.eligibility.length}  forms: ${manifest.forms.length}\n`);

/* ------------------------------------------------------- structural health */

console.log('structure');
check('manifestVersion is 1.0', raw.manifestVersion === '1.0', `got ${raw.manifestVersion}`);
check('pages[] is present and non-empty', manifest.pages.length > 0);

const thin = manifest.pages.filter((p) => !p.summary || p.summary.length < 40);
check('every page has a usable summary', thin.length === 0,
  thin.length ? `${thin.length} page(s) with a thin or missing summary: ${thin.slice(0, 5).map((p) => p.path).join(', ')}` : '');

const noPath = manifest.pages.filter((p) => !p.path || !p.title);
check('every page has a path and a title', noPath.length === 0);

const toolNames = new Set(createTools({ getManifest: async () => manifest, currentPath: () => '/' }).map((t) => t.name));
check('exactly 7 tools (the scope budget)', toolNames.size === 7, `got ${toolNames.size}`);
const badToolPath = keys.tasks.flatMap((t) => (t.toolPath || []).filter((n) => !toolNames.has(n)));
check('answer keys reference only real tools', badToolPath.length === 0, badToolPath.join(', '));

/* ------------------------------------------------------------------ task 1 */

console.log('\ntask-1-needle — the buried fee-waiver rule');
const t1 = task('task-1-needle');
const faq = manifest.page(t1.expected.sourcePath);
check(`${t1.expected.sourcePath} is in the page index`, Boolean(faq));

if (faq) {
  const text = pageText(faq);
  for (const phrase of t1.expected.mustAppearOnPage || []) {
    check(`page states "${phrase}"`, text.includes(phrase.toLowerCase()),
      'the answer key depends on this wording surviving the content reskin');
  }
  const anchors = (faq.headings || []).map((h) => h.anchor).filter(Boolean);
  check(`heading anchor ${t1.expected.sourceAnchor} exists`,
    anchors.includes(t1.expected.sourceAnchor),
    `anchors present: ${anchors.join(', ') || 'none'} — the CMS only emits an anchor when the authored heading has an id`);

  const ranked = searchPages(manifest, { query: t1.expected.rankingQuery, limit: 3 });
  check(`search_site ranks it first for "${t1.expected.rankingQuery}"`,
    ranked[0]?.path === t1.expected.sourcePath,
    ranked.length ? `ranked: ${ranked.map((r) => r.path).join(' > ')}` : 'no results at all');

  // The persona has to actually entail the answer the key claims. Prose tasks
  // used to escape this: the key could assert an outcome the published rules
  // never produce, and every other check would still pass.
  const t1Ruleset = manifest.ruleset('damage-compensation-v1');
  if (t1Ruleset && t1.persona?.answers && t1.expected.feeWaiverApplies !== undefined) {
    const out = evaluate(t1Ruleset, t1.persona.answers);
    const granted = out.grants.includes('assessment-fee-waiver');
    check(`the persona's own facts produce feeWaiverApplies=${t1.expected.feeWaiverApplies}`,
      granted === t1.expected.feeWaiverApplies,
      `published rules give ${granted ? 'a waiver' : 'NO waiver'} for this persona ` +
      `(incidentsLast12Months=${t1.persona.answers.incidentsLast12Months}); the key says ` +
      `${t1.expected.feeWaiverApplies ? 'waived' : 'payable'}. The site wins — fix the persona or the key.`);
  }

  // Claims the Arena prints about how hard the task is. A judge can check these
  // in two clicks, so we check them too.
  const claims = t1.expected.difficultyClaims;
  if (claims && faq) {
    if (claims.sourceWordCountAtLeast !== undefined) {
      check(`the Arena's "${claims.sourceWordCountAtLeast}-word page" claim holds`,
        (faq.wordCount || 0) >= claims.sourceWordCountAtLeast,
        `published page is ${faq.wordCount} words`);
    }
    if (claims.minClickDepthFromHome !== undefined) {
      check(`the Arena's "${claims.minClickDepthFromHome} clicks deep" claim holds`,
        clickDepth(manifest, t1.expected.sourcePath) >= claims.minClickDepthFromHome,
        `shortest path from / is ${clickDepth(manifest, t1.expected.sourcePath)} click(s) via the published link graph`);
    }
  }
}

/* ------------------------------------------------------------------ task 2 */

console.log('\ntask-2-eligibility — the rules actually produce the key answer');
const t2 = task('task-2-eligibility');
const ruleset = manifest.ruleset(t2.expected.rulesetId);
check(`ruleset ${t2.expected.rulesetId} is published`, Boolean(ruleset));

if (ruleset && t2.persona?.answers) {
  const out = evaluate(ruleset, t2.persona.answers);
  check(`outcome is "${t2.expected.outcome}"`, out.outcome === t2.expected.outcome, `got "${out.outcome}"`);
  check('all answers the persona provides are questions the ruleset asks',
    out.missingAnswers.length === 0,
    `still missing: ${out.missingAnswers.map((m) => m.id).join(', ')}`);
  check('grants match the answer key exactly', sameSet(out.grants, t2.expected.grants),
    `expected [${t2.expected.grants.join(', ')}] got [${out.grants.join(', ')}]`);
  check('required documents match the answer key exactly',
    sameSet(out.requiredDocuments, t2.expected.requiredDocuments),
    `expected [${t2.expected.requiredDocuments.join(', ')}] got [${out.requiredDocuments.join(', ')}]`);
  check('every citation points at a page that exists',
    out.citations.every((c) => manifest.page(c.path)),
    out.citations.filter((c) => !manifest.page(c.path)).map((c) => c.path).join(', '));
} else if (ruleset) {
  notes.push('task-2 has no persona.answers — outcome not verified');
}

/* ------------------------------------------------------------------ task 3 */

console.log('\ntask-3-permit — the form accepts exactly the key values');
const t3 = task('task-3-permit');
const form = manifest.form(t3.expected.formId);
check(`form ${t3.expected.formId} is published`, Boolean(form));

if (form) {
  check(`form is served at ${t3.expected.path}`, form.path === t3.expected.path, `manifest says ${form.path}`);
  const declared = new Map((form.fields || []).map((f) => [f.name, f]));
  const expectedValues = Object.entries(t3.expected.values || {});
  check(`all ${expectedValues.length} answer-key fields are declared on the form`,
    expectedValues.every(([name]) => declared.has(name)),
    expectedValues.filter(([n]) => !declared.has(n)).map(([n]) => n).join(', '));

  for (const [name, value] of expectedValues) {
    const field = declared.get(name);
    if (!field) continue;
    const allowed = field.options?.map((o) => String(o.value ?? o)) || field.enum?.map(String);
    if (allowed) {
      check(`${name} = "${value}" is a valid option`, allowed.includes(String(value)),
        `allowed: ${allowed.join(', ')}`);
    }
    if (field.pattern) {
      check(`${name} = "${value}" matches its declared pattern`, new RegExp(field.pattern).test(String(value)),
        `pattern ${field.pattern}`);
    }
  }

  const required = (form.fields || []).filter((f) => f.required).map((f) => f.name);
  const unmet = required.filter((n) => !(n in (t3.expected.values || {})));
  check('the answer key fills every required field', unmet.length === 0, `unfilled: ${unmet.join(', ')}`);

  const derived = t3.expected.derivedField?.mustAppearOnPage;
  if (derived) {
    const page = manifest.page(derived.path);
    check(`${derived.path} is in the page index`, Boolean(page));
    if (page) {
      const text = pageText(page);
      for (const phrase of derived.phrases) {
        check(`${derived.path} states "${phrase}"`, text.includes(phrase.toLowerCase()),
          'the agent has to derive this value from the page — if the content drops it, the task is unsolvable');
      }
    }
  }
}

/* -------------------------------------------------------------------- exit */

console.log('');
for (const note of notes) console.log(`  note  ${note}`);

if (failures.length) {
  console.error(`\n${failures.length} coupling failure(s). The published content no longer matches arena/answer-keys.json:\n` +
    failures.map((f) => `  - ${f}`).join('\n') +
    `\n\nFix the content, or update the answer key in the same pass. Do not ship them out of sync.\n`);
  process.exit(1);
}

console.log(`coupling intact${isMock ? ' (against the mock — re-run once the CMS publishes)' : ''}\n`);
