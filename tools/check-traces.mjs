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
const schema = JSON.parse(await readFile(join(dir, 'trace.schema.json'), 'utf8'));

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

const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
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
  const key = `${run.taskId}/${run.lane}`;
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
for (const file of files) {
  if (!index.runs.some((r) => r.file === file)) note('index.json', `${file} exists but is not indexed — the Arena will not load it`);
}

// A bare accuracy gap between the lanes reads as "the tools are less accurate".
// That may not be what happened — on task 1 both lanes answered correctly and
// only the scoring of one check differed. So a divergence must ship with its
// explanation, and the build fails rather than publishing the number alone.
const keys = JSON.parse(await readFile(join(root, 'arena', 'answer-keys.json'), 'utf8'));
const accOf = async (taskId, lane) => {
  const passes = index.runs.filter((r) => r.taskId === taskId && r.lane === lane);
  const promoted = passes.find((r) => r.promoted) || passes[0];
  if (!promoted || !present.has(promoted.file)) return null;
  const trace = JSON.parse(await readFile(join(dir, promoted.file), 'utf8'));
  return trace.score?.accuracy ?? null;
};

for (const task of keys.tasks) {
  const ui = await accOf(task.id, 'ui-guessing');
  const mcp = await accOf(task.id, 'webmcp');
  if (ui == null || mcp == null || ui === mcp) continue;
  if (!task.laneDivergence?.headline || !task.laneDivergence?.body) {
    note('arena/answer-keys.json',
      `${task.id} scores ${ui} (ui) vs ${mcp} (webmcp) but has no laneDivergence explanation. ` +
      `Publishing the gap without the mechanism misrepresents it — add laneDivergence.headline and .body.`);
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join('\n') + '\n');
  process.exit(1);
}
console.log(groups.size
  ? `all traces valid; ${groups.size} task+lane group(s), one promoted pass each\n`
  : 'no runs indexed yet — the Arena will say so rather than render anything\n');
