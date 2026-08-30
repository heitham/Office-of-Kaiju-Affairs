/**
 * Eligibility rule evaluation.
 *
 * Rules ship as data in the manifest (and, optionally, inline on the page), so
 * the CMS owns the policy and the runtime stays a dumb, auditable evaluator.
 * Every outcome carries a citation back to the page that states the rule —
 * an agent should never have to take our word for it.
 */

const OPERATORS = {
  eq: (a, b) => a === b || String(a) === String(b),
  ne: (a, b) => !(a === b || String(a) === String(b)),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  in: (a, b) => Array.isArray(b) && b.some((v) => String(v) === String(a)),
  nin: (a, b) => Array.isArray(b) && !b.some((v) => String(v) === String(a)),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()),
  between: (a, b) => Array.isArray(b) && Number(a) >= Number(b[0]) && Number(a) <= Number(b[1]),
  exists: (a, b) => (b === false ? a == null || a === '' : a != null && a !== ''),
  truthy: (a) => a === true || a === 'true' || a === 'yes' || a === 1 || a === '1'
};

/** Evaluate one condition node against the answer object. */
export function matches(condition, answers) {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition.all)) return condition.all.every((c) => matches(c, answers));
  if (Array.isArray(condition.any)) return condition.any.some((c) => matches(c, answers));
  if (condition.not) return !matches(condition.not, answers);

  const op = OPERATORS[condition.op];
  if (!op) return false;
  return Boolean(op(answers[condition.field], condition.value));
}

/** Render a condition as a short requirement a person can read. */
const OP_WORDS = {
  eq: 'must be', ne: 'must not be', gt: 'must be more than', gte: 'must be at least',
  lt: 'must be under', lte: 'must be at most', in: 'must be one of', nin: 'must not be one of',
  contains: 'must contain', between: 'must be between', exists: 'must be provided', truthy: 'must be true'
};

export function describeCondition(condition) {
  if (!condition || typeof condition !== 'object') return '';
  if (Array.isArray(condition.all)) return condition.all.map(describeCondition).filter(Boolean).join(' and ');
  if (Array.isArray(condition.any)) return condition.any.map(describeCondition).filter(Boolean).join(' or ');
  if (condition.not) return `not (${describeCondition(condition.not)})`;
  const word = OP_WORDS[condition.op] || condition.op;
  const value = Array.isArray(condition.value) ? condition.value.join(' or ') : condition.value;
  return value === undefined ? `${condition.field} ${word}` : `${condition.field} ${word} ${value}`;
}

/** The answers a condition actually reads, so we can show what they were. */
function fieldsIn(condition, out = []) {
  if (!condition || typeof condition !== 'object') return out;
  for (const key of ['all', 'any']) {
    if (Array.isArray(condition[key])) condition[key].forEach((c) => fieldsIn(c, out));
  }
  if (condition.not) fieldsIn(condition.not, out);
  if (condition.field) out.push(condition.field);
  return out;
}

/** Which declared questions the caller has not answered yet. */
export function missingAnswers(ruleset, answers) {
  return (ruleset.questions || [])
    .filter((q) => q.required !== false)
    .filter((q) => answers[q.id] == null || answers[q.id] === '')
    .map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      options: q.options || undefined
    }));
}

/**
 * Run a ruleset. The first matching rule that declares an `outcome` decides the
 * outcome; every matching rule contributes grants, documents and reasons, so a
 * fee waiver can attach to an eligibility decision without a second pass.
 *
 * @param {object} ruleset
 * @param {Record<string, unknown>} answers
 */
export function evaluate(ruleset, answers = {}) {
  const missing = missingAnswers(ruleset, answers);
  const fired = [];
  const grants = new Set();
  const documents = new Set();
  const citations = [];
  let outcome = null;

  for (const rule of ruleset.rules || []) {
    if (!matches(rule.when, answers)) continue;
    fired.push({
      id: rule.id,
      description: rule.description || '',
      outcome: rule.outcome || null,
      citation: rule.citation || null
    });
    (rule.grants || []).forEach((g) => grants.add(g));
    (rule.requiredDocuments || []).forEach((d) => documents.add(d));
    if (rule.citation) citations.push(rule.citation);
    if (!outcome && rule.outcome) outcome = rule.outcome;
  }

  const fallback = ruleset.defaultOutcome || { outcome: 'undetermined' };
  if (!outcome) {
    outcome = fallback.outcome;
    if (fallback.citation) citations.push(fallback.citation);
  }

  // Outcome-keyed document lists let the CMS answer "what do I bring?" from the
  // same ruleset that produced the decision.
  const byOutcome = (ruleset.requiredDocumentsByOutcome || {})[outcome] || [];
  byOutcome.forEach((d) => documents.add(d));

  // Rules that could have granted something and did not. Without these the tool
  // answers "no waiver" and never says why, so the person cannot tell what would
  // change the answer — which is the thing they most need to know.
  const unmet = (ruleset.rules || [])
    .filter((rule) => (rule.grants?.length || rule.requiredDocuments?.length) && !fired.some((f) => f.id === rule.id))
    .map((rule) => ({
      id: rule.id,
      description: rule.description || '',
      wouldGrant: rule.grants || [],
      requirement: describeCondition(rule.when),
      yourAnswers: Object.fromEntries(
        [...new Set(fieldsIn(rule.when))].map((field) => [field, answers[field] ?? null])
      ),
      citation: rule.citation || null
    }));

  return {
    rulesetId: ruleset.id,
    outcome,
    determined: missing.length === 0,
    missingAnswers: missing,
    grants: [...grants],
    requiredDocuments: [...documents],
    matchedRules: fired,
    unmetRules: unmet,
    citations,
    sourcePath: ruleset.sourcePath || null
  };
}
