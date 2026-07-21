/**
 * CareTime Nurse — Scoring Engine
 *
 * Pure, dependency-free, data-driven. Every number it produces is derived from
 * the supplied rules object; there are no clinical constants in this file.
 * This is deliberate: the same rules JSON must drive the Phase 2 Flutter/Dart
 * implementation, and the engine must be portable line-for-line.
 *
 * Model (from the Michigan HCBS Needs Tool):
 *   - The nurse selects exactly ONE score (1-5) per task.
 *   - That score carries a maxDailyMinutes CAP (a ceiling, not an estimate).
 *   - The nurse enters ACTUAL minutes for each of the seven days.
 *   - weeklyMinutes = sum(day entries) * (tasksPerDay || 1)
 *
 * Arithmetic: all internal math is done in integer HUNDREDTHS of a minute.
 * The source spreadsheet computes 8.33 * 7 * 3 in binary floating point and
 * yields 174.92999999999998, which then propagates into an authorization total
 * of 1080.9299999999998. Authorization figures must not carry float drift, so
 * every value is converted to an integer on entry and divided only for display.
 *
 * @module scoring-engine
 */

/** Days of the week, in source-spreadsheet order. @type {readonly string[]} */
export const DAY_KEYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/** Scale factor for integer arithmetic (hundredths of a minute). */
const SCALE = 100;

/**
 * Convert a minute value to integer hundredths.
 * @param {number|string|null|undefined} value
 * @returns {number} integer hundredths of a minute; 0 for blank/invalid input
 */
export function toHundredths(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * SCALE);
}

/**
 * Convert integer hundredths back to a display minute value.
 * @param {number} hundredths
 * @returns {number} minutes, rounded half-up to 2 decimal places
 */
export function fromHundredths(hundredths) {
  return Math.round(hundredths) / SCALE;
}

/**
 * Round a number half-up to a fixed number of decimal places.
 * Avoids the banker's-rounding and float-representation surprises of toFixed.
 * @param {number} value
 * @param {number} [places=2]
 * @returns {number}
 */
export function roundTo(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Look up a task definition by id.
 * @param {object} rules
 * @param {string} taskId
 * @returns {object|null}
 */
export function findTask(rules, taskId) {
  return rules.tasks.find((t) => t.id === taskId) || null;
}

/**
 * Look up the option row for a given task and score.
 * @param {object} task
 * @param {number} score
 * @returns {object|null}
 */
export function findOption(task, score) {
  if (!task) return null;
  return task.options.find((o) => o.score === score) || null;
}

/**
 * Determine which authorization bucket a score routes to.
 * Derived from the source tool's subtotal formulas: scores 1-2 total into the
 * ECLS column, scores 3-5 into the PCS column.
 * @param {object} rules
 * @param {number} score
 * @returns {'ECLS'|'PCS'|null}
 */
export function bucketForScore(rules, score) {
  const buckets = rules.authorizationRouting.buckets;
  for (const [name, def] of Object.entries(buckets)) {
    if (def.scores.includes(score)) return /** @type {'ECLS'|'PCS'} */ (name);
  }
  return null;
}

/**
 * Calculate one task's weekly minutes, with a full audit trace.
 *
 * @param {object} rules   parsed scoring-rules.json
 * @param {string} taskId
 * @param {object} response
 * @param {number|null} response.score           selected score 1-5, or null if not assessed
 * @param {Object<string,number>} [response.days] minutes per day key
 * @param {number} [response.tasksPerDay]         multiplier, for tasks that use one
 * @param {boolean} [response.notAssessed]        nurse marked the task as not assessed
 * @param {'paid'|'ifs'} [response.providedBy]    'ifs' excludes it from paid totals
 * @param {string} [response.notes]
 * @returns {object} calculation result with trace and violations
 */
export function calculateTask(rules, taskId, response = {}) {
  const task = findTask(rules, taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);

  const violations = [];
  const score = response.score ?? null;
  const notAssessed = response.notAssessed === true || score === null;
  const option = findOption(task, score);

  if (score !== null && !option) {
    throw new Error(`Task "${taskId}" has no option for score ${score}`);
  }

  const days = response.days || {};
  const dayTrace = [];
  let sumHundredths = 0;

  for (const key of DAY_KEYS) {
    const raw = days[key];
    const h = toHundredths(raw);
    sumHundredths += h;
    dayTrace.push({ day: key, minutes: fromHundredths(h) });

    // Cap check. maxDailyMinutes of null means uncapped ("No Limit" in source).
    if (option && option.maxDailyMinutes !== null && h > toHundredths(option.maxDailyMinutes)) {
      violations.push({
        type: 'cap-exceeded',
        severity: task.capEnforcement === 'advisory-only-pending-clarification' ? 'warning' : 'error',
        taskId,
        day: key,
        entered: fromHundredths(h),
        max: option.maxDailyMinutes,
        message:
          `${task.label}: ${fromHundredths(h)} min on ${key} exceeds the ` +
          `${option.maxDailyMinutes} min/day maximum for score ${score}.`,
        requiresRationale: true,
      });
    }

    // Advisory soft cap (e.g. bathing "in general, not to exceed 45 minutes per day").
    if (task.softCapDailyMinutes && h > toHundredths(task.softCapDailyMinutes)) {
      violations.push({
        type: 'soft-cap-exceeded',
        severity: 'warning',
        taskId,
        day: key,
        entered: fromHundredths(h),
        max: task.softCapDailyMinutes,
        message: `${task.label}: ${task.softCapSourceText || `Soft cap ${task.softCapDailyMinutes} min/day`}`,
        requiresRationale: true,
      });
    }
  }

  // tasksPerDay multiplier applies only to tasks the source tool multiplies.
  const usesMultiplier = task.usesTasksPerDay === true;
  const rawMultiplier = usesMultiplier ? response.tasksPerDay : 1;
  const multiplier =
    rawMultiplier === null || rawMultiplier === undefined || rawMultiplier === '' || Number(rawMultiplier) <= 0
      ? 1
      : Number(rawMultiplier);

  if (usesMultiplier && (rawMultiplier === null || rawMultiplier === undefined || rawMultiplier === '')) {
    violations.push({
      type: 'missing-tasks-per-day',
      severity: 'warning',
      taskId,
      message: `${task.label}: ${task.tasksPerDayLabel || 'Tasks per day'} not entered; defaulted to 1.`,
      requiresRationale: false,
    });
  }

  const weeklyHundredths = notAssessed ? 0 : Math.round(sumHundredths * multiplier);
  const weeklyMinutes = fromHundredths(weeklyHundredths);
  const bucket = score === null ? null : bucketForScore(rules, score);
  const isIfs = response.providedBy === 'ifs';

  return {
    taskId,
    label: task.label,
    category: task.category,
    part: task.part,
    score,
    notAssessed,
    optionText: option ? option.text : null,
    maxDailyMinutes: option ? option.maxDailyMinutes : null,
    bucket,
    providedBy: response.providedBy || 'paid',
    excludedFromAuthorization: isIfs,
    calculatedWeeklyMinutes: weeklyMinutes,
    calculatedWeeklyHundredths: weeklyHundredths,
    notes: response.notes || '',
    violations,
    trace: {
      ruleVersion: rules.ruleVersion,
      sourceRows: task.sourceRows || null,
      selectedScore: score,
      selectedOptionText: option ? option.text : null,
      maxDailyMinutesForScore: option ? option.maxDailyMinutes : null,
      dayEntries: dayTrace,
      daySumMinutes: fromHundredths(sumHundredths),
      tasksPerDayApplied: multiplier,
      tasksPerDayUsedByThisTask: usesMultiplier,
      formula: `(${dayTrace.map((d) => d.minutes).join(' + ')}) × ${multiplier} = ${weeklyMinutes}`,
      bucketRule: score === null ? 'not assessed' : `score ${score} → ${bucket}`,
      weeklyMinutes,
    },
  };
}

/**
 * Calculate one complex-care line item.
 * Complex care always routes to PCS and always supports a tasksPerDay multiplier.
 * @param {object} rules
 * @param {string} itemId
 * @param {object} response
 * @returns {object}
 */
export function calculateComplexCareItem(rules, itemId, response = {}) {
  const item = rules.complexCare.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`Unknown complex care item id: ${itemId}`);

  const violations = [];
  const days = response.days || {};
  const dayTrace = [];
  let sumHundredths = 0;

  for (const key of DAY_KEYS) {
    const h = toHundredths(days[key]);
    sumHundredths += h;
    dayTrace.push({ day: key, minutes: fromHundredths(h) });

    if (item.maxDailyMinutes !== null && h > toHundredths(item.maxDailyMinutes)) {
      violations.push({
        type: 'cap-exceeded',
        severity: 'error',
        taskId: itemId,
        day: key,
        entered: fromHundredths(h),
        max: item.maxDailyMinutes,
        message: `${item.group}: ${fromHundredths(h)} min on ${key} exceeds the ${item.maxDailyMinutes} min/day maximum.`,
        requiresRationale: true,
      });
    }
  }

  if (item.limitUndetermined && sumHundredths > 0) {
    violations.push({
      type: 'limit-undetermined',
      severity: 'warning',
      taskId: itemId,
      message: `${item.group}: daily limit not yet determined by the state. Supervisor review recommended.`,
      requiresRationale: false,
    });
  }

  const rawMultiplier = response.tasksPerDay;
  const multiplier =
    rawMultiplier === null || rawMultiplier === undefined || rawMultiplier === '' || Number(rawMultiplier) <= 0
      ? 1
      : Number(rawMultiplier);
  const weeklyHundredths = Math.round(sumHundredths * multiplier);

  return {
    taskId: itemId,
    label: `${item.group} — ${item.text}`,
    category: 'COMPLEX',
    part: rules.complexCare.part,
    score: null,
    bucket: rules.complexCare.bucket,
    providedBy: response.providedBy || 'paid',
    excludedFromAuthorization: response.providedBy === 'ifs',
    calculatedWeeklyMinutes: fromHundredths(weeklyHundredths),
    calculatedWeeklyHundredths: weeklyHundredths,
    notes: response.notes || '',
    violations,
    trace: {
      ruleVersion: rules.ruleVersion,
      maxDailyMinutesForScore: item.maxDailyMinutes,
      dayEntries: dayTrace,
      daySumMinutes: fromHundredths(sumHundredths),
      tasksPerDayApplied: multiplier,
      formula: `(${dayTrace.map((d) => d.minutes).join(' + ')}) × ${multiplier} = ${fromHundredths(weeklyHundredths)}`,
      bucketRule: 'complex care → PCS (never ECLS)',
      weeklyMinutes: fromHundredths(weeklyHundredths),
    },
  };
}

/**
 * Evaluate the source tool's exclusion / anti-double-counting rules across a
 * completed set of line results.
 * @param {object} rules
 * @param {object[]} lines  results from calculateTask / calculateComplexCareItem
 * @param {object} input    the original assessment input
 * @returns {object[]} violations
 */
export function evaluateExclusions(rules, lines, input = {}) {
  const violations = [];
  const byId = Object.fromEntries(lines.map((l) => [l.taskId, l]));
  const minutesOf = (id) => (byId[id] ? byId[id].calculatedWeeklyHundredths : 0);

  // Toileting is superseded when BOTH catheter care and colostomy care are present.
  const catheterMinutes = minutesOf('catheterIndwelling') + minutesOf('catheterIntermittent');
  const colostomyMinutes = minutesOf('colostomyOnce') + minutesOf('colostomyTwice');
  const toiletingMinutes = minutesOf('toileting');

  if (catheterMinutes > 0 && colostomyMinutes > 0 && toiletingMinutes > 0) {
    violations.push({
      type: 'exclusion',
      ruleId: 'toileting-superseded-by-catheter-and-colostomy',
      severity: 'error',
      enforcement: 'hard-block',
      taskId: 'toileting',
      message:
        'Toileting minutes must be 0 when the member receives BOTH catheter care and colostomy care. ' +
        'Record the time under catheter care and colostomy care instead.',
      requiresRationale: true,
    });
  }

  // Transferring must not re-count bathing / toileting transfers.
  if (minutesOf('transferring') > 0 && (minutesOf('bathing') > 0 || toiletingMinutes > 0)) {
    violations.push({
      type: 'exclusion',
      ruleId: 'bathing-includes-transfer',
      severity: 'warning',
      enforcement: 'advisory-prompt',
      taskId: 'transferring',
      message:
        'Transferring excludes bathing and toileting transfers — bathing time already includes its transfer. ' +
        'Confirm the transferring minutes cover only other transfers.',
      requiresRationale: false,
      acknowledged: input.acknowledgements?.transferExclusion === true,
    });
  }

  // General supervision must not duplicate task-level cueing (any score-2 selection).
  const supervisionMinutes = byId.generalSupervision ? byId.generalSupervision.calculatedWeeklyHundredths : 0;
  const cueingTasks = lines.filter((l) => l.score === 2 && l.calculatedWeeklyHundredths > 0);
  if (supervisionMinutes > 0 && cueingTasks.length > 0) {
    violations.push({
      type: 'exclusion',
      ruleId: 'supervision-not-already-counted',
      severity: 'warning',
      enforcement: 'advisory-prompt',
      taskId: 'generalSupervision',
      message:
        'General supervision may only cover time not already captured elsewhere. Supervision or cueing is ' +
        `already recorded for: ${cueingTasks.map((t) => t.label).join(', ')}.`,
      requiresRationale: false,
      acknowledged: input.acknowledgements?.supervisionExclusion === true,
    });
  }

  return violations;
}

/**
 * Apply a nurse adjustment to a calculated line without destroying the original.
 * @param {object} line
 * @param {object} [adjustment]
 * @param {number} adjustment.adjustedWeeklyMinutes
 * @param {string} adjustment.rationale
 * @param {string} [adjustment.adjustedBy]
 * @param {string} [adjustment.adjustedAt]
 * @param {object} rules
 * @returns {object} the line with adjustment fields resolved
 */
export function applyAdjustment(line, adjustment, rules) {
  if (!adjustment || adjustment.adjustedWeeklyMinutes === null || adjustment.adjustedWeeklyMinutes === undefined) {
    return {
      ...line,
      adjustedWeeklyMinutes: null,
      finalWeeklyMinutes: line.calculatedWeeklyMinutes,
      finalWeeklyHundredths: line.calculatedWeeklyHundredths,
      adjustment: null,
    };
  }

  const adjustedHundredths = toHundredths(adjustment.adjustedWeeklyMinutes);
  const calculated = line.calculatedWeeklyHundredths;
  const deltaPercent =
    calculated === 0 ? (adjustedHundredths === 0 ? 0 : 100) : Math.abs((adjustedHundredths - calculated) / calculated) * 100;

  const threshold =
    rules.adjustmentPolicy.rationaleRequiredWhen.find((r) => r.id === 'variance-threshold')?.thresholdPercent ?? 20;

  const rationaleRequired = deltaPercent > threshold;
  const violations = [...line.violations];

  if (rationaleRequired && !String(adjustment.rationale || '').trim()) {
    violations.push({
      type: 'missing-rationale',
      severity: 'error',
      taskId: line.taskId,
      message:
        `${line.label}: adjustment of ${roundTo(deltaPercent, 1)}% exceeds the ${threshold}% threshold and ` +
        'requires a documented clinical rationale.',
      requiresRationale: true,
    });
  }

  return {
    ...line,
    violations,
    adjustedWeeklyMinutes: fromHundredths(adjustedHundredths),
    finalWeeklyMinutes: fromHundredths(adjustedHundredths),
    finalWeeklyHundredths: adjustedHundredths,
    adjustment: {
      calculatedWeeklyMinutes: line.calculatedWeeklyMinutes,
      adjustedWeeklyMinutes: fromHundredths(adjustedHundredths),
      deltaMinutes: fromHundredths(adjustedHundredths - calculated),
      deltaPercent: roundTo(deltaPercent, 1),
      thresholdPercent: threshold,
      rationaleRequired,
      rationale: adjustment.rationale || '',
      adjustedBy: adjustment.adjustedBy || null,
      adjustedAt: adjustment.adjustedAt || null,
    },
  };
}

/**
 * Calculate a complete assessment.
 *
 * @param {object} rules parsed scoring-rules.json
 * @param {object} input
 * @param {Object<string,object>} [input.taskResponses]
 * @param {Object<string,object>} [input.complexCare]
 * @param {object} [input.generalSupervision]
 * @param {Object<string,object>} [input.adjustments]
 * @param {object} [input.acknowledgements]
 * @returns {object} full assessment result
 */
export function calculateAssessment(rules, input = {}) {
  const taskResponses = input.taskResponses || {};
  const complexCare = input.complexCare || {};
  const adjustments = input.adjustments || {};

  /** @type {object[]} */
  const lines = [];

  for (const task of rules.tasks) {
    const response = taskResponses[task.id];
    if (!response) continue;
    lines.push(calculateTask(rules, task.id, response));
  }

  for (const [itemId, response] of Object.entries(complexCare)) {
    if (!response) continue;
    lines.push(calculateComplexCareItem(rules, itemId, response));
  }

  // General supervision is modelled as a first-class ECLS line.
  if (input.generalSupervision) {
    const gs = input.generalSupervision;
    const days = gs.days || {};
    let sum = 0;
    const dayTrace = [];
    for (const key of DAY_KEYS) {
      const h = toHundredths(days[key]);
      sum += h;
      dayTrace.push({ day: key, minutes: fromHundredths(h) });
    }
    lines.push({
      taskId: 'generalSupervision',
      label: rules.generalSupervision.label,
      category: 'SUPERVISION',
      part: 3,
      score: null,
      bucket: rules.generalSupervision.bucket,
      providedBy: gs.providedBy || 'paid',
      excludedFromAuthorization: gs.providedBy === 'ifs',
      calculatedWeeklyMinutes: fromHundredths(sum),
      calculatedWeeklyHundredths: sum,
      notes: gs.notes || '',
      violations: [],
      trace: {
        ruleVersion: rules.ruleVersion,
        dayEntries: dayTrace,
        daySumMinutes: fromHundredths(sum),
        tasksPerDayApplied: 1,
        formula: `(${dayTrace.map((d) => d.minutes).join(' + ')}) × 1 = ${fromHundredths(sum)}`,
        bucketRule: 'general supervision → ECLS',
        weeklyMinutes: fromHundredths(sum),
      },
    });
  }

  const exclusionViolations = evaluateExclusions(rules, lines, input);

  const adjusted = lines.map((line) => applyAdjustment(line, adjustments[line.taskId], rules));

  // Totals. Informal-support (IFS) time is recorded but never authorized.
  let pcs = 0;
  let ecls = 0;
  let ifs = 0;
  for (const line of adjusted) {
    const h = line.finalWeeklyHundredths;
    if (line.excludedFromAuthorization) {
      ifs += h;
      continue;
    }
    if (line.bucket === 'PCS') pcs += h;
    else if (line.bucket === 'ECLS') ecls += h;
  }

  const totalAuthorized = pcs + ecls;
  const unitMinutes = rules.calculation.billingUnitMinutes;
  const hoursPerWeek = fromHundredths(totalAuthorized) / 60;

  const allViolations = [...adjusted.flatMap((l) => l.violations), ...exclusionViolations];

  const blocking = allViolations.filter(
    (v) => v.severity === 'error' && !v.acknowledged
  );

  return {
    ruleVersion: rules.ruleVersion,
    ruleEffectiveDate: rules.effectiveDate,
    ruleStatus: rules.status,
    disclaimer: rules.disclaimer,
    lines: adjusted,
    violations: allViolations,
    blockingViolations: blocking,
    canFinalize: blocking.length === 0,
    totals: {
      pcsWeeklyMinutes: fromHundredths(pcs),
      eclsWeeklyMinutes: fromHundredths(ecls),
      informalSupportWeeklyMinutes: fromHundredths(ifs),
      totalAuthorizedWeeklyMinutes: fromHundredths(totalAuthorized),
      totalAuthorizedWeeklyHours: roundTo(hoursPerWeek, 2),
      totalAuthorizedDailyAverageMinutes: roundTo(fromHundredths(totalAuthorized) / 7, 2),
      pcsUnitsPerWeek: roundTo(fromHundredths(pcs) / unitMinutes, 2),
      eclsUnitsPerWeek: roundTo(fromHundredths(ecls) / unitMinutes, 2),
      totalUnitsPerWeek: roundTo(fromHundredths(totalAuthorized) / unitMinutes, 2),
      billingUnitMinutes: unitMinutes,
    },
    requiresSupervisorCosign: hoursPerWeek > rules.supervisorReview.thresholdHoursPerWeek,
    supervisorCosignThresholdHours: rules.supervisorReview.thresholdHoursPerWeek,
  };
}

/**
 * Format minutes as "H hours M minutes" for report display.
 * @param {number} minutes
 * @returns {string}
 */
export function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m === 0) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
}
