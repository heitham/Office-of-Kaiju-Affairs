# Interface contracts

Three sessions build this repo and never read each other's code. These are the
only surfaces between them. Once a contract here is confirmed, it does not
change silently — propose the change, get agreement, then edit this file in the
same commit as the code.

| Contract | Producer | Consumer | Status |
|---|---|---|---|
| [1. The script tag](#1-the-script-tag) | RIFT publisher | `runtime/` | **Confirmed v1.0 — frozen** |
| [2. `manifest.json`](#2-manifestjson) | RIFT publisher | `runtime/` | **Confirmed v1.0 — frozen** |
| [3. Baseline traces](#3-baseline-traces) | drift-race session | `arena/` | **Proposed** |
| [4. Answer keys](#4-answer-keys) | this session | drift-race scoring, Arena | Authored, `arena/answer-keys.json` |

Reference implementations of 1 and 2 live in `runtime/mock/manifest.json` and
`scaffold/`; of 3, in `baselines/*.json` (every mock is stamped `agent.name: "MOCK"`).

---

## 1. The script tag

Every published page emits exactly one line, and nothing else agent-related:

```html
<script type="module" src="/runtime/kaiju-webmcp.js" data-manifest="/manifest.json"></script>
```

| Attribute | Required | Meaning |
|---|---|---|
| `type="module"` | yes | The runtime is ES modules. A classic script will not load it. |
| `src` | yes | Root-absolute. The runtime resolves its own `src/` files relative to itself. |
| `data-manifest` | no | Manifest URL. Defaults to `/manifest.json`. |
| `data-page` | no | Overrides the manifest page key for this page. Only needed if the served URL differs from the manifest `path` (e.g. a page served from a hashed filename). Otherwise the runtime uses `location.pathname`. |
| `data-debug` | no | `"true"` logs the registration result to the console. Off in production. |

Placement: anywhere in `<head>` or `<body>`. It is deferred by virtue of being a
module, so it never blocks rendering.

The runtime registers all seven tools on every page. Page-scoped tools
(`prefill_permit_form`) work out where they are from `location.pathname` and
return a helpful error naming the right page if called elsewhere. Do **not**
vary the script tag per page.

**Form pages additionally need** the form element to carry the attribute the
manifest's form descriptor selects on — by default
`data-kaiju-form="<formId>"` — and each field to carry the `id` its descriptor
names. See `scaffold/permits/proximity/apply/index.html` for a working example.

---

## 2. `manifest.json`

**Location:** `site/manifest.json`, published alongside the site. `build.mjs`
copies it to the deploy root as `/manifest.json`. Publishing it inside `site/`
keeps the CMS writing to exactly one directory.

### How RIFT produces it (confirmed by the publisher session)

Recorded here so this side knows what the fields actually come from, and which
authoring mistakes produce which missing data.

| Manifest field | Comes from |
|---|---|
| `pages[].id` | **The page path.** Item UUIDs are not stable across the CMS's edit→publish succession; paths are the stable identity. The runtime resolves by path or id and normalises both, so this is safe. |
| `pages[].summary` | The CMS's per-page short description, falling back to the page's first paragraph. |
| `pages[].keyFacts` | Elements carrying `data-agent-fact="Label"` in the authored HTML; the value is the element's text. |
| `pages[].keywords` | `data-agent-keywords="a, b"` in the authored HTML, comma/semicolon split and deduped. |
| `pages[].headings[].anchor` | **Only present when the authored heading has an `id`.** A heading with no id yields no anchor. |
| `pages[].text` | First 2,048 characters of `<main>`, falling back to `<body>`. `wordCount` is from the full text. |
| `services` / `eligibility` / `forms` / `offices` | Authored as JSON in a `<script type="application/json" data-agent-data>` block on a CMS page, which is itself excluded from `pages[]`. |
| `services[].pageIds` | May be authored as paths. RIFT resolves them, drops any that aren't in `pages[]`, and back-fills `pages[].serviceIds`. |
| `forms` | The key is **omitted entirely** when no form is authored. The runtime treats a missing `forms`/`eligibility`/`offices` key as "none published". |

**The manifest regenerates on full-site publishes only.** It is built from
rendered HTML, so it cannot drift from the content *of the publish that produced
it* — but a subsequent single-item publish edits a page without regenerating the
manifest. Consequence for this repo: **the last publish before recording
baselines, and the last publish before the demo, must be a full publish.** A
single-item fix to `/claims/faq/` after a full publish will leave the manifest
stating the old rule while the page states the new one, and task 1 breaks in a
way nobody sees until it is on camera.

The coupling check (`npm run check`) is the backstop for exactly this: it runs
the real rule engine and the real search ranking against the deployed manifest
and fails the build if the answers no longer match `arena/answer-keys.json`.

**Full worked example:** `runtime/mock/manifest.json` — 18 pages, 3 services, 1
ruleset, 1 form, 3 offices. Match its shape and the runtime works unchanged.

### Top level

```jsonc
{
  "manifestVersion": "1.0",              // required, bump on breaking changes
  "generatedAt": "2026-08-29T12:00:00Z", // required, ISO 8601
  "generator": { "name": "RIFT", "version": "..." },
  "site":        { ... },                // required
  "pages":       [ ... ],                // required
  "services":    [ ... ],                // required (may be empty)
  "eligibility": [ ... ],                // optional — omit and check_eligibility reports none published
  "forms":       [ ... ],                // optional
  "offices":     [ ... ]                 // optional
}
```

Unknown extra keys are ignored, so the CMS may add fields ahead of the runtime.

### `site`

`id`, `name`, `shortName`, `baseUrl`, `language`, `description`. Only `name` is
used in output today; the rest is provenance.

### `pages[]` — the search and summary index

| Field | Req | Notes |
|---|---|---|
| `id` | yes | Stable across publishes. Any string. |
| `path` | yes | Root-absolute, trailing slash, e.g. `/claims/faq/`. The runtime normalises `/x`, `/x/` and `/x/index.html` to the same key, so exact form is not critical — consistency is. |
| `title` | yes | |
| `section` | no | Single token used by `search_site`'s `section` filter, e.g. `claims`. |
| `breadcrumb` | no | `["Home","Claims","FAQ"]`. |
| `summary` | **yes in practice** | 1–3 plain sentences. This is what an agent reads instead of the page. A weak summary is the single biggest quality risk in this manifest. |
| `keywords` | no | Weighted highly in search. Include the words the navigation does *not* use. |
| `keyFacts` | no | `[{ "label": "...", "value": "..." }]`. Weighted highly, and surfaced verbatim by `get_page_summary`. **Task 1 depends on the fee-waiver rule appearing here on `/claims/faq/`.** |
| `headings` | no | `[{ "level": 2, "text": "...", "anchor": "#..." }]`. |
| `links.internal` | no | Paths. Returned as `relatedPaths`. |
| `serviceIds` | no | Services this page belongs to. |
| `updated`, `wordCount` | no | |
| `text` | no | Flattened plain text, lowest search weight. Cap it — ~2 KB per page keeps the whole manifest small enough to fetch once. |

Field search weights: `title` 6, `keywords` 5, `keyFacts` 4, `headings` 3,
`summary` 2, `breadcrumb` 2, `text` 1, with a phrase-match bonus and a penalty
for covering only part of the query.

### `services[]`

`id`, `name`, `category`, `summary`, `entryPath`, `pageIds`, `audience`, plus:

```jsonc
"requirements": {
  "documents": [{ "id", "name", "description", "required": true }],
  "fields":    [{ "id", "label", "type", "required", "description" }],
  "fees":      [{ "id", "label", "amount": 12000, "currency": "¥", "waivable": true, "notes" }],
  "deadlines": [{ "id", "label", "value" }],
  "processingTime": "10 business days",
  "sourcePath": "/permits/proximity/requirements/"
},
"eligibilityRulesetId": "damage-compensation-v1" | null,
"formId": "proximity-permit-form" | null
```

### `eligibility[]` — rulesets

```jsonc
{
  "id": "damage-compensation-v1",
  "serviceId": "damage-compensation",
  "sourcePath": "/claims/eligibility/",
  "questions": [
    { "id": "zone", "label": "...", "type": "enum", "options": ["1","2","3","4","5"], "required": true }
  ],
  "rules": [
    {
      "id": "repeat-claimant-fee-waiver",
      "description": "Plain-English statement of the rule.",
      "when": { "all": [{ "field": "incidentsLast12Months", "op": "gte", "value": 2 }] },
      "outcome": "eligible" | "ineligible" | "referral",   // optional
      "grants": ["assessment-fee-waiver"],                  // optional
      "requiredDocuments": ["income-certificate"],          // optional
      "citation": { "path": "/claims/faq/", "anchor": "#fee-waivers", "quote": "..." }
    }
  ],
  "defaultOutcome": { "outcome": "referral", "reason": "...", "citation": { ... } },
  "requiredDocumentsByOutcome": { "eligible": ["incident-report"] }
}
```

Evaluation semantics, which the CMS's rule authoring must assume:

- Every rule whose `when` matches **fires**. All fired rules contribute their
  `grants`, `requiredDocuments` and `citation`.
- The **first** fired rule that declares an `outcome` sets the outcome. Order
  matters: put disqualifiers (`ineligible`) before qualifiers.
- If no fired rule declares an outcome, `defaultOutcome` applies.
- Missing required answers do not block evaluation — the result comes back with
  `determined: false` and a list of what is still needed.

Condition grammar: `{ all: [...] }`, `{ any: [...] }`, `{ not: {...} }`, or a
leaf `{ field, op, value }`. Operators: `eq` `ne` `gt` `gte` `lt` `lte` `in`
`nin` `contains` `between` `exists` `truthy`.

### `forms[]`

```jsonc
{
  "id": "proximity-permit-form",
  "serviceId": "kaiju-proximity-permit",
  "path": "/permits/proximity/apply/",
  "selector": "form[data-kaiju-form=\"proximity-permit-form\"]",
  "submitLabel": "Submit application",
  "fields": [
    { "name": "zone", "selector": "#zone", "type": "select", "label": "Evacuation zone",
      "required": true, "options": [{ "value": "4", "label": "Zone 4" }] },
    { "name": "sitePostcode", "selector": "#sitePostcode", "type": "text", "label": "Site postcode",
      "required": true, "pattern": "^[0-9]{3}-[0-9]{4}$", "maxLength": 120 }
  ]
}
```

`type`: `text` `email` `tel` `number` `date` `select` `checkbox` `radio`.
Constraints (`options`/`enum`, `pattern`, `maxLength`, numeric) are enforced by
the runtime *before* it touches the DOM — a rejected value is reported back to
the agent with the reason, and the field is left alone. A field the manifest
does not declare cannot be written to at all.

### `offices[]`

`id`, `name`, `region`, `address`, `hours`, `phone`, `email`, `zones[]`,
`servicesOffered[]`, `path`, and `evacuationRoutes[]` of
`{ id, name, zones[], description, assemblyPoint, path }`.

### Things that will break the runtime

- `pages[]` missing or not an array → nothing works. Everything else degrades
  gracefully to "not published".
- A `forms[].path` that does not match the page the form is actually served on →
  `prefill_permit_form` refuses, by design.
- A `citation.path` pointing at a page not in `pages[]` → the citation still
  renders, but the agent gets a link it cannot summarise.

---

## 3. Baseline traces

**Location:** `baselines/`. **Schema:** `baselines/trace.schema.json` (JSON
Schema 2020-12). **Index:** `baselines/index.json` — the Arena reads this to
know which files exist; it never guesses filenames.

One file per run: one agent, one task, one lane.

```jsonc
{
  "traceVersion": "1.0",
  "runId": "ui-task-1-needle-r1",
  "recordedAt": "2026-08-31T09:12:00Z",
  "lane": "ui-guessing" | "webmcp",
  "agent": { "name", "model", "harness", "toolsAvailable": [] },
  "site":  { "baseUrl", "manifestVersion", "commit" },
  "task":  { "id": "task-1-needle", "title", "prompt" },   // id MUST match arena/answer-keys.json
  "steps": [
    {
      "index": 1, "tMs": 0, "durationMs": 3100,
      "type": "navigate",              // navigate click scroll read search type tool_call think answer prefill
      "label": "Loaded the home page", // one line, shown in the replay
      "detail": "optional second line — what it saw or concluded",
      "target": { "path", "url", "selector", "text" },
      "toolCall": { "name", "arguments": {}, "resultSummary", "resultBytes", "isError" },
      "cost": { "bytes", "tokensIn", "tokensOut" },
      "outcome": "ok" | "dead-end" | "error"
    }
  ],
  "result":  { "answer": "verbatim final answer", "answerFields": {}, "submitted": false, "gaveUp": false },
  "metrics": { "wallClockMs", "actionCount", "toolCalls", "pageLoads", "deadEnds", "bytesTransferred" },
  "score":   { "answerKeyId", "accuracy": 0.29, "verdict": "correct|partial|incorrect|abandoned",
               "checks": [{ "id", "label", "weight", "pass", "actual", "note" }] },
  "notes": "one or two sentences a viewer reads under the replay"
}
```

### Multiple passes per task+lane

Recording one run tells you what happened once; recording several tells you
whether the agent is reliable, which is a different and more useful fact. The
index represents passes as separate entries:

```jsonc
{ "taskId": "task-3-permit", "lane": "ui-guessing", "file": "ui-task-3-permit-p1.json", "pass": 1, "promoted": false },
{ "taskId": "task-3-permit", "lane": "ui-guessing", "file": "ui-task-3-permit-p4.json", "pass": 4, "promoted": true }
```

- Exactly one entry per task+lane carries `promoted: true`. That is the run the
  Arena replays step by step and the one that appears on the scoreboard.
- Every other pass is still loaded. Their accuracies render as the run-to-run
  spread beneath the replay. An agent scoring 1.00, 1.00, 1.00 and 0.64 is not
  the same thing as one scoring 0.91, and averaging it away destroys the point.
- `pass`/`promoted` are optional. A single trace with neither is treated as
  pass 1, promoted.

### Declared scoring normalisations

`score.normalisations` is an array of plain-English sentences describing every
leniency applied when scoring, written so a judge can act on them. The Arena
renders them under the verdict. State them in the trace rather than only in the
scorer's source: a normalisation a reader cannot see is indistinguishable from
a thumb on the scale.

Notes for the recording session:

- `tMs` is **milliseconds from the start of the run**, and `steps` must be
  ordered by it. The Arena plays every lane of a task off one shared clock, so
  these numbers are the whole comparison — record real elapsed time, don't
  round to seconds.
- `outcome: "dead-end"` is what makes the slow lane legible: mark the steps that
  led nowhere. They render in red and feed `metrics.deadEnds`.
- `score.checks[].id` must match a check `id` in `arena/answer-keys.json` for
  that task, so the Arena can line the two up.
- `result.submitted` must be recorded honestly for `task-3-permit`. An agent
  that submitted the form failed the task regardless of the field values.
- Recording both lanes is welcome but only the `ui-guessing` lane is required —
  the WebMCP lane is the judge's own live run. Where a `webmcp` trace exists the
  Arena plays it side by side; where it doesn't, the lane is simply absent.

---

## 4. Answer keys

**Location:** `arena/answer-keys.json`. Authored in this session; the source of
truth for both scoring and the Arena's "check your agent's answer" panel.

Three tasks (`task-1-needle`, `task-2-eligibility`, `task-3-permit`), each with
a persona scenario, the prompt, the expected result, and weighted checks.

Machine-readable fields the coupling check consumes — the drift-race session may
use them too, rather than re-deriving the scenario from prose:

| Field | Purpose |
|---|---|
| `persona.answers` (task 2) | The prose scenario as a `check_eligibility` answers object. The check runs the real ruleset against it and compares outcome, grants and documents to `expected`. |
| `expected.mustAppearOnPage` (task 1) | Phrases that must survive the content reskin on the source page, or the answer key is wrong. |
| `expected.rankingQuery` (task 1) | The query `search_site` must rank the source page first for. |
| `expected.derivedField.mustAppearOnPage` (task 3) | The page and phrases the agent has to derive `K-2` from. If the content drops them the task becomes unsolvable. |

The
scenario facts and the expected outcomes are consistent with
`runtime/mock/manifest.json` — **if the published content changes a number
(fees, thresholds, zone rules), this file has to change with it.** That is the
one place where content and code are coupled, and it is deliberate: the answer
key is what makes the race falsifiable.
