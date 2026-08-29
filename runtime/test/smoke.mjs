/**
 * Runtime smoke test — no browser, no dependencies.
 *
 *   npm test
 *
 * Exercises the pure logic (manifest indexing, search ranking, rule evaluation
 * and the tool wrappers) against the mock manifest. The DOM-dependent parts
 * (form prefill, registration) are covered by the Arena's in-page self-test.
 */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Minimal browser surface the tools touch.
globalThis.location = { origin: 'https://kaiju-affairs.example', pathname: '/claims/faq/', href: 'https://kaiju-affairs.example/claims/faq/' };

const { index } = await import('../src/manifest.js');
const { createTools } = await import('../src/tools.js');
const { evaluate } = await import('../src/rules.js');
const { searchPages } = await import('../src/search.js');

const manifestUrl = new URL('../mock/manifest.json', import.meta.url);
const manifest = index(JSON.parse(await readFile(manifestUrl, 'utf8')));

const tools = createTools({ getManifest: async () => manifest, currentPath: () => '/claims/faq/' });
const call = (name, args) => tools.find((t) => t.name === name).execute(args);

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
}

console.log('\nkaiju-affairs runtime smoke test\n');

await test('exactly seven tools are registered', () => {
  assert.equal(tools.length, 7);
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'check_eligibility', 'get_office_info', 'get_page_summary', 'get_service_requirements',
    'list_services', 'prefill_permit_form', 'search_site'
  ]);
});

await test('every tool declares a description and an object inputSchema', () => {
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} description too thin`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema`);
    assert.ok(tool.annotations, `${tool.name} annotations`);
  }
});

await test('task 1 needle: fee-waiver query ranks the FAQ first', () => {
  const hits = searchPages(manifest, { query: 'fee waiver repeat damage claims', limit: 3 });
  assert.equal(hits[0].path, '/claims/faq/', `got ${hits[0].path}`);
});

await test('search_site returns citations, not prose', async () => {
  const r = await call('search_site', { query: 'evacuation route zone 4' });
  assert.equal(r.structuredContent.ok, true);
  assert.equal(r.structuredContent.results[0].path, '/evacuation/zone-4/');
});

await test('get_page_summary defaults to the current page', async () => {
  const r = await call('get_page_summary', {});
  assert.equal(r.structuredContent.page.path, '/claims/faq/');
  assert.ok(r.structuredContent.page.keyFacts.length);
});

await test('get_page_summary fails helpfully on an unknown path', async () => {
  const r = await call('get_page_summary', { path: '/nope/' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /search_site/);
});

await test('list_services enumerates all three services', async () => {
  const r = await call('list_services', {});
  assert.equal(r.structuredContent.count, 3);
});

await test('get_service_requirements resolves by name as well as id', async () => {
  const r = await call('get_service_requirements', { serviceId: 'Kaiju Damage Compensation' });
  assert.equal(r.structuredContent.serviceId, 'damage-compensation');
  assert.equal(r.structuredContent.fees[0].amount, 12000);
});

await test('check_eligibility with no answers returns the question list', async () => {
  const r = await call('check_eligibility', { serviceId: 'damage-compensation' });
  assert.equal(r.structuredContent.needsAnswers, true);
  assert.equal(r.structuredContent.questions.length, 7);
});

await test('task 2 scenario: Mira Tanaka is eligible, with waiver and supplement', async () => {
  const r = await call('check_eligibility', {
    serviceId: 'damage-compensation',
    answers: {
      zone: '4', structuralDamage: true, incidentsLast12Months: 2,
      propertyType: 'commercial', insurancePayoutReceived: false,
      householdIncomeYen: 3600000, daysSinceIncident: 21
    }
  });
  const out = r.structuredContent;
  assert.equal(out.outcome, 'eligible');
  assert.ok(out.grants.includes('assessment-fee-waiver'), 'fee waiver missing');
  assert.ok(out.grants.includes('hardship-supplement'), 'hardship supplement missing');
  assert.ok(out.grants.includes('business-interruption-eligible'), 'business interruption missing');
  assert.ok(out.requiredDocuments.includes('income-certificate'));
  assert.ok(out.citations.some((c) => c.path === '/claims/faq/'), 'no citation to the FAQ rule');
});

await test('zone 2 property is ineligible and cites the zone rule', () => {
  const out = evaluate(manifest.ruleset('damage-compensation-v1'), {
    zone: '2', structuralDamage: true, incidentsLast12Months: 0, propertyType: 'residential', daysSinceIncident: 3
  });
  assert.equal(out.outcome, 'ineligible');
  assert.equal(out.matchedRules[0].id, 'outside-corridor');
});

await test('a claim filed after 90 days is ineligible', () => {
  const out = evaluate(manifest.ruleset('damage-compensation-v1'), {
    zone: '4', structuralDamage: true, incidentsLast12Months: 0, propertyType: 'residential', daysSinceIncident: 120
  });
  assert.equal(out.outcome, 'ineligible');
});

await test('partial answers are reported as undetermined, not guessed', () => {
  const out = evaluate(manifest.ruleset('damage-compensation-v1'), { zone: '4' });
  assert.equal(out.determined, false);
  assert.ok(out.missingAnswers.length >= 3);
});

await test('prefill_permit_form refuses when the form is on another page', async () => {
  const r = await call('prefill_permit_form', { values: { applicantName: 'Mira Tanaka' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /permits\/proximity\/apply/);
});

await test('get_office_info finds the Zone 4 office and its routes', async () => {
  const r = await call('get_office_info', { zone: '4' });
  const office = r.structuredContent.offices[0];
  assert.equal(office.id, 'office-kanto-north');
  assert.ok(office.evacuationRoutes.some((x) => x.name === '4A'));
});

await test('get_office_info fails with the list of real offices', async () => {
  const r = await call('get_office_info', { zone: '9' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Kanto North/);
});

console.log(`\n${passed} passed${process.exitCode ? ' — with failures above' : ''}\n`);
