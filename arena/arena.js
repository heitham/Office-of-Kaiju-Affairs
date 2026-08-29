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
    const forTask = runs.filter((r) => r.taskId === task.id);
    const ui = forTask.find((r) => r.lane === 'ui-guessing')?.trace;
    for (const run of forTask) {
      const t = run.trace;
      const row = document.createElement('tr');
      row.className = run.lane === 'webmcp' ? 'lane-mcp' : 'lane-ui';
      const faster = run.lane === 'webmcp' && ui
        ? `<span class="delta"> ${(ui.metrics.wallClockMs / t.metrics.wallClockMs).toFixed(1)}× faster</span>` : '';
      const fewer = run.lane === 'webmcp' && ui
        ? `<span class="delta"> −${ui.metrics.actionCount - t.metrics.actionCount}</span>` : '';
      row.innerHTML = `
        <td class="task-cell">${run.lane === 'ui-guessing' ? escapeHtml(task.title) : ''}</td>
        <td><span class="lane-tag">${LANES[run.lane].name}</span></td>
        <td class="num">${fmtSeconds(t.metrics.wallClockMs)}${faster}</td>
        <td class="num">${t.metrics.actionCount}${fewer}</td>
        <td class="num">${t.metrics.toolCalls ?? 0}</td>
        <td class="num">${pct(t.score?.accuracy)}</td>
        <td><span class="badge ${t.score?.verdict || 'partial'}">${t.score?.verdict || '—'}</span></td>`;
      body.appendChild(row);
    }
  }

  host.replaceChildren(table);
}

/* ------------------------------------------------------------ replay lanes */

function buildLane(run) {
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
  const checks = (score.checks || [])
    .map((c) => `<li><span class="${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '✗'}</span>
      <span>${escapeHtml(c.label || c.id)}${c.actual ? ` — <em>${escapeHtml(c.actual)}</em>` : ''}
      ${c.note ? `<span class="note">${escapeHtml(c.note)}</span>` : ''}</span></li>`)
    .join('');
  els.verdict.innerHTML = `
    <p class="answer"><strong>Final answer</strong>${escapeHtml(trace.result?.answer || '—')}</p>
    ${trace.result?.submitted === true ? '<p class="answer"><strong>Form</strong><span class="fail">Submitted without a human review.</span></p>' : ''}
    <ul>${checks}</ul>`;
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

  const lanesHost = node.querySelector('.lanes');
  const order = ['ui-guessing', 'webmcp'];
  const lanes = runs
    .filter((r) => r.taskId === task.id)
    .sort((a, b) => order.indexOf(a.lane) - order.indexOf(b.lane))
    .map((run) => {
      const lane = buildLane(run);
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

    renderScoreboard(tasks, runs);

    const list = document.getElementById('task-list');
    list.replaceChildren(...tasks.map((task) => renderTask(task, runs)));

    const mock = runs.some((r) => r.trace.agent?.name === 'MOCK');
    document.getElementById('trace-provenance').textContent = mock
      ? 'baseline traces: PLACEHOLDER — not yet recorded'
      : `baseline traces recorded ${(runs[0]?.trace.recordedAt || '').slice(0, 10)} against ${index.recordedAgainst?.commit || 'the published site'}`;
  } catch (error) {
    console.error('[arena]', error);
    document.getElementById('task-list').innerHTML =
      `<p class="loading">Could not load the Arena data: ${escapeHtml(error.message)}</p>`;
  }
})();
