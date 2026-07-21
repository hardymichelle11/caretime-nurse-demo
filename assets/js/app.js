/**
 * CareTime Nurse — prototype UI controller.
 *
 * Renders entirely from data/scoring-rules.json. No clinical constant, option
 * label or cap is written in this file; changing the rules file changes the UI.
 *
 * Prototype scope: fictional clients, localStorage persistence, no backend.
 */
import { calculateAssessment, DAY_KEYS, formatDuration, roundTo } from './scoring-engine.js';

const STORAGE_KEY = 'caretime-nurse:prototype:v1';
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** @type {{rules: object, clients: object[], profiles: object, nurse: object, state: object}} */
const app = { rules: null, clients: [], profiles: null, nurse: null, state: null };

/**
 * The signing nurse's display label, e.g. "Michelle Hardy, RN".
 * Read from data/nurse-profiles.json so no identity is hard-coded in the UI.
 * @returns {string}
 */
function nurseLabel(nurse = app.nurse) {
  if (!nurse) return 'Unidentified nurse';
  return nurse.credential ? `${nurse.displayName}, ${nurse.credential}` : nurse.displayName;
}

/** The manager responsible for a given nurse. @returns {object|null} */
function managerFor(nurse) {
  if (!nurse || !app.profiles) return null;
  return app.profiles.managers.find((m) => m.id === nurse.managerId) || null;
}

/** Clients assigned to a given nurse. @returns {object[]} */
function caseloadFor(nurseId) {
  return app.clients.filter((c) => c.nurseId === nurseId);
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function blankState() {
  return { clientId: null, sources: [], taskResponses: {}, adjustments: {}, overallRationale: '', attested: false };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...blankState(), ...JSON.parse(raw) } : blankState();
  } catch {
    return blankState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(app.state));
    setSaveState('Saved');
  } catch {
    setSaveState('Save failed', true);
  }
}

function setSaveState(text, isError = false) {
  const el = $('#save-state');
  if (!el) return;
  el.textContent = isError ? text : `● ${text}`;
  el.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

const currentClient = () => app.clients.find((c) => c.id === app.state.clientId) || null;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const SCREEN_TITLES = {
  dashboard: 'Nurse dashboard',
  patients: 'Client directory',
  assessment: 'Functional assessment',
  results: 'Assessment results',
};

function showScreen(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === name));
  $$('.nav-item').forEach((b) => {
    const active = b.dataset.screen === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#screen-title').textContent = SCREEN_TITLES[name] || '';
  const section = document.getElementById(name);
  if (section) section.focus();
  if (name === 'assessment') renderAssessment();
  if (name === 'results') renderResults();
}

/** Paint the signed-in nurse into the top bar. */
function renderIdentity() {
  const mgr = managerFor(app.nurse);
  $('#nurse-name').textContent = nurseLabel();
  $('#nurse-role').textContent = mgr ? `${app.nurse.role} · reports to ${mgr.displayName}` : app.nurse.role;
  $('#nurse-initials').textContent = app.nurse.initials || '';
}

/** Prototype-only control for viewing the product as each nurse. */
function renderNurseSwitcher() {
  $('#nurse-switcher').innerHTML = app.profiles.profiles
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === app.nurse.id ? 'selected' : ''}>` +
        `${esc(nurseLabel(p))} — ${caseloadFor(p.id).length} clients</option>`
    )
    .join('');
}

function switchNurse(nurseId) {
  const next = app.profiles.profiles.find((p) => p.id === nurseId);
  if (!next) return;
  app.nurse = next;
  app.state = blankState();
  saveState();
  renderIdentity();
  renderDashboard();
  renderClients($('#client-search').value || '');
  showScreen('dashboard');
}

// ---------------------------------------------------------------------------
// Dashboard & clients
// ---------------------------------------------------------------------------

function renderDashboard() {
  const mine = caseloadFor(app.nurse.id);
  const counts = {
    draft: mine.filter((c) => c.status === 'draft').length,
    due: mine.filter((c) => c.status === 'due').length,
    complete: mine.filter((c) => c.status === 'complete').length,
  };
  $('#dashboard-stats').innerHTML = `
    <article class="stat-card"><span>Drafts</span><strong>${counts.draft}</strong><small>In progress</small></article>
    <article class="stat-card"><span>Reassessments due</span><strong>${counts.due}</strong><small>Scheduled</small></article>
    <article class="stat-card"><span>Current</span><strong>${counts.complete}</strong><small>Signed</small></article>
    <article class="stat-card"><span>My caseload</span><strong>${mine.length}</strong><small>All fictional</small></article>`;

  $('#recent-clients').innerHTML = mine
    .map(
      (c) => `<div class="patient-row">
        <div><strong>${esc(c.name)}</strong><span>${esc(c.setting)} · last assessed ${esc(c.lastAssessment)}</span></div>
        <span class="status ${statusClass(c.status)}">${esc(c.statusLabel)}</span>
      </div>`
    )
    .join('');
}

const statusClass = (s) => ({ due: 'amber', draft: 'blue', complete: 'green' }[s] || 'blue');

function renderClients(filter = '') {
  const q = filter.trim().toLowerCase();
  const list = caseloadFor(app.nurse.id)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.mrn.toLowerCase().includes(q));

  $('#client-list').innerHTML = list.length
    ? list
        .map(
          (c) => `<article class="patient-card">
            <div class="avatar soft" aria-hidden="true">${esc(initials(c.name))}</div>
            <div class="patient-main">
              <strong>${esc(c.name)}</strong>
              <span>${esc(c.mrn)} · age ${c.age} · ${esc(c.setting)}</span>
            </div>
            <span class="status ${statusClass(c.status)}">${esc(c.statusLabel)}</span>
            <button class="secondary" data-select-client="${esc(c.id)}">
              ${app.state.clientId === c.id ? 'Continue' : 'Assess'}
            </button>
          </article>`
        )
        .join('')
    : '<div class="empty-state"><p>No clients match that search.</p></div>';
}

const initials = (name) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function selectClient(id) {
  if (app.state.clientId !== id) {
    app.state = { ...blankState(), clientId: id };
  }
  saveState();
  showScreen('assessment');
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

function renderAssessment() {
  const client = currentClient();
  $('#assessment-empty').hidden = !!client;
  $('#assessment-body').hidden = !client;
  if (!client) {
    $('#assessment-client-name').textContent = 'No client selected';
    return;
  }

  $('#assessment-client-name').textContent = `${client.name} · ${client.mrn}`;
  $('#client-background').textContent = client.background;

  $('#source-options').innerHTML = app.rules.informationSources
    .map(
      (s) => `<label>
        <input type="checkbox" data-source="${esc(s.id)}" ${app.state.sources.includes(s.id) ? 'checked' : ''} />
        ${esc(s.label)} <span class="muted small">(${esc(s.evidenceType)})</span>
      </label>`
    )
    .join('');

  $('#task-list').innerHTML = app.rules.tasks.map(renderTaskCard).join('');
  recalculate();
}

function renderTaskCard(task) {
  const r = app.state.taskResponses[task.id] || {};
  const scoreOptions = task.options
    .map((o) => {
      const cap = o.maxDailyMinutes === null ? 'No limit' : `max ${o.maxDailyMinutes} min/day`;
      return `<label class="score-option">
        <input type="radio" name="score-${esc(task.id)}" value="${o.score}" data-task="${esc(task.id)}"
               ${r.score === o.score ? 'checked' : ''} />
        <span>
          <span class="score-num">${o.score}</span>${esc(stripLeadingScore(o.text))}
          <span class="score-cap">${cap}</span>
        </span>
      </label>`;
    })
    .join('');

  const days = DAY_KEYS.map(
    (d) => `<div class="day-cell">
      <label for="${esc(task.id)}-${d}">${DAY_LABELS[d]}</label>
      <input type="number" min="0" step="0.01" id="${esc(task.id)}-${d}"
             data-task="${esc(task.id)}" data-day="${d}" value="${(r.days || {})[d] ?? ''}" />
    </div>`
  ).join('');

  const perDay = task.usesTasksPerDay
    ? `<div>
         <label for="${esc(task.id)}-tpd">${esc(task.tasksPerDayLabel || 'Tasks per day')}</label>
         <input type="number" min="1" step="1" id="${esc(task.id)}-tpd"
                data-task="${esc(task.id)}" data-tpd value="${r.tasksPerDay ?? ''}" />
       </div>`
    : '';

  return `<details class="task-card" data-task-card="${esc(task.id)}" ${r.score ? 'open' : ''}>
    <summary>
      <span>
        <h4>${esc(task.label)}</h4>
        <span class="task-meta">${esc(task.category)} · ${task.note ? esc(task.note) : 'Select a score, then enter minutes per day'}</span>
      </span>
      <span class="task-total" data-total="${esc(task.id)}">—</span>
    </summary>
    <div class="task-body">
      <fieldset>
        <legend>Assistance score for ${esc(task.label)}</legend>
        <div class="score-list">${scoreOptions}</div>
      </fieldset>

      <div class="day-grid">${days}</div>

      <div class="task-controls">
        ${perDay}
        <div>
          <label for="${esc(task.id)}-provider">Provided by</label>
          <select id="${esc(task.id)}-provider" data-task="${esc(task.id)}" data-provider>
            <option value="paid" ${r.providedBy !== 'ifs' ? 'selected' : ''}>Paid caregiver</option>
            <option value="ifs" ${r.providedBy === 'ifs' ? 'selected' : ''}>Informal support (not authorized)</option>
          </select>
        </div>
      </div>

      <div class="task-alerts" data-alerts="${esc(task.id)}"></div>
      <div data-trace="${esc(task.id)}"></div>
    </div>
  </details>`;
}

const stripLeadingScore = (text) => text.replace(/^\s*\d+\s*-\s*/, '');

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

function buildInput() {
  return {
    taskResponses: app.state.taskResponses,
    adjustments: app.state.adjustments,
    acknowledgements: {},
  };
}

function recalculate() {
  const result = calculateAssessment(app.rules, buildInput());
  app.lastResult = result;

  for (const line of result.lines) {
    const totalEl = document.querySelector(`[data-total="${CSS.escape(line.taskId)}"]`);
    if (totalEl) totalEl.textContent = `${line.calculatedWeeklyMinutes} min/wk`;

    const alertsEl = document.querySelector(`[data-alerts="${CSS.escape(line.taskId)}"]`);
    if (alertsEl) {
      alertsEl.innerHTML = line.violations
        .map((v) => `<div class="alert ${v.severity === 'error' ? 'error' : 'warning'}">${esc(v.message)}</div>`)
        .join('');
    }

    const traceEl = document.querySelector(`[data-trace="${CSS.escape(line.taskId)}"]`);
    if (traceEl) traceEl.innerHTML = renderTrace(line);

    // Mark day inputs that breach their cap.
    for (const v of line.violations.filter((x) => x.type === 'cap-exceeded' && x.day)) {
      const input = document.getElementById(`${line.taskId}-${v.day}`);
      if (input) input.classList.add('over-cap');
    }
  }

  // Clear stale cap highlighting.
  $$('.day-cell input').forEach((input) => {
    const taskId = input.dataset.task;
    const line = result.lines.find((l) => l.taskId === taskId);
    const stillOver = line?.violations.some((v) => v.type === 'cap-exceeded' && v.day === input.dataset.day);
    if (!stillOver) input.classList.remove('over-cap');
  });

  const t = result.totals;
  $('#weekly-total').textContent = `${t.totalAuthorizedWeeklyMinutes} min`;
  $('#sum-pcs').textContent = `${t.pcsWeeklyMinutes} min`;
  $('#sum-ecls').textContent = `${t.eclsWeeklyMinutes} min`;
  $('#sum-ifs').textContent = `${t.informalSupportWeeklyMinutes} min`;
  $('#sum-hours').textContent = `${t.totalAuthorizedWeeklyHours} h`;
  $('#sum-units').textContent = t.totalUnitsPerWeek;
  $('#cosign-flag').hidden = !result.requiresSupervisorCosign;

  const blockers = result.blockingViolations.length;
  $('#violation-summary').textContent = blockers
    ? `${blockers} issue${blockers === 1 ? '' : 's'} must be resolved before finalizing.`
    : '';

  return result;
}

function renderTrace(line) {
  const t = line.trace;
  return `<details class="trace">
    <summary>How this was calculated</summary>
    <dl>
      <dt>Score</dt><dd>${t.selectedScore ?? 'Not assessed'}${t.selectedOptionText ? ` — ${esc(t.selectedOptionText)}` : ''}</dd>
      <dt>Daily maximum</dt><dd>${t.maxDailyMinutesForScore === null ? 'No limit' : `${t.maxDailyMinutesForScore} min`}</dd>
      <dt>Day entries</dt><dd>${t.dayEntries.map((d) => `${DAY_LABELS[d.day]} ${d.minutes}`).join(', ')}</dd>
      <dt>Formula</dt><dd><code>${esc(t.formula)}</code></dd>
      <dt>Routing</dt><dd>${esc(t.bucketRule)}</dd>
      <dt>Matrix version</dt><dd>${esc(t.ruleVersion)}</dd>
    </dl>
  </details>`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function renderResults() {
  const client = currentClient();
  const hasData = client && Object.keys(app.state.taskResponses).length > 0;
  $('#results-empty').hidden = !!hasData;
  $('#results-body').hidden = !hasData;
  if (!hasData) return;

  const result = calculateAssessment(app.rules, buildInput());
  app.lastResult = result;

  $('#results-client-name').textContent = `${client.name} · ${client.mrn}`;
  $('#result-total').textContent = formatDuration(result.totals.totalAuthorizedWeeklyMinutes);
  $('#result-daily').textContent =
    `${result.totals.totalAuthorizedWeeklyHours} hours per week · ${result.totals.totalUnitsPerWeek} billing units`;

  const assessed = result.lines.filter((l) => l.score !== null || l.calculatedWeeklyMinutes > 0).length;
  const total = app.rules.tasks.length;
  $('#result-completeness').textContent = `${assessed} of ${total}`;
  $('#result-completeness-note').textContent =
    assessed === total ? 'All tasks assessed' : `${total - assessed} task(s) not yet assessed`;

  // Blocking issues
  const blockers = result.blockingViolations;
  const panel = $('#result-blockers');
  panel.hidden = blockers.length === 0;
  if (blockers.length) {
    panel.innerHTML = `<h4>Resolve before finalizing</h4><ul>${blockers.map((b) => `<li>${esc(b.message)}</li>`).join('')}</ul>`;
  }

  // Breakdown
  const max = Math.max(...result.lines.map((l) => l.finalWeeklyMinutes), 1);
  $('#result-breakdown').innerHTML = result.lines
    .filter((l) => l.finalWeeklyMinutes > 0)
    .sort((a, b) => b.finalWeeklyMinutes - a.finalWeeklyMinutes)
    .map((l) => {
      const cls = l.excludedFromAuthorization ? 'ifs' : l.bucket === 'ECLS' ? 'ecls' : '';
      const tag = l.excludedFromAuthorization ? ' (informal support)' : ` (${l.bucket})`;
      return `<div class="bar-item">
        <div><span>${esc(l.label)}${tag}</span><strong>${l.finalWeeklyMinutes} min</strong></div>
        <div class="bar"><i class="${cls}" style="width:${roundTo((l.finalWeeklyMinutes / max) * 100, 1)}%"></i></div>
      </div>`;
    })
    .join('') || '<p class="muted small">No time recorded yet.</p>';

  // Adjustment rows
  $('#adjustment-list').innerHTML = result.lines
    .filter((l) => l.score !== null)
    .map((l) => {
      const adj = l.adjustment;
      return `<div class="adjust-row">
        <div>
          <strong>${esc(l.label)}</strong>
          <div class="adjust-values">
            ${adj ? `<span class="was">${adj.calculatedWeeklyMinutes} min</span><strong>${adj.adjustedWeeklyMinutes} min</strong>` : `${l.calculatedWeeklyMinutes} min`}
          </div>
        </div>
        <button class="secondary" data-adjust="${esc(l.taskId)}">${adj ? 'Edit' : 'Adjust'}</button>
        ${adj?.rationale ? `<p class="adjust-rationale">Rationale: ${esc(adj.rationale)}</p>` : ''}
      </div>`;
    })
    .join('');

  $('#overall-rationale').value = app.state.overallRationale;
  $('#attest').checked = app.state.attested;
  $('#disclaimer-text').textContent = result.disclaimer;
  updateFinalizeButton(result);
}

function updateFinalizeButton(result) {
  const ok = result.canFinalize && app.state.attested && app.state.overallRationale.trim().length > 0;
  $('#finalize-btn').disabled = !ok;
  $('#finalize-status').textContent = ok
    ? 'Ready to sign.'
    : !result.canFinalize
      ? 'Resolve the blocking issues above.'
      : !app.state.overallRationale.trim()
        ? 'Enter an overall nursing recommendation.'
        : 'Confirm the attestation to enable signing.';
}

// ---------------------------------------------------------------------------
// Adjustment dialog
// ---------------------------------------------------------------------------

let adjustTarget = null;

function openAdjustDialog(taskId) {
  const line = app.lastResult.lines.find((l) => l.taskId === taskId);
  if (!line) return;
  adjustTarget = taskId;

  const threshold =
    app.rules.adjustmentPolicy.rationaleRequiredWhen.find((r) => r.id === 'variance-threshold')?.thresholdPercent ?? 20;

  $('#adjust-title').textContent = `Adjust ${line.label}`;
  $('#adjust-calculated').textContent =
    `Calculated: ${line.calculatedWeeklyMinutes} min/week. A change beyond ${threshold}% requires a rationale. The calculated value is preserved.`;
  $('#adjust-minutes').value = line.finalWeeklyMinutes;
  $('#adjust-rationale').value = app.state.adjustments[taskId]?.rationale || '';
  $('#adjust-error').hidden = true;
  $('#adjust-dialog').showModal();
}

function commitAdjustment() {
  const taskId = adjustTarget;
  if (!taskId) return true;

  const minutes = Number($('#adjust-minutes').value);
  const rationale = $('#adjust-rationale').value;

  if (!Number.isFinite(minutes) || minutes < 0) {
    showAdjustError('Enter a valid number of minutes.');
    return false;
  }

  const candidate = {
    ...app.state.adjustments,
    [taskId]: { adjustedWeeklyMinutes: minutes, rationale, adjustedBy: nurseLabel(), adjustedAt: new Date().toISOString() },
  };

  const probe = calculateAssessment(app.rules, { ...buildInput(), adjustments: candidate });
  const missing = probe.violations.find((v) => v.type === 'missing-rationale' && v.taskId === taskId);
  if (missing) {
    showAdjustError(missing.message);
    return false;
  }

  app.state.adjustments = candidate;
  saveState();
  adjustTarget = null;
  return true;
}

function showAdjustError(msg) {
  const el = $('#adjust-error');
  el.textContent = msg;
  el.hidden = false;
  $('#rationale-required').hidden = false;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function wireEvents() {
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-screen]');
    if (nav) return showScreen(nav.dataset.screen);

    const go = e.target.closest('[data-go]');
    if (go) return showScreen(go.dataset.go);

    const pick = e.target.closest('[data-select-client]');
    if (pick) return selectClient(pick.dataset.selectClient);

    const adjust = e.target.closest('[data-adjust]');
    if (adjust) return openAdjustDialog(adjust.dataset.adjust);

    if (e.target.id === 'print-report') return window.print();
  });

  document.addEventListener('change', (e) => {
    const t = e.target;

    if (t.dataset.source !== undefined) {
      const id = t.dataset.source;
      app.state.sources = t.checked
        ? [...new Set([...app.state.sources, id])]
        : app.state.sources.filter((s) => s !== id);
      return saveState();
    }

    if (t.type === 'radio' && t.dataset.task) {
      ensureResponse(t.dataset.task).score = Number(t.value);
      saveState();
      return recalculate();
    }

    if (t.dataset.provider !== undefined) {
      ensureResponse(t.dataset.task).providedBy = t.value;
      saveState();
      return recalculate();
    }

    if (t.id === 'nurse-switcher') return switchNurse(t.value);

    if (t.id === 'attest') {
      app.state.attested = t.checked;
      saveState();
      return updateFinalizeButton(app.lastResult);
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;

    if (t.dataset.day) {
      const r = ensureResponse(t.dataset.task);
      r.days = r.days || {};
      r.days[t.dataset.day] = t.value === '' ? '' : Number(t.value);
      saveState();
      return recalculate();
    }

    if (t.dataset.tpd !== undefined) {
      ensureResponse(t.dataset.task).tasksPerDay = t.value === '' ? '' : Number(t.value);
      saveState();
      return recalculate();
    }

    if (t.id === 'client-search') return renderClients(t.value);

    if (t.id === 'nurse-switcher') return switchNurse(t.value);

    if (t.id === 'overall-rationale') {
      app.state.overallRationale = t.value;
      saveState();
      return updateFinalizeButton(app.lastResult);
    }
  });

  $('#adjust-form').addEventListener('submit', (e) => {
    const save = e.submitter && e.submitter.value === 'save';
    if (save && !commitAdjustment()) {
      e.preventDefault();
      return;
    }
    if (!save) adjustTarget = null;
    setTimeout(renderResults, 0);
  });

  $('#finalize-btn').addEventListener('click', () => {
    const result = app.lastResult;
    $('#finalize-status').textContent =
      `Signed by ${nurseLabel()} on ${new Date().toLocaleString()} · matrix ${result.ruleVersion} · ` +
      `${result.totals.totalAuthorizedWeeklyMinutes} min/week. (Prototype: not persisted to a clinical record.)`;
    $('#finalize-btn').disabled = true;
  });
}

function ensureResponse(taskId) {
  app.state.taskResponses[taskId] = app.state.taskResponses[taskId] || {};
  return app.state.taskResponses[taskId];
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  $('#today-date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  try {
    const [rules, clients, profiles] = await Promise.all([
      fetch('data/scoring-rules.json').then((r) => r.json()),
      fetch('data/demo-clients.json').then((r) => r.json()),
      fetch('data/nurse-profiles.json').then((r) => r.json()),
    ]);
    app.rules = rules;
    app.clients = clients.clients;
    app.profiles = profiles;
    app.nurse =
      profiles.profiles.find((p) => p.id === profiles.activeProfileId) || profiles.profiles[0] || null;
  } catch {
    document.querySelector('.main-content').innerHTML =
      '<div class="empty-state"><p><strong>Could not load scoring rules.</strong></p>' +
      '<p>This prototype loads JSON over HTTP. Run <code>npm run serve</code> and open the served address ' +
      'rather than opening the file directly.</p></div>';
    return;
  }

  $('#rule-version').textContent = `v${app.rules.ruleVersion}`;
  $('#org-name').textContent = app.profiles.organization.name;
  renderNurseSwitcher();
  renderIdentity();
  app.state = loadState();

  renderDashboard();
  renderClients();
  wireEvents();
  showScreen('dashboard');
  if (app.state.clientId) setSaveState('Draft restored');
}

boot();
