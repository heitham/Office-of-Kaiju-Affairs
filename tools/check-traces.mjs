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
}
for (const file of files) {
  if (!index.runs.some((r) => r.file === file)) note('index.json', `${file} exists but is not indexed — the Arena will not load it`);
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join('\n') + '\n');
  process.exit(1);
}
console.log(`all traces valid; ${groups.size} task+lane group(s), one promoted pass each\n`);
