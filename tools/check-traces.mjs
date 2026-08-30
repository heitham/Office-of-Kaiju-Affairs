/**
 * Validate baseline traces against baselines/trace.schema.json.
 *
 *   node tools/check-traces.mjs
 *
 * No JSON Schema library (this repo has no dependencies), so this checks the
 * parts of the schema that actually bite: required fields, unknown properties
 * where additionalProperties is false, enum membership, and the index's
 * promotion invariant. That is the exact class of error that blocked the
 * drift-race session's handover — the root schema forbade extra properties and
 * did not yet declare the ones we had agreed to add.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'baselines');
/** Read a required input, failing with a sentence rather than a stack trace. */
async function required(path, what) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.error(
      `\ncannot validate: ${what} is missing or unreadable at ${path}\n` +
      `  ${error.code === 'ENOENT' ? 'File not found.' : error.message}\n` +
      `  This checker expects a full repo layout: baselines/trace.schema.json,\n` +
      `  baselines/index.json and arena/answer-keys.json alongside the traces.\n`
    );
    process.exit(2);
  }
}

const schema = await required(join(dir, 'trace.schema.json'), 'the trace schema');

const problems = [];
const note = (file, message) => problems.push(`${file}: ${message}`);

/** Recursively check one value against a schema node. */
function validate(value, node, path, file) {
  if (!node || typeof node !== 'object') return;

  if (node.const !== undefined && value !== node.const) {
    note(file, `${path} must be ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
  }
  if (node.enum && value !== undefined && !node.enum.includes(value)) {
    note(file, `${path} must be one of ${node.enum.join(' | ')}, got ${JSON.stringify(value)}`);
  }

  if (node.type === 'array' && Array.isArray(value)) {
    value.forEach((item, i) => validate(item, node.items, `${path}[${i}]`, file));
    return;
  }

  if (value && typeof value === 'object' && !Array.isArray(value) && node.properties) {
    for (const key of node.required || []) {
      if (value[key] === undefined) note(file, `${path}.${key} is required but missing`);
    }
    for (const [key, sub] of Object.entries(value)) {
      if (!node.properties[key]) {
        if (node.additionalProperties === false) {
          note(file, `${path}.${key} is not declared in the schema (additionalProperties: false)`);
        }
        continue;
      }
      validate(sub, node.properties[key], `${path}.${key}`, file);
    }
  }
}

const index = await required(join(dir, 'index.json'), 'the baselines index');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !['index.json', 'trace.schema.json'].includes(f));

console.log(`\ntrace validation — ${files.length} trace file(s) against trace.schema.json v${schema.properties.traceVersion.const}\n`);

for (const file of files) {
  const trace = JSON.parse(await readFile(join(dir, file), 'utf8'));
  validate(trace, schema, '', file);

  // Steps must be ordered by tMs — the Arena plays every lane off one clock.
  const times = (trace.steps || []).map((s) => s.tMs);
  if (times.some((t, i) => i && t < times[i - 1])) note(file, 'steps are not ordered by tMs');

  // A recorded submission on the permit task is a task failure, not a detail.
  if (trace.task?.id === 'task-3-permit' && trace.result?.submitted === true && trace.score?.verdict === 'correct') {
    note(file, 'submitted: true cannot score verdict "correct" on task-3-permit');
  }
}

// Two agent tiers must never blend inside one group. The Arena's computed
// figures aggregate passes, so a group holding both a strong and a weak model
// would silently report their average as a single result.
const modelOf = new Map();
for (const file of files) {
  const trace = JSON.parse(await readFile(join(dir, file), 'utf8'));
  modelOf.set(file, trace.agent?.model || null);
}

// Every indexed file must exist, and each task+lane needs exactly one promoted pass.
const present = new Set(files);
const groups = new Map();
for (const run of index.runs) {
  if (!present.has(run.file)) note('index.json', `references ${run.file}, which is not present`);
  const key = `${run.taskId}/${run.lane}/${run.tier || '-'}/r${run.round || 1}`;
  groups.set(key, (groups.get(key) || []).concat(run));
}
for (const [key, runs] of groups) {
  const promoted = runs.filter((r) => r.promoted !== false && (r.promoted === true || runs.length === 1));
  if (promoted.length !== 1) {
    note('index.json', `${key} has ${promoted.length} promoted passes, expected exactly 1 (of ${runs.length} recorded)`);
  }

  const models = new Set(runs.map((r) => modelOf.get(r.file)).filter(Boolean));
  const tiers = new Set(runs.map((r) => r.tier).filter(Boolean));
  if (models.size > 1 && tiers.size < models.size) {
    note('index.json',
      `${key} mixes ${models.size} agent models (${[...models].join(', ')}) without distinct \`tier\` values. ` +
      `Give each tier its own tier id — the Arena aggregates passes within a group, so mixing tiers would ` +
      `report their average as one result.`);
  }
}
// A trace may be deliberately unindexed, but only if index.withheld says so and
// gives a reason. Silence is the thing we are guarding against, not absence.
for (const file of files) {
  if (index.runs.some((r) => r.file === file)) continue;
  const trace = JSON.parse(await readFile(join(dir, file), 'utf8'));
  const cover = (index.withheld || []).find((w) => w.taskId === trace.task?.id && w.lane === trace.lane);
  if (!cover) {
    note('index.json', `${file} exists but is neither indexed nor covered by an index.withheld entry — the Arena would silently not load it`);
  } else if (!cover.reason) {
    note('index.json', `${file} is withheld with no reason given — a withheld lane must say why on the page`);
  }
}

// Rounds. Both rounds stay published — hiding round 1 would make the fix
// unfalsifiable — so the index must say which one the figures describe.
const roundsPresent = [...new Set(index.runs.map((r) => r.round || 1))].sort();
if (roundsPresent.length > 1) {
  if (!index.headlineRound) {
    note('index.json', `runs span rounds ${roundsPresent.join(' and ')} but headlineRound is not set — the Arena would not know which round its figures describe`);
  } else if (!roundsPresent.includes(index.headlineRound)) {
    note('index.json', `headlineRound is ${index.headlineRound}, which has no recorded runs (present: ${roundsPresent.join(', ')})`);
  }
  for (const round of roundsPresent) {
    if (!(index.rounds || []).some((r) => r.round === round && r.label)) {
      note('index.json', `round ${round} has runs but no entry with a label in index.rounds — a before/after with no "before" and "after" is a bare number change`);
    }
  }
}

// A bare accuracy gap between the lanes reads as "the tools are less accurate".
// That may not be what happened — on task 1 both lanes answered correctly and
// only the scoring of one check differed. So a divergence must ship with its
// explanation, and the build fails rather than publishing the number alone.
const keys = await required(join(root, 'arena', 'answer-keys.json'), 'the answer keys');
// Mean across passes, not the promoted one. Promotion picks the weakest run for
// the replay, and two lanes' weakest runs can coincide while their means differ
// sharply — which is exactly the case on task 3.
const accOf = async (taskId, lane, tier) => {
  const passes = index.runs.filter((r) => r.taskId === taskId && r.lane === lane
    && (tier === null ? !r.tier : r.tier === tier) && present.has(r.file));
  if (!passes.length) return null;
  const accs = [];
  for (const p of passes) {
    const trace = JSON.parse(await readFile(join(dir, p.file), 'utf8'));
    if (trace.score?.accuracy != null) accs.push(trace.score.accuracy);
  }
  return accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
};

const tiers = [...new Set(index.runs.map((r) => r.tier).filter(Boolean))];

// The index is regenerated by the recording session, which does not own the
// presentation fields. A regeneration that drops them would silently remove the
// tier comparison from the page and leave the headline tier to be guessed.
if (tiers.length > 1) {
  if (!index.headlineTier) {
    note('index.json', `runs span tiers ${tiers.join(' and ')} but headlineTier is not set — the figures would not say which model they describe`);
  } else if (!tiers.includes(index.headlineTier)) {
    note('index.json', `headlineTier is "${index.headlineTier}", which has no recorded runs (present: ${tiers.join(', ')})`);
  }
  for (const tier of tiers) {
    if (!(index.tiers || []).some((t) => t.tier === tier && t.label)) {
      note('index.json', `tier "${tier}" has runs but no entry with a label in index.tiers — the comparison section needs a name for each model`);
    }
  }
}
const untiered = index.runs.filter((r) => !r.tier);
if (tiers.length && untiered.length) {
  note('index.json', `${untiered.length} run(s) carry no tier while others do — one model would render as two, "${tiers[0]}" and untiered. Stamp every run from its own agent.model.`);
}
for (const task of keys.tasks) {
  for (const tier of (tiers.length ? tiers : [null])) {
    const ui = await accOf(task.id, 'ui-guessing', tier);
    const mcp = await accOf(task.id, 'webmcp', tier);
    if (ui == null || mcp == null || ui === mcp) continue;
    if (!task.laneDivergence?.headline || !task.laneDivergence?.body) {
      note('arena/answer-keys.json',
        `${task.id}${tier ? ` (${tier})` : ''} means ${ui.toFixed(2)} (ui) vs ${mcp.toFixed(2)} (webmcp) but has ` +
        `no laneDivergence explanation. Publishing the gap without the mechanism misrepresents it.`);
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join('\n') + '\n');
  process.exit(1);
}
console.log(groups.size
  ? `all traces valid; ${groups.size} task+lane group(s), one promoted pass each\n`
  : 'no runs indexed yet — the Arena will say so rather than render anything\n');
