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
    name: 'UI-guessing agent',
    sub: 'No tools. Reads pages, clicks links, scrolls.',
    cls: 'ui'
  },
  webmcp: {
    name: 'WebMCP agent',
    sub: 'Calls the tools this site publishes about itself.',
    cls: 'mcp'
  }
};

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
        `WebMCP live — <strong>${api.registered.length} tools</strong> registered on this page via ` +
        `<code>${api.surface}.modelContext</code>. `;
      const test = document.createElement('button');
      test.className = 'self-test';
      test.type = 'button';
      test.textContent = 'Run a self-test';
      test.addEventListener('click', async () => {
        test.disabled = true;
        test.textContent = 'Calling search_site…';
        try {
          const out = await api.call('search_site', { query: 'fee waiver repeat damage claims' });
          const top = out.structuredContent?.results?.[0];
          test.textContent = top
            ? `search_site → ${top.path} (${out.structuredContent.count} results)`
            : 'search_site returned no results';
        } catch (error) {
          test.textContent = `self-test failed: ${error.message}`;
        }
      });
      text.appendChild(test);
    } else {
      box.className = 'status absent';
      text.textContent =
        api?.reason ||
        'This browser does not expose a WebMCP model context. The recordings below still play; open the site in Chrome 150+ or the ChatGPT in-app browser to run the fast lane yourself.';
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

/* ---------------------------------------------------------------- findings */

/**
 * What the recordings actually show, derived from the recordings.
 * Nothing here is a hand-typed number, so nothing here can go stale.
 */
function renderFindings(tasks, runs) {
  const host = document.getElementById('findings');
  if (!host) return;
  let ui = runs.filter((r) => r.lane === 'ui-guessing');
  if (!ui.length) { host.hidden = true; return; }

  // If more than one agent tier was recorded, the figures describe the promoted
  // tier alone. Averaging a strong model with a weak one would describe neither.
  const promotedTier = ui.find((r) => r.promoted)?.tier
    || ui.find((r) => r.promoted)?.trace.agent?.model;
  if (promotedTier) {
    const sameTier = ui.filter((r) => (r.tier || r.trace.agent?.model) === promotedTier);
    if (sameTier.length) ui = sameTier;
  }

  const acc = ui.map((r) => r.trace.score?.accuracy).filter((a) => a != null);
  const loads = ui.map((r) => r.trace.metrics.pageLoads || 0);
  const dead = ui.map((r) => r.trace.metrics.deadEnds || 0);
  const bytes = ui.map((r) => r.trace.metrics.bytesTransferred || 0).filter(Boolean);
  const tool = runs.filter((r) => r.lane === 'webmcp');
  const toolCalls = tool.map((r) => r.trace.metrics.toolCalls || 0).filter(Boolean);
  const toolBytes = tool.map((r) => r.trace.metrics.bytesTransferred || 0).filter(Boolean);

  const perfect = acc.filter((a) => a === 1).length;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const range = (xs) => (Math.min(...xs) === Math.max(...xs) ? `${Math.min(...xs)}` : `${Math.min(...xs)}–${Math.max(...xs)}`);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

  const cards = [
    {
      figure: `${perfect} of ${acc.length}`,
      label: 'recorded UI-lane passes scored full marks',
      body: `The agent without tools is good at this site. We are publishing that rather than hiding it — the case for WebMCP does not rest on the alternative failing.`
    },
    {
      figure: range(loads),
      label: `page load${loads.length && Math.max(...loads) === 1 ? '' : 's'} per task, UI lane`,
      body: toolCalls.length
        ? `Against ${range(toolCalls)} tool call${Math.max(...toolCalls) === 1 ? '' : 's'} for the same answers. Both arrive; one costs a fraction of the other.`
        : 'Each one a full HTML page, parsed to find a sentence.'
    },
    {
      figure: `${sum(dead)}`,
      label: `dead end${sum(dead) === 1 ? '' : 's'} across every recorded pass`,
      body: `Steps that led nowhere and had to be backed out of. They cost time on the way to answers that were still, in the end, correct.`
    }
  ];

  // Cost. Tokens where both lanes recorded them, bytes otherwise — and stated in
  // whichever direction the data actually runs. The tool lane pays to fetch the
  // manifest once, so this comparison is not guaranteed to favour it, and the
  // card must read correctly if it does not.
  const tokensOf = (rs) => rs.flatMap((r) => (r.trace.steps || []).map((st) => (st.cost?.tokensIn || 0) + (st.cost?.tokensOut || 0)));
  const uiTokens = sum(tokensOf(ui));
  const toolTokens = sum(tokensOf(tool));

  const cost = uiTokens && toolTokens
    ? { unit: 'context tokens', a: uiTokens / ui.length, b: toolTokens / tool.length, fmt: (n) => `${Math.round(n).toLocaleString()}` }
    : (bytes.length && toolBytes.length
        ? { unit: 'bytes fetched', a: sum(bytes) / bytes.length, b: sum(toolBytes) / toolBytes.length, fmt: kb }
        : null);

  if (cost && cost.a > 0 && cost.b > 0) {
    const uiHeavier = cost.a >= cost.b;
    const ratio = uiHeavier ? cost.a / cost.b : cost.b / cost.a;
    cards.push({
      figure: `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}×`,
      label: `more ${cost.unit}, ${uiHeavier ? 'UI lane' : 'tool lane'} per task`,
      body: uiHeavier
        ? `${cost.fmt(cost.a)} against ${cost.fmt(cost.b)}. The pages have to be read; the tools are asked.`
        : `${cost.fmt(cost.b)} against ${cost.fmt(cost.a)}. The tool lane fetches the whole manifest once, and on a site this small that costs more than reading the few pages an answer needs. We publish it in the direction the data runs.`
    });
  }

  // Both lanes' accuracy, so the panel cannot imply the tools were flawless.
  const toolAcc = tool.map((r) => r.trace.score?.accuracy).filter((a) => a != null);
  if (toolAcc.length) {
    const toolPerfect = toolAcc.filter((a) => a === 1).length;
    if (toolPerfect < toolAcc.length) {
      cards.push({
        figure: `${toolPerfect} of ${toolAcc.length}`,
        label: 'tool-lane passes scored full marks',
        body: `The tools are not a correctness guarantee either. Where a tool answered wrongly, the run is on this page with the rest.`
      });
    }
  }

  const model = ui[0]?.trace.agent?.model;
  const foot = host.querySelector('.findings-foot');
  if (model && foot && !foot.dataset.stamped) {
    foot.dataset.stamped = '1';
    foot.insertAdjacentHTML('beforeend',
      ` <span class="provenance">Figures computed from ${ui.length} recorded pass${ui.length === 1 ? '' : 'es'} of ${escapeHtml(model)}.</span>`);
  }

  host.hidden = false;
  host.querySelector('.findings-grid').innerHTML = cards
    .map((c) => `<div class="finding">
        <p class="figure">${escapeHtml(c.figure)}</p>
        <p class="figure-label">${escapeHtml(c.label)}</p>
        <p class="figure-body">${escapeHtml(c.body)}</p>
      </div>`)
    .join('');
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
      <th scope="col">Task</th><th scope="col">Lane</th>
      <th scope="col" style="text-align:right">Time</th>
      <th scope="col" style="text-align:right">Actions</th>
      <th scope="col" style="text-align:right">Tool calls</th>
      <th scope="col" style="text-align:right">Accuracy</th>
      <th scope="col">Verdict</th>
    </tr></thead><tbody></tbody>`;

  const body = table.querySelector('tbody');
  for (const task of tasks) {
    // One row per lane: the promoted pass. Other passes appear as the spread
    // inside the replay, not as extra scoreboard rows.
    const all = runs.filter((r) => r.taskId === task.id);
    const forTask = ['ui-guessing', 'webmcp']
      .map((lane) => {
        const passes = all.filter((r) => r.lane === lane);
        if (!passes.length) return null;
        return { lane, passes, promoted: passes.find((r) => r.promoted) || passes[0] };
      })
      .filter(Boolean);
    const ui = forTask.find((r) => r.lane === 'ui-guessing');
    for (const group of forTask) {
      const { lane, passes } = group;
      const run = { lane, trace: group.promoted.trace };
      const avg = (fn) => passes.reduce((n, p) => n + (fn(p.trace) || 0), 0) / passes.length;
      const accs = passes.map((p) => p.trace.score?.accuracy).filter((a) => a != null);
      const meanAcc = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
      const spread = accs.length > 1 && Math.min(...accs) !== Math.max(...accs)
        ? `<span class="delta"> ${pct(Math.min(...accs))}–${pct(Math.max(...accs))}</span>` : '';
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
      row.innerHTML = `
        <td class="task-cell">${run.lane === 'ui-guessing' ? escapeHtml(task.title) : ''}</td>
        <td><span class="lane-tag">${LANES[run.lane].name}</span> <span class="n">n=${passes.length}</span></td>
        <td class="num">${fmtSeconds(t.metrics.wallClockMs)}${faster}</td>
        <td class="num">${t.metrics.actionCount}${fewer}</td>
        <td class="num">${t.metrics.toolCalls ?? 0}</td>
        <td class="num">${pct(t.score?.accuracy)}${spread}</td>
        <td><span class="badge ${t.score?.verdict || 'partial'}">${t.score?.verdict || '—'}</span></td>`;
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
    ? `<p class="spread"><strong>${spread.length} recorded passes</strong>
         ${spread.map((a) => `<span class="${a === Math.max(...spread) ? 'best' : 'worst'}">${pct(a)}</span>`).join(' · ')}
         ${new Set(spread).size > 1
           ? '<span class="note">Same task, same prompt, same site. The prose the agent returned reads the same in every pass.</span>'
           : '<span class="note">Reproduced identically.</span>'}</p>`
    : '';

  const norms = score.normalisations?.length
    ? `<details class="norms"><summary>How this was scored (${score.normalisations.length} normalisations, all favouring this lane)</summary>
         <ul class="plain">${score.normalisations.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></details>`
    : '';

  els.verdict.innerHTML = `
    <p class="answer"><strong>Final answer</strong>${escapeHtml(trace.result?.answer || '—')}</p>
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
    controls.play.textContent = 'Play both lanes';
  }

  function play() {
    stop();
    lanes.forEach(resetLane);
    const speed = Number(controls.speed.value) || 8;

    if (speed >= 1000 || REDUCED_MOTION) {
      lanes.forEach(finishLane);
      controls.play.textContent = 'Replay';
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
        controls.play.textContent = 'Replay';
      }
    };
    raf = requestAnimationFrame(tick);
  }

  return { play, reset };
}

/* ----------------------------------------------------------------- task UI */

function renderKey(task, host) {
  const e = task.expected || {};
  const rows = Object.entries(e.values || {})
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('');
  host.innerHTML = `
    ${e.summary ? `<p>${escapeHtml(e.summary)}</p>` : ''}
    ${e.outcome ? `<p><strong>Outcome:</strong> <code>${escapeHtml(e.outcome)}</code></p>` : ''}
    ${e.grants?.length ? `<h5>Also qualifies for</h5><ul>${e.grants.map((g) => `<li><code>${escapeHtml(g)}</code></li>`).join('')}</ul>` : ''}
    ${e.requiredDocuments?.length ? `<h5>Documents</h5><ul>${e.requiredDocuments.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join('')}</ul>` : ''}
    ${rows ? `<h5>Correct form values</h5><table><tbody>${rows}</tbody></table>` : ''}
    ${e.derivedField ? `<h5>The part that has to be worked out</h5><p><code>${escapeHtml(e.derivedField.name)} = ${escapeHtml(String(e.derivedField.value))}</code> — ${escapeHtml(e.derivedField.why)}</p>` : ''}
    ${e.sourcePath ? `<h5>Source</h5><p><a href="${escapeHtml(e.sourcePath)}${escapeHtml(e.sourceAnchor || '')}">${escapeHtml(e.sourcePath)}${escapeHtml(e.sourceAnchor || '')}</a></p>` : ''}
    ${task.toolPath?.length ? `<h5>Tool path a WebMCP agent takes</h5><p>${task.toolPath.map((t) => `<code>${escapeHtml(t)}</code>`).join(' → ')}</p>` : ''}
    ${e.mustNotDo ? `<h5>Must not</h5><p>${escapeHtml(e.mustNotDo)}</p>` : ''}`;
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
    copyBtn.textContent = 'Copied — paste it to your agent';
    copyBtn.classList.add('copied');
    setTimeout(() => { copyBtn.textContent = 'Copy this scenario'; copyBtn.classList.remove('copied'); }, 2600);
  });

  // If the lanes scored differently, the reason renders with the numbers.
  const laneAcc = {};
  for (const lane of ['ui-guessing', 'webmcp']) {
    const accs = runs.filter((r) => r.taskId === task.id && r.lane === lane)
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

  if (!lanes.length) {
    node.querySelector('.replay').innerHTML =
      '<p class="loading">No recording for this task yet.</p>';
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

    renderFindings(tasks, runs);
    renderScoreboard(tasks, runs);

    const list = document.getElementById('task-list');
    list.replaceChildren(...tasks.map((task) => renderTask(task, runs)));

    const provenance = document.getElementById('trace-provenance');
    if (!runs.length) {
      provenance.textContent = 'no baseline runs recorded yet — the three tasks above are live and you can run them yourself';
    } else if (runs.some((r) => r.trace.agent?.name === 'MOCK')) {
      provenance.textContent = 'baseline traces: PLACEHOLDER — not recorded, not to be published';
    } else {
      const when = (runs[0]?.trace.recordedAt || '').slice(0, 10);
      const commit = index.recordedAgainst?.commit || runs[0]?.trace.site?.commit;
      const against = commit && commit !== 'live' ? `site ${commit}` : 'the live production site';
      const key = index.recordedAgainst?.answerKeySha;
      const round = (index.rounds || []).find((r) => r.round === index.headlineRound);
      provenance.textContent =
        `${runs.length} recorded runs${when ? `, ${when}` : ''}, against ${against}` +
        (key ? `, scored against answer key ${key.slice(0, 7)}` : '') +
        (round?.label ? ` · round ${round.round}: ${round.label.toLowerCase()}` : '');
    }
  } catch (error) {
    console.error('[arena]', error);
    document.getElementById('task-list').innerHTML =
      `<p class="loading">Could not load the Arena data: ${escapeHtml(error.message)}</p>`;
  }
})();
