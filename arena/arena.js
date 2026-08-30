/**
 * The Arena — scoreboard and replay theatre.
 *
 * Reads three files and renders everything from them:
 *   answer-keys.json          the 3 tasks, personas and correct answers
 *   ../baselines/index.json   which recorded runs exist
 *   ../baselines/<trace>.json one recorded run each
 *
 * No agent runs here. The fast lane is the judge's own agent, live in this tab.
 */

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

const LANES = {
  'ui-guessing': {
    name: 'Browsing agent',
    sub: 'Reads and navigates the public website.',
    cls: 'ui'
  },
  webmcp: {
    name: 'WebMCP agent',
    sub: 'Uses tools generated from the published website.',
    cls: 'mcp'
  }
};

/**
 * THE FOUR-KEY SELECTOR. Every rollup on this page goes through it.
 *
 * A trace belongs to a task, a lane, a model tier and a measurement round. Any
 * aggregate that drops one of those four silently averages things that are not
 * comparable. That mistake has now been made — and caught — in the index, in the
 * promotion tool, in the scoreboard, in the divergence check and in the
 * round comparison. Five times, in five separate implementations, by two people.
 * So there is one selector, and nothing aggregates without naming its keys.
 */
function cell(runs, { task, lane, tier, round } = {}) {
  return runs.filter((r) =>
    (task === undefined || r.taskId === task) &&
    (lane === undefined || r.lane === lane) &&
    (tier === undefined || r.tier === tier) &&
    (round === undefined || (r.round || 1) === round));
}

/** The loaded index, available to renderers that need its declared fields. */
let indexMeta = null;

const accOf = (rs) => rs.map((r) => r.trace.score?.accuracy).filter((a) => a != null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const meanBy = (rs, fn) => mean(rs.map(fn).filter((x) => x != null));
const fullMarks = (rs) => accOf(rs).filter((a) => a === 1).length;
/**
 * Total tokens an attempt cost: input and output, summed over its steps.
 *
 * Counting input alone gives 2.8x on this site rather than 2.4x. Input is the
 * more literal reading of "context", but the total is what an attempt actually
 * costs, and it is the figure two independent implementations reproduced from
 * these files. The card states the method so the number can be checked.
 */
const tokensOf = (r) => (r.trace.steps || [])
  .reduce((n, s) => n + (s.cost?.tokensIn || 0) + (s.cost?.tokensOut || 0), 0);

/** Human-readable names for the ids the rules and forms use internally. */
const LABELS = {
  'assessment-fee-waiver': 'Assessment-fee waiver',
  'hardship-supplement': 'Hardship supplement',
  'business-interruption-eligible': 'Business-interruption support',
  'award-reduced-by-insurance-payout': 'Award reduced by an insurance payout',
  'incident-report': 'Incident report',
  'damage-survey': 'Damage survey',
  'proof-of-ownership': 'Proof of ownership',
  'insurance-settlement-letter': 'Insurance settlement letter',
  'income-certificate': 'Income certificate',
  'business-registration': 'Business registration'
};
const human = (id) => LABELS[id] || id;

const KIND_LABEL = {
  navigate: 'load', click: 'click', scroll: 'scroll', read: 'read', search: 'search',
  type: 'type', tool_call: 'tool', think: 'think', answer: 'answer', prefill: 'prefill'
};

const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const fmtClock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
};
const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;

async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

/* ------------------------------------------------------------ WebMCP status */

function renderStatus() {
  const box = document.getElementById('status');
  const text = box.querySelector('.status-text');

  const paint = (api) => {
    if (api?.available) {
      box.className = 'status live';
      text.innerHTML =
        `Good news: this browser can use WebMCP. The Office has published ` +
        `<strong>${api.registered.length} tools</strong> your agent can call. `;
      const test = document.createElement('button');
      test.className = 'self-test';
      test.type = 'button';
      test.textContent = 'Check that the tools work';
      test.addEventListener('click', async () => {
        test.disabled = true;
        test.textContent = 'Asking the Office where it buried the fee-waiver policy…';
        try {
          const out = await api.call('search_site', { query: 'fee waiver repeat damage claims' });
          const top = out.structuredContent?.results?.[0];
          test.textContent = top
            ? `Found it. The Office returned ${top.path} as the top result.`
            : 'The Office returned no results, which is its own kind of answer.';
        } catch (error) {
          test.textContent = `The check failed: ${error.message}`;
        }
      });
      text.appendChild(test);
    } else {
      box.className = 'status absent';
      // The runtime's own reason is written for a developer console. This is the
      // sentence a judge reads, so the Arena supplies its own.
      text.textContent =
        'This browser cannot use WebMCP yet, so your agent cannot call the Office\'s tools from here. '
        + 'The recordings below still play. To try the tasks yourself, open this page in Chrome 150+ with '
        + 'the WebMCP flag enabled, or in the ChatGPT in-app browser.';
    }
  };

  if (globalThis.kaijuWebMCP) paint(globalThis.kaijuWebMCP);
  else {
    document.addEventListener('kaiju-webmcp:ready', (event) => paint(event.detail), { once: true });
    setTimeout(() => { if (!globalThis.kaijuWebMCP) paint(null); }, 2500);
  }
}

/* ----------------------------------------------------------------- loading */

async function loadRuns() {
  const index = await getJSON('../baselines/index.json');
  const runs = await Promise.all(
    index.runs.map(async (entry) => {
      try {
        return { ...entry, trace: await getJSON(`../baselines/${entry.file}`) };
      } catch (error) {
        console.warn(`[arena] could not load ${entry.file}`, error);
        return { ...entry, trace: null };
      }
    })
  );
  return { index, runs: runs.filter((r) => r.trace) };
}

/* ------------------------------------------------------------------ rounds */

const meanAccuracy = (rs) => {
  const a = rs.map((r) => r.trace.score?.accuracy).filter((x) => x != null);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
};

/**
 * Before/after for one task's tool lane — WITHIN ONE TIER.
 *
 * Averaging round 2's two model tiers together and comparing that against a
 * single-tier round 1 produced "64% to 84%" on the permit task, where the valid
 * sonnet-to-sonnet comparison is 64% to 93%. The tier is named beside the
 * figures so the scope is visible, not merely correct.
 */
function renderRounds(task, runs, host, index) {
  if (!host) return;
  const tier = index.headlineTier;
  const scoped = tier ? cell(runs, { tier }) : runs;
  const rounds = [...new Set(scoped.map((r) => r.round || 1))].sort();
  if (rounds.length < 2) return;

  const cells = rounds.map((round) => {
    const rs = cell(scoped, { lane: 'webmcp', round });
    return { round, mean: mean(accOf(rs)), n: rs.length,
             label: (index.rounds || []).find((x) => x.round === round)?.label || `Round ${round}` };
  }).filter((c) => c.mean != null && c.n);

  if (cells.length < 2) return;

  const first = cells[0], last = cells.at(-1);
  const delta = last.mean - first.mean;
  const smallest = (1 / Math.min(first.n, last.n)) * 0.2;
  const moved = Math.abs(delta) >= Math.max(0.05, smallest);
  const tierName = (index.tiers || []).find((t) => t.tier === tier)?.label || tier;

  host.hidden = false;
  host.innerHTML = `
    <h4>Before and after we fixed the tool${tierName ? ` · ${escapeHtml(tierName)}` : ''}</h4>
    <div class="round-cells">
      ${cells.map((c) => `<div class="round-cell${c === last ? ' now' : ''}">
          <p class="round-figure">${pct(c.mean)}</p>
          <p class="round-label">${escapeHtml(c.label)}</p>
          <p class="round-n">${c.n} attempt${c.n === 1 ? '' : 's'} with WebMCP</p>
        </div>`).join('<span class="round-arrow" aria-hidden="true">→</span>')}
    </div>
    <p class="round-note">${moved
      ? (delta > 0
          ? `The fix moved this task by ${pct(Math.abs(delta))}. Both rounds stay on this page; we did not remove the earlier one once the later one looked better.`
          : `This task got <strong>worse</strong> by ${pct(Math.abs(delta))} after the fix. We publish it because a result that goes the wrong way is still a result.`)
      : Math.abs(delta) < 0.005
        ? `Identical in both rounds. This task was already answered correctly every time, so there was nothing here for the fix to improve.`
        : `No measured change — the difference is ${pct(Math.abs(delta))} across ${last.n} attempts, which is about one checklist item on one run. What the fix did change is described above.`}</p>`;
}

/* ---------------------------------------------------------------- findings */

/**
 * What the recordings show, derived from the recordings.
 *
 * Every card names the scope its figure was computed over. Two figures from
 * different scopes sitting next to each other invite a comparison neither
 * supports — browsing at one model against WebMCP across two would read as a
 * 30-point gap that is really a difference in who was counted.
 */
function renderFindings(tasks, runs, index) {
  const host = document.getElementById('findings');
  if (!host) return;
  const tier = index?.headlineTier || null;
  const tierName = (index?.tiers || []).find((t) => t.tier === tier)?.label || tier || 'the baseline model';

  const browse = tier ? cell(runs, { lane: 'ui-guessing', tier }) : cell(runs, { lane: 'ui-guessing' });
  const toolsSameTier = tier ? cell(runs, { lane: 'webmcp', tier }) : cell(runs, { lane: 'webmcp' });
  const toolsAll = cell(runs, { lane: 'webmcp' });
  const browseAll = cell(runs, { lane: 'ui-guessing' });
  if (!browse.length) { host.hidden = true; return; }

  const loads = browse.map((r) => r.trace.metrics.pageLoads || 0).filter(Boolean);
  const deadEnds = browse.reduce((n, r) => n + (r.trace.metrics.deadEnds || 0), 0);
  const browseTok = meanBy(browse, tokensOf);
  const toolTok = meanBy(toolsSameTier, tokensOf);
  const ratio = browseTok && toolTok ? toolTok / browseTok : null;

  // Where the tools are cheaper, say so in the same breath as where they are not.
  const cheaper = tasks.filter((t) => {
    const b = meanBy(cell(runs, { task: t.id, lane: 'ui-guessing', tier }), tokensOf);
    const w = meanBy(cell(runs, { task: t.id, lane: 'webmcp', tier }), tokensOf);
    return b && w && w < b;
  });

  const cards = [
    {
      title: 'Browsing worked surprisingly well',
      figure: `${fullMarks(browse)} of ${browse.length}`,
      label: `${escapeHtml(tierName)} browsing attempts received full marks`,
      body: `A strong agent can navigate this site without WebMCP. Apparently surviving government navigation is one of its talents. The case for WebMCP does not depend on pretending otherwise.`
    },
    {
      title: 'The agent still had to find the right desk',
      figure: loads.length ? (Math.min(...loads) === Math.max(...loads) ? `${Math.min(...loads)}` : `${Math.min(...loads)}–${Math.max(...loads)}`) : '—',
      label: 'pages opened per browsing task',
      body: `Before answering, the browsing agent had to locate the right service, page, paragraph and exception. Like visiting a government office, but with fewer plastic chairs.`
    },
    {
      title: 'Bureaucratic detours remain undefeated',
      figure: `${deadEnds}`,
      label: `dead end${deadEnds === 1 ? '' : 's'} across the browsing attempts`,
      body: `These were pages or actions that did not contribute to the answer. The agent usually recovered. Mira still had to wait.`
    }
  ];

  if (ratio) {
    cards.push({
      title: ratio >= 1 ? 'The manifest was not free' : 'The tools cost less to run',
      figure: `${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}×`,
      label: `${ratio >= 1 ? 'more' : 'fewer'} tokens used by WebMCP on this small site`,
      body: ratio >= 1
        ? `The WebMCP route loads the complete site manifest, and re-sends seven tool descriptions on every turn. On a website this small that costs more than reading a few individual pages.${cheaper.length ? ` Not everywhere: on ${cheaper.length === 1 ? 'the ' + (cheaper[0].shortTitle || cheaper[0].title).toLowerCase() + ' task' : cheaper.length + ' of the three tasks'} the tools were the cheaper route.` : ''} A thousand-page agency may behave differently. This experiment did not test one, despite every government website's apparent ambition to become one.`
        : `Reading structured results cost less context than reading the pages they came from, even carrying the whole manifest.`
    });
  }

  const toolFull = fullMarks(toolsAll), browseFull = fullMarks(browseAll);
  cards.push({
    title: 'Tools did not guarantee a perfect answer',
    figure: `${toolFull} of ${toolsAll.length}`,
    label: 'WebMCP attempts received full marks, across both models',
    body: `Structured tools gave the agent better ingredients. The agent could still choose the wrong recipe — or forget to explain the result to Mira. WebMCP improves the publisher's contract with the agent; it does not replace the agent's judgment.` +
      (browseAll.length === toolsAll.length
        ? ` Measured the same way, browsing scored ${browseFull} of ${browseAll.length}${browseFull === toolFull ? ' — exactly the same' : ''}.`
        : '')
  });

  const method = host.querySelector('.findings-method');
  if (method) {
    method.textContent =
      `Token figures are the mean per attempt across all ${browse.length} recorded attempts per approach `
      + `(${tierName}, after the fix), counting input and output tokens: `
      + `${Math.round(toolTok).toLocaleString()} with WebMCP against ${Math.round(browseTok).toLocaleString()} browsing.`;
    method.hidden = !ratio;
  }

  host.hidden = false;
  host.querySelector('.findings-grid').innerHTML = cards
    .map((c) => `<div class="finding">
        <p class="finding-title">${escapeHtml(c.title)}</p>
        <p class="figure">${escapeHtml(c.figure)}</p>
        <p class="figure-label">${c.label}</p>
        <p class="figure-body">${escapeHtml(c.body)}</p>
      </div>`)
    .join('');
}

/* ------------------------------------------------------------------- tiers */

/** How much each lane loses when the model gets weaker. Same round, same site. */
function renderTiers(tasks, runs, index) {
  const host = document.getElementById('tiers');
  if (!host) return;
  const tiers = (index.tiers || []).map((t) => t.tier).filter((t) => runs.some((r) => r.tier === t));
  const base = index.headlineTier;
  const others = tiers.filter((t) => t !== base);
  if (!base || !others.length) { host.hidden = true; return; }
  const other = others[0];

  const cellMean = (taskId, lane, tier) => {
    const a = runs.filter((r) => r.taskId === taskId && r.lane === lane && r.tier === tier)
      .map((r) => r.trace.score?.accuracy).filter((x) => x != null);
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  };

  const rows = [];
  for (const task of tasks) {
    for (const lane of ['ui-guessing', 'webmcp']) {
      const b = cellMean(task.id, lane, base), o = cellMean(task.id, lane, other);
      if (b == null || o == null) continue;
      rows.push({ task, lane, base: b, other: o, delta: o - b });
    }
  }
  if (!rows.length) { host.hidden = true; return; }

  const informative = rows.filter((r) => !(r.base === 1 && r.other === 1));
  const byLane = (lane) => informative.filter((r) => r.lane === lane).map((r) => r.delta);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const uiDrop = avg(byLane('ui-guessing')), toolDrop = avg(byLane('webmcp'));

  const label = (t) => (index.tiers || []).find((x) => x.tier === t)?.label || t;
  const ceilingCount = rows.length - informative.length;

  host.hidden = false;
  host.innerHTML = `
    <h2>The smaller model benefited more from tools</h2>
    <p class="sub">
      We repeated the same three tasks using a smaller model. Both approaches lose
      accuracy. The question is whether they lose it equally.
    </p>
    <div class="scoreboard"><table class="board-table">
      <thead><tr><th>Task</th><th>Lane</th><th style="text-align:right">${escapeHtml(label(base))}</th>
        <th style="text-align:right">${escapeHtml(label(other))}</th><th style="text-align:right">Change</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.lane === 'webmcp' ? 'lane-mcp' : ''}">
        <td class="task-cell">${r.lane === 'ui-guessing' ? escapeHtml(r.task.shortTitle || r.task.title) : ''}</td>
        <td><span class="lane-tag">${LANES[r.lane].name}</span></td>
        <td class="num">${pct(r.base)}</td><td class="num">${pct(r.other)}</td>
        <td class="num ${r.delta < -0.005 ? 'down' : ''}">${r.base === 1 && r.other === 1 ? 'No change: both scored 100%' : `${r.delta > 0 ? '+' : ''}${pct(r.delta)}`}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="tier-note">${uiDrop != null && toolDrop != null && informative.length
      ? (Math.abs(toolDrop) < Math.abs(uiDrop)
          ? `On tasks where performance had room to fall, the browsing approach lost ${pct(Math.abs(uiDrop))} on average. The WebMCP approach lost ${pct(Math.abs(toolDrop))}. In plain English: the smaller model degraded about ${(Math.abs(uiDrop) / Math.abs(toolDrop)).toFixed(1)}× less when the website explained itself through tools.<br><br>That matters for civic technology. People should not need the largest and most expensive model available just to understand whether they qualify for help.`
          : `The WebMCP approach lost ${pct(Math.abs(toolDrop))} against browsing's ${pct(Math.abs(uiDrop))}. Tools did not protect the smaller model here, and we publish that as readily as we would have published the reverse.`)
      : 'Not enough comparisons with room to fall.'}</p>`;
}

/* -------------------------------------------------------------- scoreboard */

function renderScoreboard(tasks, runs) {
  const host = document.getElementById('scoreboard');
  if (!runs.length) {
    host.innerHTML = '<p class="loading">No recorded runs yet — the baselines land here once the drift-race session records them.</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'board-table';
  table.innerHTML = `
    <thead><tr>
      <th scope="col">Task</th><th scope="col">Approach</th><th scope="col">Model</th>
      <th scope="col" style="text-align:right">Average time</th>
      <th scope="col" style="text-align:right">Average actions</th>
      <th scope="col" style="text-align:right">Average score</th>
      <th scope="col" style="text-align:right">Score range</th>
    </tr></thead><tbody></tbody>`;

  const body = table.querySelector('tbody');
  for (const task of tasks) {
    // One row per lane: the promoted pass. Other passes appear as the spread
    // inside the replay, not as extra scoreboard rows.
    const all = runs.filter((r) => r.taskId === task.id);
    const tiersPresent = [...new Set(all.map((r) => r.tier).filter(Boolean))]
      .sort((x, y) => (x === indexMeta?.headlineTier ? -1 : y === indexMeta?.headlineTier ? 1 : 0));
    const cells = [];
    for (const lane of ['ui-guessing', 'webmcp']) {
      for (const tier of (tiersPresent.length ? tiersPresent : [null])) {
        const passes = all.filter((r) => r.lane === lane && (tier === null || r.tier === tier));
        if (!passes.length) continue;
        cells.push({ lane, tier, passes, promoted: passes.find((r) => r.promoted) || passes[0] });
      }
    }
    const forTask = cells;
    for (const group of forTask) {
      const { lane, passes, tier } = group;
      // Compare against the UI lane of the SAME tier — a model's tool lane is
      // only meaningfully faster or slower than its own browsing lane.
      const ui = forTask.find((g) => g.lane === 'ui-guessing' && g.tier === tier);
      const run = { lane, trace: group.promoted.trace };
      const avg = (fn) => passes.reduce((n, p) => n + (fn(p.trace) || 0), 0) / passes.length;
      const accs = passes.map((p) => p.trace.score?.accuracy).filter((a) => a != null);
      const meanAcc = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
      const t = {
        metrics: {
          wallClockMs: avg((x) => x.metrics.wallClockMs),
          actionCount: Math.round(avg((x) => x.metrics.actionCount)),
          toolCalls: Math.round(avg((x) => x.metrics.toolCalls || 0))
        },
        score: { accuracy: meanAcc, verdict: group.promoted.trace.score?.verdict }
      };
      const row = document.createElement('tr');
      row.className = run.lane === 'webmcp' ? 'lane-mcp' : 'lane-ui';
      const uiMs = ui ? ui.passes.reduce((n, p) => n + p.trace.metrics.wallClockMs, 0) / ui.passes.length : null;
      const uiActions = ui ? ui.passes.reduce((n, p) => n + p.trace.metrics.actionCount, 0) / ui.passes.length : null;
      const ratio = uiMs && t.metrics.wallClockMs ? uiMs / t.metrics.wallClockMs : null;
      const faster = run.lane === 'webmcp' && ratio
        ? `<span class="delta"> ${ratio >= 1 ? `${ratio.toFixed(1)}× faster` : `${(1 / ratio).toFixed(1)}× slower`}</span>` : '';
      const fewer = run.lane === 'webmcp' && uiActions != null
        ? `<span class="delta"> ${t.metrics.actionCount - uiActions >= 0 ? '+' : '−'}${Math.abs(Math.round(t.metrics.actionCount - uiActions))}</span>` : '';
      const modelName = (indexMeta?.tiers || []).find((x) => x.tier === tier)?.label || tier || '—';
      const range = accs.length > 1 && Math.min(...accs) !== Math.max(...accs)
        ? `${pct(Math.min(...accs))} – ${pct(Math.max(...accs))}` : 'no variation';
      row.innerHTML = `
        <td class="task-cell">${forTask.indexOf(group) === 0 ? escapeHtml(task.shortTitle || task.title) : ''}</td>
        <td><span class="lane-tag">${LANES[run.lane].name}</span> <span class="n">${passes.length} attempts</span></td>
        <td class="model">${escapeHtml(modelName)}</td>
        <td class="num">${fmtSeconds(t.metrics.wallClockMs)}${faster}</td>
        <td class="num">${t.metrics.actionCount}${fewer}</td>
        <td class="num">${pct(t.score?.accuracy)}</td>
        <td class="num range">${range}</td>`;
      body.appendChild(row);
    }
  }

  host.replaceChildren(table);
}

/* ------------------------------------------------------------ replay lanes */

function buildLane(run, passes = [run]) {
  const node = document.getElementById('lane-template').content.firstElementChild.cloneNode(true);
  const meta = LANES[run.lane];
  node.classList.add(meta.cls);
  node.querySelector('.lane-name').textContent = meta.name;
  node.querySelector('.lane-sub').textContent = meta.sub;

  const list = node.querySelector('.steps');
  for (const step of run.trace.steps) {
    const li = document.createElement('li');
    li.className = [step.type === 'tool_call' ? 'tool' : '', step.outcome === 'dead-end' ? 'dead-end' : ''].filter(Boolean).join(' ');
    if (REDUCED_MOTION) li.classList.add('shown');
    li.innerHTML = `
      <span class="t">${fmtClock(step.tMs)}</span>
      <span class="what">
        <span class="lbl"><span class="kind">${KIND_LABEL[step.type] || step.type}</span>${escapeHtml(step.label)}</span>
        ${step.detail ? `<span class="det">${escapeHtml(step.detail)}</span>` : ''}
        ${step.toolCall?.resultSummary ? `<span class="det">→ ${escapeHtml(step.toolCall.resultSummary)}</span>` : ''}
      </span>`;
    list.appendChild(li);
  }

  return {
    node,
    steps: [...list.children],
    trace: run.trace,
    passes,
    total: run.trace.metrics.wallClockMs,
    els: {
      time: node.querySelector('.m-time'),
      actions: node.querySelector('.m-actions'),
      accuracy: node.querySelector('.m-accuracy'),
      fill: node.querySelector('.bar-fill'),
      verdict: node.querySelector('.verdict')
    }
  };
}

function renderVerdict(lane) {
  const { trace, els } = lane;
  const score = trace.score || {};
  const spread = (lane.passes || []).map((p) => p.trace?.score?.accuracy).filter((a) => a != null);
  const checks = (score.checks || [])
    .map((c) => `<li><span class="${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '✗'}</span>
      <span>${escapeHtml(c.label || c.id)}${c.actual ? ` — <em>${escapeHtml(c.actual)}</em>` : ''}
      ${c.note ? `<span class="note">${escapeHtml(c.note)}</span>` : ''}</span></li>`)
    .join('');
  const spreadHtml = spread.length > 1
    ? `<p class="spread"><strong>${spread.length} recorded attempts</strong>
         ${spread.map((a) => `<span class="${a === Math.max(...spread) ? 'best' : 'worst'}">${pct(a)}</span>`).join(' · ')}
         ${new Set(spread).size > 1
           ? '<span class="note">The same task produced different levels of completeness across the five attempts.</span>'
           : '<span class="note">All five attempts received the same score.</span>'}</p>`
    : '';

  const norms = score.normalisations?.length
    ? `<details class="norms"><summary>Scoring details (${score.normalisations.length} scoring adjustments, all favouring this approach)</summary>
         <ul class="plain">${score.normalisations.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></details>`
    : '';

  els.verdict.innerHTML = `
    <p class="answer"><strong>What the agent told Mira</strong>${escapeHtml(trace.result?.answer || '—')}</p>
    ${trace.result?.submitted === true ? '<p class="answer"><strong>Form</strong><span class="fail">Submitted without a human review.</span></p>' : ''}
    ${spreadHtml}
    <ul>${checks}</ul>
    ${norms}`;
  els.verdict.hidden = false;
}

function resetLane(lane) {
  lane.node.classList.remove('done');
  lane.steps.forEach((li) => { if (!REDUCED_MOTION) li.classList.remove('shown'); });
  lane.els.time.textContent = '0.0s';
  lane.els.actions.textContent = '0';
  lane.els.accuracy.textContent = '—';
  lane.els.fill.style.width = '0';
  lane.els.verdict.hidden = true;
}

function finishLane(lane) {
  lane.node.classList.add('done');
  lane.steps.forEach((li) => li.classList.add('shown'));
  lane.els.time.textContent = fmtSeconds(lane.total);
  lane.els.actions.textContent = String(lane.trace.metrics.actionCount);
  lane.els.accuracy.textContent = pct(lane.trace.score?.accuracy);
  renderVerdict(lane);
}

/** Drive every lane of one task off a single virtual clock. */
function createReplay(lanes, controls) {
  const span = Math.max(...lanes.map((l) => l.total)) || 1;
  let raf = null;

  function stop() { if (raf) cancelAnimationFrame(raf); raf = null; }

  function reset() {
    stop();
    lanes.forEach(resetLane);
    controls.play.disabled = false;
    controls.play.textContent = 'Play both recordings';
  }

  function play() {
    stop();
    lanes.forEach(resetLane);
    const speed = Number(controls.speed.value) || 8;

    if (speed >= 1000 || REDUCED_MOTION) {
      lanes.forEach(finishLane);
      controls.play.textContent = 'Watch again';
      return;
    }

    controls.play.disabled = true;
    controls.play.textContent = 'Playing…';
    const started = performance.now();

    const tick = (now) => {
      const virtual = (now - started) * speed;
      for (const lane of lanes) {
        const clock = Math.min(virtual, lane.total);
        let shown = 0;
        lane.steps.forEach((li, i) => {
          if (lane.trace.steps[i].tMs <= clock) { li.classList.add('shown'); shown++; }
        });
        lane.els.time.textContent = fmtSeconds(clock);
        lane.els.actions.textContent = String(shown);
        lane.els.fill.style.width = `${Math.min(100, (clock / span) * 100)}%`;
        if (virtual >= lane.total && lane.els.verdict.hidden) finishLane(lane);
      }
      if (virtual < span) raf = requestAnimationFrame(tick);
      else {
        stop();
        lanes.forEach(finishLane);
        controls.play.disabled = false;
        controls.play.textContent = 'Watch again';
      }
    };
    raf = requestAnimationFrame(tick);
  }

  return { play, reset };
}

/* ----------------------------------------------------------------- task UI */

function renderKey(task, host) {
  const e = task.expected || {};
  const list = (ids) => `<ul class="plain">${ids.map((i) => `<li>${escapeHtml(human(i))}</li>`).join('')}</ul>`;
  const rows = Object.entries(e.values || {})
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('');

  const technical = [
    e.outcome ? `<p><strong>Outcome id:</strong> <code>${escapeHtml(e.outcome)}</code></p>` : '',
    e.grants?.length ? `<p><strong>Grant ids:</strong> ${e.grants.map((g) => `<code>${escapeHtml(g)}</code>`).join(' ')}</p>` : '',
    e.requiredDocuments?.length ? `<p><strong>Document ids:</strong> ${e.requiredDocuments.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ')}</p>` : '',
    e.rulesetId ? `<p><strong>Ruleset:</strong> <code>${escapeHtml(e.rulesetId)}</code></p>` : '',
    e.formId ? `<p><strong>Form:</strong> <code>${escapeHtml(e.formId)}</code></p>` : ''
  ].filter(Boolean).join('');

  host.innerHTML = `
    <p class="key-intro">
      This is the checklist used to score both approaches. It comes from the fictional
      policies, requirements and form values published by the Office.
    </p>
    ${e.summary ? `<p>${escapeHtml(e.summary)}</p>` : ''}
    ${e.grants?.length ? `<h5>Support Mira also qualifies for</h5>${list(e.grants)}` : ''}
    ${e.requiredDocuments?.length ? `<h5>Documents to bring</h5>${list(e.requiredDocuments)}` : ''}
    ${rows ? `<h5>Correct form values</h5><table><tbody>${rows}</tbody></table>` : ''}
    ${e.derivedField ? `<h5>The part that has to be worked out</h5><p><code>${escapeHtml(e.derivedField.name)} = ${escapeHtml(String(e.derivedField.value))}</code> — ${escapeHtml(e.derivedField.why)}</p>` : ''}
    ${e.sourcePath ? `<h5>Source</h5><p><a href="${escapeHtml(e.sourcePath)}${escapeHtml(e.sourceAnchor || '')}">${escapeHtml(e.sourcePath)}${escapeHtml(e.sourceAnchor || '')}</a></p>` : ''}
    ${task.toolPath?.length ? `<h5>WebMCP tools available for this task</h5>
      <p>${task.toolPath.map((t) => `<code>${escapeHtml(t)}</code>`).join(' · ')}</p>
      <p class="key-aside">Different agents may choose different tools, or call them in a different order.</p>` : ''}
    ${e.mustNotDo ? `<h5>Must not</h5><p>${escapeHtml(e.mustNotDo)}</p>` : ''}
    ${technical ? `<details class="technical"><summary>Technical details</summary>${technical}</details>` : ''}`;
}

function renderTask(task, runs) {
  const node = document.getElementById('task-template').content.firstElementChild.cloneNode(true);
  node.id = task.id;
  node.querySelector('.task-order').textContent = `Task ${task.order} of 3`;
  node.querySelector('.task-title').textContent = task.title;
  node.querySelector('.task-difficulty').textContent = task.difficulty || '';
  node.querySelector('.scenario').textContent = task.persona?.scenario || '';
  node.querySelector('.task-prompt').textContent = task.prompt;
  renderKey(task, node.querySelector('.key-body'));

  if (task.consentNote) {
    node.querySelector('.ask').insertAdjacentHTML('afterend',
      `<p class="consent">${escapeHtml(task.consentNote)}</p>`);
  }

  const copyText = `${task.persona?.scenario || ''}\n\n${task.prompt}`;
  const copyBtn = node.querySelector('.copy');
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(copyText); }
    catch {
      const area = document.createElement('textarea');
      area.value = copyText;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    copyBtn.textContent = 'Copied. Send it to your agent.';
    copyBtn.classList.add('copied');
    setTimeout(() => { copyBtn.textContent = 'Copy scenario and question'; copyBtn.classList.remove('copied'); }, 2600);
  });

  // If the lanes scored differently, the reason renders with the numbers.
  // Within one tier only. A lane figure that averages two models describes
  // neither, and would make a divergence appear or vanish for the wrong reason.
  const forThisTask = runs.filter((r) => r.taskId === task.id);
  const tierSet = [...new Set(forThisTask.map((r) => r.tier).filter(Boolean))];
  const primaryTier = indexMeta?.headlineTier && tierSet.includes(indexMeta.headlineTier)
    ? indexMeta.headlineTier
    : (tierSet.length ? tierSet[0] : null);
  const laneAcc = {};
  for (const lane of ['ui-guessing', 'webmcp']) {
    const accs = forThisTask
      .filter((r) => r.lane === lane && (primaryTier === null ? !r.tier : r.tier === primaryTier))
      .map((r) => r.trace.score?.accuracy).filter((a) => a != null);
    if (accs.length) laneAcc[lane] = accs.reduce((a, b) => a + b, 0) / accs.length;
  }
  const diverges = laneAcc['ui-guessing'] != null && laneAcc.webmcp != null
    && laneAcc['ui-guessing'] !== laneAcc.webmcp;

  if (diverges) {
    const d = task.laneDivergence;
    const host = node.querySelector('.divergence');
    host.hidden = false;
    host.innerHTML = d
      ? `<h4>${escapeHtml(d.headline)}</h4>
         <p>${escapeHtml(d.body)}</p>
         ${d.whyItMatters ? `<p class="why">${escapeHtml(d.whyItMatters)}</p>` : ''}
         ${d.remedy ? `<p class="remedy"><strong>What we would change</strong> ${escapeHtml(d.remedy)}</p>` : ''}`
      : `<h4>The lanes scored differently on this task.</h4>
         <p class="missing">No explanation has been written for this divergence yet. A score gap on its own
         does not say which lane was wrong, or whether either was — see the two runs below and judge for yourself.</p>`;
  }

  renderRounds(task, runs.filter((r) => r.taskId === task.id), node.querySelector('.rounds'), indexMeta || {});

  const lanesHost = node.querySelector('.lanes');
  const order = ['ui-guessing', 'webmcp'];
  const forTask = runs.filter((r) => r.taskId === task.id);

  // Several passes of the same lane may be recorded. One is promoted and gets
  // replayed; the others become the run-to-run spread, which is evidence in its
  // own right — an agent that scores 1.00 three times and 0.64 once is not the
  // same thing as an agent that scores 0.91.
  const lanes = order
    .filter((laneName) => forTask.some((r) => r.lane === laneName))
    .map((laneName) => {
      const passes = forTask.filter((r) => r.lane === laneName);
      const run = passes.find((r) => r.promoted) || passes[0];
      const lane = buildLane(run, passes);
      lanesHost.appendChild(lane.node);
      return lane;
    });

  const controls = {
    play: node.querySelector('.play'),
    reset: node.querySelector('.reset'),
    speed: node.querySelector('.speed-select')
  };

  const withheld = (indexMeta?.withheld || []).filter((w) => w.taskId === task.id);
  if (withheld.length) {
    lanesHost.insertAdjacentHTML('beforebegin', withheld.map((w) =>
      `<p class="withheld"><strong>${escapeHtml(LANES[w.lane]?.name || w.lane)}: ${w.passes} recorded pass${w.passes === 1 ? '' : 'es'} withheld.</strong>
       ${escapeHtml(w.reason)}</p>`).join(''));
  }

  if (!lanes.length) {
    node.querySelector('.replay').innerHTML =
      '<p class="loading">No recordings for this task yet.</p>';
  } else {
    const replay = createReplay(lanes, controls);
    controls.play.addEventListener('click', replay.play);
    controls.reset.addEventListener('click', replay.reset);
    lanes.forEach(resetLane);
  }

  return node;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* -------------------------------------------------------------------- boot */

(async function boot() {
  renderStatus();
  try {
    const [keys, { index, runs }] = await Promise.all([getJSON('answer-keys.json'), loadRuns()]);
    const tasks = [...keys.tasks].sort((a, b) => (a.order || 0) - (b.order || 0));

    indexMeta = index;
    // The headline round is per LANE, not global. Only the tool lane is
    // re-recorded after a tool fix — the UI lane is unaffected by it and stays
    // at the round it was measured in. Filtering globally would silently drop
    // the lane the whole comparison rests on.
    const latestRound = new Map();
    for (const r of runs) {
      const key = `${r.taskId}/${r.lane}/${r.tier || '-'}`;
      const round = r.round || 1;
      const cap = index.headlineRound || Infinity;
      if (round <= cap) latestRound.set(key, Math.max(latestRound.get(key) || 0, round));
    }
    const headlineRuns = runs.filter(
      (r) => (r.round || 1) === latestRound.get(`${r.taskId}/${r.lane}/${r.tier || '-'}`)
    );
    renderFindings(tasks, headlineRuns, index);
    renderScoreboard(tasks, headlineRuns);
    renderTiers(tasks, headlineRuns, index);

    const list = document.getElementById('task-list');
    list.replaceChildren(...tasks.map((task) => renderTask(task, runs)));

    const countEl = document.getElementById('trace-count');
    if (countEl) countEl.textContent = runs.length ? String(runs.length) : 'recorded';
    const provenance = document.getElementById('trace-provenance');
    if (!runs.length) {
      provenance.textContent = 'No attempts recorded yet — the three tasks above are live and you can run them yourself.';
    } else if (runs.some((r) => r.trace.agent?.name === 'MOCK')) {
      provenance.textContent = 'baseline traces: PLACEHOLDER — not recorded, not to be published';
    } else {
      const when = (runs[0]?.trace.recordedAt || '').slice(0, 10);
      const commit = index.recordedAgainst?.commit || runs[0]?.trace.site?.commit;
      const against = commit && commit !== 'live' ? `site ${commit}` : 'the live production site';
      const key = index.recordedAgainst?.answerKeySha;
      const round = (index.rounds || []).find((r) => r.round === index.headlineRound);
      provenance.textContent =
        `Recorded ${when || 'against the published site'} on ${against}` +
        (key ? `, scored against checklist ${key.slice(0, 7)}` : '') + '.';
    }
  } catch (error) {
    console.error('[arena]', error);
    document.getElementById('task-list').innerHTML =
      `<p class="loading">Could not load the Arena data: ${escapeHtml(error.message)}</p>`;
  }
})();
