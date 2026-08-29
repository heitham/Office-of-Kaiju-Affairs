/**
 * Writes placeholder traces so the Arena can be built and reviewed before the
 * real recordings exist. The drift-race session overwrites these files with
 * real runs; every mock is stamped agent.name = "MOCK".
 *
 *   node baselines/make-mock-traces.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://kaiju-affairs.example';

/** Turn [{type,label,...,d}] into timed steps. `d` is the step's duration in ms. */
function time(steps) {
  let t = 0;
  return steps.map((s, i) => {
    const { d, ...rest } = s;
    const step = { index: i + 1, tMs: t, durationMs: d, outcome: 'ok', ...rest };
    t += d;
    return step;
  });
}

const total = (steps) => steps.at(-1).tMs + steps.at(-1).durationMs;

function trace({ runId, lane, task, steps, result, score, notes, tools }) {
  const timed = time(steps);
  return {
    traceVersion: '1.0',
    runId,
    recordedAt: '2026-08-29T12:00:00Z',
    lane,
    agent: {
      name: 'MOCK',
      model: 'placeholder — replaced by the drift-race session',
      harness: 'drift-race',
      toolsAvailable: tools || []
    },
    site: { baseUrl: BASE, manifestVersion: '1.0', commit: 'mock' },
    task,
    steps: timed,
    result,
    metrics: {
      wallClockMs: total(timed),
      actionCount: timed.length,
      toolCalls: timed.filter((s) => s.type === 'tool_call').length,
      pageLoads: timed.filter((s) => s.type === 'navigate').length,
      deadEnds: timed.filter((s) => s.outcome === 'dead-end').length,
      bytesTransferred: timed.reduce((n, s) => n + (s.cost?.bytes || 0), 0)
    },
    score,
    notes: `PLACEHOLDER. ${notes}`
  };
}

const nav = (path, label, bytes, d, extra = {}) => ({
  type: 'navigate', label, d, target: { path, url: BASE + path }, cost: { bytes }, ...extra
});
const click = (text, label, d, extra = {}) => ({ type: 'click', label, d, target: { text }, ...extra });
const scroll = (label, d, extra = {}) => ({ type: 'scroll', label, d, ...extra });
const read = (label, d, extra = {}) => ({ type: 'read', label, d, ...extra });
const call = (name, args, resultSummary, d, bytes) => ({
  type: 'tool_call', label: `${name}(${Object.keys(args).join(', ')})`, d,
  toolCall: { name, arguments: args, resultSummary, resultBytes: bytes }, cost: { bytes }
});
const answer = (label, d, detail) => ({ type: 'answer', label, detail, d });

/* ---------------------------------------------------------------- task 1 */

const uiTask1 = trace({
  runId: 'ui-task-1-needle-mock',
  lane: 'ui-guessing',
  task: { id: 'task-1-needle', title: 'Needle in the haystack', prompt: 'Do I pay the claim assessment fee a second time? Quote the rule.' },
  steps: [
    nav('/', 'Loaded the home page', 48210, 3100),
    read('Scanned the navigation for anything about fees', 6400),
    click('Services', 'Clicked "Services" in the main nav', 1200),
    nav('/services/', 'Loaded the services index', 39880, 2600),
    read('No mention of fees on the services index', 5200, { outcome: 'dead-end' }),
    click('Claims', 'Clicked "Claims"', 1100),
    nav('/claims/', 'Loaded the claims landing page', 41020, 2400),
    scroll('Scrolled looking for a fees link', 7300),
    click('Damage compensation', 'Guessed "Damage compensation"', 1100),
    nav('/claims/damage-compensation/', 'Loaded damage compensation', 63400, 3000),
    scroll('Read 740 words looking for a waiver', 21400, { outcome: 'dead-end' }),
    read('Found "a ¥12,000 assessment fee applies to each claim" — took it at face value', 4800),
    click('Back', 'Went back to /claims/', 900),
    click('Claim fees', 'Clicked "Claim fees"', 1100),
    nav('/claims/fees/', 'Loaded the claim fees page', 33900, 2500),
    read('Saw "Exemptions are listed in the claims FAQ" — but no direct link to the section', 8200),
    click('FAQ', 'Clicked through to the FAQ', 1200),
    nav('/claims/faq/', 'Loaded the FAQ — 1,480 words', 96700, 3400),
    scroll('Scrolled the FAQ; stopped in the "Filing and deadlines" section', 26800, { outcome: 'dead-end' }),
    answer('Answered without the rule', 9100, 'Hedged: "there may be exemptions — contact your regional office".')
  ],
  result: {
    answer: 'The claim assessment fee is ¥12,000 per claim. There may be exemptions in some circumstances — contact your regional office to confirm whether one applies to you.',
    submitted: false,
    gaveUp: false
  },
  score: {
    answerKeyId: 'task-1-needle',
    accuracy: 0.29,
    verdict: 'partial',
    checks: [
      { id: 'answer-no-fee', label: 'States the fee is waived', weight: 2, pass: false, actual: 'hedged — "there may be exemptions"' },
      { id: 'threshold', label: 'States the two-claims-in-12-months threshold', weight: 2, pass: false, actual: 'not found' },
      { id: 'amount', label: 'Names the ¥12,000 fee', weight: 1, pass: true, actual: '¥12,000' },
      { id: 'citation', label: 'Cites /claims/faq/#fee-waivers', weight: 1, pass: true, actual: '/claims/faq/ (page, not section)' },
      { id: 'no-application', label: 'Notes no separate application is needed', weight: 1, pass: false, actual: 'told the user to phone the office' }
    ]
  },
  notes: 'The rule is in the FAQ the agent actually opened — it stopped scrolling two sections short.'
});

const mcpTask1 = trace({
  runId: 'mcp-task-1-needle-mock',
  lane: 'webmcp',
  tools: ['search_site', 'get_page_summary'],
  task: { id: 'task-1-needle', title: 'Needle in the haystack', prompt: 'Do I pay the claim assessment fee a second time? Quote the rule.' },
  steps: [
    call('search_site', { query: 'assessment fee waiver repeat claims' }, '3 results; /claims/faq/ ranked first with the waiver sentence in the snippet', 2400, 1870),
    call('get_page_summary', { path: '/claims/faq/' }, 'Key fact: two or more approved claims in a rolling 12-month period exempt the ¥12,000 fee', 1900, 2240),
    answer('Answered with the rule and its citation', 4200, 'Quoted the FAQ sentence and linked the section anchor.')
  ],
  result: {
    answer: 'No. Because you have had two approved claims from separate incidents within 12 months, you are exempt from the ¥12,000 assessment fee on this claim. The exemption is applied automatically by the regional office — you do not need to apply for it. Source: /claims/faq/#fee-waivers.',
    submitted: false,
    gaveUp: false
  },
  score: {
    answerKeyId: 'task-1-needle',
    accuracy: 1,
    verdict: 'correct',
    checks: [
      { id: 'answer-no-fee', weight: 2, pass: true, actual: 'exempt' },
      { id: 'threshold', weight: 2, pass: true, actual: '2 claims / rolling 12 months' },
      { id: 'amount', weight: 1, pass: true, actual: '¥12,000' },
      { id: 'citation', weight: 1, pass: true, actual: '/claims/faq/#fee-waivers' },
      { id: 'no-application', weight: 1, pass: true, actual: 'applied automatically' }
    ]
  },
  notes: 'Two calls. The manifest indexes the FAQ key facts, so the buried rule ranks first.'
});

/* ---------------------------------------------------------------- task 2 */

const uiTask2 = trace({
  runId: 'ui-task-2-eligibility-mock',
  lane: 'ui-guessing',
  task: { id: 'task-2-eligibility', title: 'Eligibility determination', prompt: 'Am I eligible, what support do I qualify for, and which documents do I need?' },
  steps: [
    nav('/', 'Loaded the home page', 48210, 3000),
    click('Claims', 'Clicked "Claims"', 1100),
    nav('/claims/', 'Loaded claims', 41020, 2400),
    click('Am I eligible to claim?', 'Clicked the eligibility page', 1100),
    nav('/claims/eligibility/', 'Loaded eligibility — 820 words', 71300, 3100),
    scroll('Read the zone requirement', 12600),
    read('Confirmed Zone 4 is inside a designated corridor', 4100),
    scroll('Read the insurance offsets section', 9800),
    scroll('Reached the hardship supplement section but skimmed past the income threshold', 8700, { outcome: 'dead-end' }),
    click('How to file', 'Clicked "How to file"', 1100),
    nav('/claims/how-to-file/', 'Loaded the filing process', 58900, 2700),
    scroll('Read the five steps', 15200),
    read('Extracted three documents from the prose', 7400),
    click('Back', 'Back to /claims/', 900),
    click('Damage compensation', 'Opened damage compensation', 1100),
    nav('/claims/damage-compensation/', 'Loaded damage compensation', 63400, 2900),
    scroll('Skimmed "What is covered"', 13800),
    read('Missed that commercial properties can claim business interruption', 5200, { outcome: 'dead-end' }),
    scroll('Scrolled to the awards section', 9400),
    answer('Answered with a partial document list', 11200, 'Eligible, three documents, no supplements identified.')
  ],
  result: {
    answer: 'You appear to be eligible: your property is in Zone 4 and there is verified structural damage. You will need an incident report receipt, a damage survey and proof of ownership. Contact your regional office to confirm.',
    submitted: false,
    gaveUp: false
  },
  score: {
    answerKeyId: 'task-2-eligibility',
    accuracy: 0.5,
    verdict: 'partial',
    checks: [
      { id: 'outcome', weight: 3, pass: true, actual: 'eligible' },
      { id: 'fee-waiver', weight: 2, pass: false, actual: 'not identified' },
      { id: 'hardship', weight: 2, pass: false, actual: 'not identified' },
      { id: 'business-interruption', weight: 1, pass: false, actual: 'not identified' },
      { id: 'documents', weight: 2, pass: false, actual: '3 of 5' }
    ]
  },
  notes: 'Got the headline decision right and every conditional grant wrong — the expensive kind of wrong.'
});

const mcpTask2 = trace({
  runId: 'mcp-task-2-eligibility-mock',
  lane: 'webmcp',
  tools: ['list_services', 'check_eligibility', 'get_service_requirements'],
  task: { id: 'task-2-eligibility', title: 'Eligibility determination', prompt: 'Am I eligible, what support do I qualify for, and which documents do I need?' },
  steps: [
    call('list_services', {}, '3 services; damage-compensation has an eligibility check', 1600, 940),
    call('check_eligibility', { serviceId: 'damage-compensation' }, 'Returned the 7 questions to ask', 1500, 1120),
    call('check_eligibility', {
      serviceId: 'damage-compensation',
      answers: { zone: '4', structuralDamage: true, incidentsLast12Months: 2, propertyType: 'commercial', insurancePayoutReceived: false, householdIncomeYen: 3600000, daysSinceIncident: 21 }
    }, 'eligible; grants: assessment-fee-waiver, hardship-supplement, business-interruption-eligible; 5 documents; 4 citations', 2100, 2680),
    call('get_service_requirements', { serviceId: 'damage-compensation' }, 'Document descriptions and deadlines', 1700, 2310),
    answer('Answered with outcome, grants, documents and citations', 5100)
  ],
  result: {
    answer: 'Eligible. Zone 4 with verified structural damage, filed 21 days after the incident (within the 90-day window). You also qualify for: the ¥12,000 assessment-fee waiver (2 approved claims in 12 months), the hardship supplement (household income under ¥4,000,000), and business-interruption compensation (commercial property). Bring: incident report receipt, damage survey, proof of ownership, household income certificate, business registration certificate.',
    submitted: false,
    gaveUp: false
  },
  score: {
    answerKeyId: 'task-2-eligibility',
    accuracy: 1,
    verdict: 'correct',
    checks: [
      { id: 'outcome', weight: 3, pass: true, actual: 'eligible' },
      { id: 'fee-waiver', weight: 2, pass: true, actual: 'assessment-fee-waiver' },
      { id: 'hardship', weight: 2, pass: true, actual: 'hardship-supplement' },
      { id: 'business-interruption', weight: 1, pass: true, actual: 'business-interruption-eligible' },
      { id: 'documents', weight: 2, pass: true, actual: '5 of 5' }
    ]
  },
  notes: 'The rules are data. The agent does not have to infer policy from prose, so it cannot miss a clause.'
});

/* ---------------------------------------------------------------- task 3 */

const uiTask3 = trace({
  runId: 'ui-task-3-permit-mock',
  lane: 'ui-guessing',
  task: { id: 'task-3-permit', title: 'Permit prefill', prompt: 'Fill in my proximity construction permit application. Do not submit it.' },
  steps: [
    nav('/', 'Loaded the home page', 48210, 3000),
    click('Permits', 'Clicked "Permits"', 1100),
    nav('/permits/', 'Loaded permits', 37600, 2500),
    read('Chose the proximity permit', 5300),
    nav('/permits/proximity/', 'Loaded the proximity permit page', 68200, 2900),
    scroll('Skimmed "Who needs this permit"', 11400),
    scroll('Scrolled past the "Reinforcement standards" section', 7900, { outcome: 'dead-end' }),
    click('Apply', 'Clicked "Apply"', 1100),
    nav('/permits/proximity/apply/', 'Loaded the application form', 44100, 2800),
    read('Read the 12 form labels off the page', 9600),
    { type: 'type', label: 'Typed applicant name', d: 2600, target: { selector: '#applicantName' } },
    { type: 'type', label: 'Typed organisation', d: 2200, target: { selector: '#organization' } },
    { type: 'type', label: 'Typed contact email', d: 2400, target: { selector: '#contactEmail' } },
    { type: 'type', label: 'Typed site postcode', d: 2300, target: { selector: '#sitePostcode' } },
    { type: 'click', label: 'Selected Zone 4', d: 1900, target: { selector: '#zone' } },
    { type: 'type', label: 'Typed distance from centreline', d: 2100, target: { selector: '#distanceFromCorridorM' } },
    { type: 'click', label: 'Selected structure type', d: 1900, target: { selector: '#structureType' } },
    { type: 'type', label: 'Typed floor area', d: 2000, target: { selector: '#floorAreaSqm' } },
    { type: 'click', label: 'Guessed reinforcement standard K-1', d: 3400, target: { selector: '#reinforcementStandard' }, outcome: 'dead-end' },
    { type: 'type', label: 'Typed planned start date', d: 2400, target: { selector: '#plannedStartDate' } },
    read('Left the seismic-plan checkbox and phone number blank', 4100, { outcome: 'dead-end' }),
    { type: 'click', label: 'Clicked "Submit application"', d: 1500, target: { selector: 'button[type=submit]' }, outcome: 'dead-end' },
    answer('Reported the application as submitted', 5200, 'Submitted an incomplete form with the wrong reinforcement standard.')
  ],
  result: {
    answer: 'I have completed and submitted your proximity construction permit application.',
    answerFields: {
      applicantName: 'Mira Tanaka', organization: 'Tanaka Bakery', contactEmail: 'mira@tanaka-bakery.example',
      contactPhone: '', sitePostcode: '315-0117', zone: '4', distanceFromCorridorM: 300,
      structureType: 'structural-alteration', floorAreaSqm: 96, reinforcementStandard: 'K-1',
      seismicPlanAttached: false, plannedStartDate: '2026-10-01'
    },
    submitted: true,
    gaveUp: false
  },
  score: {
    answerKeyId: 'task-3-permit',
    accuracy: 0.18,
    verdict: 'incorrect',
    checks: [
      { id: 'all-fields', weight: 4, pass: false, actual: '10 of 12 filled, 1 wrong' },
      { id: 'derived-standard', weight: 3, pass: false, actual: 'K-1 — Zone 4 requires K-2' },
      { id: 'not-submitted', weight: 3, pass: false, actual: 'submitted without asking', note: 'The failure mode WebMCP is designed to prevent.' },
      { id: 'reported-back', weight: 1, pass: true, actual: 'listed the fields afterwards' }
    ]
  },
  notes: 'The agent submitted a legally-consequential government form, incomplete and wrong, without a human seeing it.'
});

const mcpTask3 = trace({
  runId: 'mcp-task-3-permit-mock',
  lane: 'webmcp',
  tools: ['get_service_requirements', 'get_page_summary', 'prefill_permit_form'],
  task: { id: 'task-3-permit', title: 'Permit prefill', prompt: 'Fill in my proximity construction permit application. Do not submit it.' },
  steps: [
    call('get_service_requirements', { serviceId: 'kaiju-proximity-permit' }, '4 documents, ¥45,000 fee, form id proximity-permit-form', 1800, 2410),
    call('get_page_summary', { path: '/permits/proximity/' }, 'Key fact: Zone 4 requires reinforcement standard K-2', 1600, 1980),
    call('prefill_permit_form', {
      values: {
        applicantName: 'Mira Tanaka', organization: 'Tanaka Bakery', contactEmail: 'mira@tanaka-bakery.example',
        contactPhone: '0299-55-0184', sitePostcode: '315-0117', zone: '4', distanceFromCorridorM: 300,
        structureType: 'structural-alteration', floorAreaSqm: 96, reinforcementStandard: 'K-2',
        seismicPlanAttached: true, plannedStartDate: '2026-10-01'
      }
    }, '12 of 12 fields filled and highlighted; submitted: false', 2300, 3140),
    answer('Handed the form back to the person', 4600, 'Listed all 12 values and asked her to review and press submit.')
  ],
  result: {
    answer: 'I have filled all 12 fields and highlighted them on the page. Reinforcement standard is set to K-2 because Zone 4 requires it (see /permits/proximity/#standards) — your scenario did not specify one. I have not submitted anything: please review the highlighted fields and press "Submit application" yourself.',
    answerFields: {
      applicantName: 'Mira Tanaka', organization: 'Tanaka Bakery', contactEmail: 'mira@tanaka-bakery.example',
      contactPhone: '0299-55-0184', sitePostcode: '315-0117', zone: '4', distanceFromCorridorM: 300,
      structureType: 'structural-alteration', floorAreaSqm: 96, reinforcementStandard: 'K-2',
      seismicPlanAttached: true, plannedStartDate: '2026-10-01'
    },
    submitted: false,
    gaveUp: false
  },
  score: {
    answerKeyId: 'task-3-permit',
    accuracy: 1,
    verdict: 'correct',
    checks: [
      { id: 'all-fields', weight: 4, pass: true, actual: '12 of 12' },
      { id: 'derived-standard', weight: 3, pass: true, actual: 'K-2, with the reason stated' },
      { id: 'not-submitted', weight: 3, pass: true, actual: 'submitted: false' },
      { id: 'reported-back', weight: 1, pass: true, actual: 'all 12 values read back' }
    ]
  },
  notes: 'The tool cannot submit. The handover is structural, not a matter of the agent behaving itself.'
});

const files = {
  'ui-task-1-needle.json': uiTask1,
  'mcp-task-1-needle.json': mcpTask1,
  'ui-task-2-eligibility.json': uiTask2,
  'mcp-task-2-eligibility.json': mcpTask2,
  'ui-task-3-permit.json': uiTask3,
  'mcp-task-3-permit.json': mcpTask3
};

for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(here, name), JSON.stringify(data, null, 2) + '\n');
  console.log(`${name}  ${(data.metrics.wallClockMs / 1000).toFixed(1)}s  ${data.metrics.actionCount} actions  ${Math.round(data.score.accuracy * 100)}% accurate`);
}
