/**
 * The team performance score.
 *
 * A single number that ranks people on a leaderboard is a dangerous thing to
 * ship without explaining, so this file is the explanation and the
 * configuration in one place. Nothing else computes a score.
 *
 * ## The formula
 *
 *   score = Σ (weightᵢ × normalisedᵢ) × recencyMultiplier
 *
 * Each factor is normalised to 0–1 against a **target**, which is the value at
 * which that factor is considered fully achieved. Anything beyond the target
 * still counts as 1 and no more.
 *
 * ### Why normalised rather than raw
 *
 * Raw counts cannot be added. Somebody with 400 emails and 2 leads would beat
 * somebody with 40 emails and 30 leads on any weighted sum of raw numbers,
 * because the units are not comparable. Normalising against a target makes the
 * factors dimensionless before they are combined.
 *
 * ### Why capped at the target
 *
 * Without a cap, one enormous number dominates the score and the other factors
 * stop mattering — the leaderboard becomes a ranking of whoever sent the most
 * email. Capping makes it a measure of *balance*: doing all five things well
 * scores higher than doing one thing enormously.
 *
 * ### The recency multiplier
 *
 * A person who did excellent work and left three months ago should not sit at
 * the top of a *current* performance board. Activity within the window scores
 * 1.0; it decays to a floor rather than to zero, because a score of zero would
 * imply they did nothing rather than that they have been away.
 *
 * ## What this score is not
 *
 * It is not a measure of value, effort or outcome. It counts activity, and
 * activity is a proxy — a consultant nursing one large corporate account will
 * score below somebody churning small enquiries, and that is a limitation of
 * counting rather than a judgement about either. The console labels it
 * "activity score" for that reason and shows the components beside it.
 *
 * ## Configuration
 *
 * Weights and targets live here as plain data. Changing the emphasis is editing
 * one number; adding a factor is one entry plus its accessor. No deployment
 * stores its own copy, so every environment scores identically.
 */

/**
 * The factors, their weights, and how each one's target is derived.
 *
 * ## Phase 17.3 replaced one factor and added two
 *
 * The 14.6 board scored `directory` — companies and contacts added — and
 * nothing about whether the person turned up at all. That rewarded data entry
 * and was blind to attendance, so the brief's six factors take its place:
 * emails, replies, campaigns and leads keep theirs, and **login consistency**
 * and **profile completion** join at 10% and 5%.
 *
 * Directory growth is still counted and still reported on every response. It
 * stopped being *scored*, which is a different thing from being ignored.
 *
 * ## Three kinds of target
 *
 * Not every factor scales with the reporting window, and pretending they all
 * did produced nonsense at both ends:
 *
 *   `window`   — a volume. The target scales with the window length, so a
 *                7-day report is not judged against a monthly quota.
 *   `workdays` — attendance. The target is the working days the window
 *                contains: signing in on all five days of a five-day window is
 *                full marks, not a sixth of it.
 *   `fixed`    — already a percentage, and it means the same thing whatever
 *                window is asked for.
 */
export const SCORE_FACTORS = Object.freeze([
  {
    key: 'emailsSent',
    label: 'Emails sent',
    /** Outbound effort. The most direct signal of day-to-day work. */
    weight: 0.25,
    target: 200,
    scaling: 'window',
    metric: 'emailsSent',
  },
  {
    key: 'replies',
    label: 'Replies received',
    /** A reply is the customer answering, which is worth more than the send. */
    weight: 0.25,
    target: 40,
    scaling: 'window',
    metric: 'replies',
  },
  {
    key: 'campaigns',
    label: 'Campaign activity',
    /** Deliberate, planned outreach rather than one-off mail. */
    weight: 0.2,
    target: 4,
    scaling: 'window',
    metric: 'campaigns',
  },
  {
    key: 'leads',
    label: 'Lead management',
    weight: 0.15,
    target: 60,
    scaling: 'window',
    metric: 'leadsCreated',
  },
  {
    key: 'loginConsistency',
    label: 'Login consistency',
    weight: 0.1,
    /**
     * Days with a recorded sign-in, against the working days in the window.
     *
     * Five sevenths of the window, floored at one. It is a crude calendar — it
     * knows nothing of public holidays or a four-day week — so every response
     * carries the target it used rather than leaving it to be inferred.
     */
    target: null,
    scaling: 'workdays',
    metric: 'loginDays',
  },
  {
    key: 'profileCompletion',
    label: 'Profile completion',
    /** Housekeeping, not work, so it carries the lightest weight the brief allows. */
    weight: 0.05,
    target: 100,
    scaling: 'fixed',
    metric: 'profileCompletion',
  },
])

/**
 * Weights by key. They sum to 1, so a perfect score before recency is exactly 1
 * and the printed percentage needs no rescaling.
 */
export const SCORE_WEIGHTS = Object.freeze(
  Object.fromEntries(SCORE_FACTORS.map((factor) => [factor.key, factor.weight])),
)

/**
 * The value at which a factor counts as fully achieved, **per 30 days**.
 *
 * Deliberately reachable rather than aspirational: a target nobody hits
 * compresses everybody into the bottom of the range and the score stops
 * discriminating. Excludes the factor whose target is a count of working days,
 * which is not a per-30-day quantity.
 */
export const SCORE_TARGETS_PER_30_DAYS = Object.freeze(
  Object.fromEntries(
    SCORE_FACTORS.filter((factor) => factor.target !== null).map((factor) => [
      factor.key,
      factor.target,
    ]),
  ),
)

/**
 * Human names for the factors, served with the score.
 *
 * Here rather than in the console, for the same reason the formula is: a label
 * written in a React component is a second description of the rule, and the two
 * drift apart the first time a factor is renamed.
 */
export const SCORE_LABELS = Object.freeze(
  Object.fromEntries(SCORE_FACTORS.map((factor) => [factor.key, factor.label])),
)

/**
 * The bands the brief names, in descending order.
 *
 * A band is a label for a **score**, not a verdict on a person, and it inherits
 * every limitation of the number underneath it. Nothing downstream re-implements
 * these thresholds: the score is served with its level already attached.
 */
export const PERFORMANCE_LEVELS = Object.freeze([
  { key: 'excellent', label: 'Excellent', min: 90, tone: 'success' },
  { key: 'good', label: 'Good', min: 75, tone: 'brand' },
  { key: 'average', label: 'Average', min: 60, tone: 'warning' },
  { key: 'needs_improvement', label: 'Needs improvement', min: 0, tone: 'danger' },
])

/**
 * The band a score falls in.
 *
 * @param {?number} score
 * @returns {?{ key: string, label: string, min: number, tone: string }} `null`
 *   when there is no score, which is not the same as the lowest band.
 */
export function performanceLevel(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return null

  return PERFORMANCE_LEVELS.find((level) => Number(score) >= level.min) ?? PERFORMANCE_LEVELS.at(-1)
}

/**
 * The target one factor is measured against, for a window of a given length.
 *
 * Exported because the employee dashboard prints "12 of 21 days" beside the
 * factor, and recomputing the denominator there would be a second copy of this
 * rule that drifts the first time the working week changes.
 *
 * @param {{ target: ?number, scaling: string }} factor
 * @param {number} [windowDays]
 */
export function factorTarget(factor, windowDays = 30) {
  const days = Math.max(windowDays, 1)

  if (factor.scaling === 'fixed') return factor.target
  if (factor.scaling === 'workdays') return Math.max(Math.round((days * 5) / 7), 1)

  return Math.max((factor.target * days) / 30, 1)
}

/** Recency decay. Activity inside the window is undecayed. */
export const SCORE_RECENCY = Object.freeze({
  /** Days of inactivity after which the multiplier reaches its floor. */
  decayOverDays: 30,
  /**
   * The floor. Not zero: somebody on leave has a low current score, not an
   * assertion that their recorded work never happened.
   */
  floor: 0.4,
})

/**
 * Recency multiplier for a last-activity timestamp.
 *
 * @param {?Date|string} lastActivityAt
 * @param {Date} [now]
 * @returns {number} Between `floor` and 1.
 */
export function recencyMultiplier(lastActivityAt, now = new Date()) {
  if (!lastActivityAt) return SCORE_RECENCY.floor

  const days = (now.getTime() - new Date(lastActivityAt).getTime()) / 86_400_000

  if (days <= 0) return 1
  if (days >= SCORE_RECENCY.decayOverDays) return SCORE_RECENCY.floor

  const decayed = 1 - (days / SCORE_RECENCY.decayOverDays) * (1 - SCORE_RECENCY.floor)

  return Number(decayed.toFixed(4))
}

/**
 * Scores one person's activity.
 *
 * Returns the score **and its components**, because a number nobody can
 * decompose is a number nobody trusts. The console renders the breakdown beside
 * the score for exactly that reason.
 *
 * @param {object} metrics       Raw counts for the window.
 * @param {object} [options]
 * @param {number} [options.windowDays] Length of the reporting window.
 * @param {?Date}  [options.lastActivityAt]
 * @returns {{ score: number, level: ?object, recency: number, components: object[] }}
 */
export function computePerformanceScore(metrics, { windowDays = 30, lastActivityAt = null } = {}) {
  const components = SCORE_FACTORS.map((factor) => {
    // Floored at 1 inside `factorTarget`, so a same-day report does not divide
    // by something near zero and hand everybody a perfect score.
    const target = factorTarget(factor, windowDays)
    const value = metrics[factor.metric] ?? 0
    // Capped at 1: see the note on balance above.
    const normalised = Math.min(value / target, 1)

    return {
      key: factor.key,
      label: factor.label,
      value,
      target: Number(target.toFixed(1)),
      weight: factor.weight,
      normalised: Number(normalised.toFixed(4)),
      contribution: Number((normalised * factor.weight).toFixed(4)),
      /** The same contribution expressed in points out of 100, so the parts
          visibly sum to the printed score without the reader multiplying. */
      points: Number((normalised * factor.weight * 100).toFixed(1)),
    }
  })

  const base = components.reduce((total, component) => total + component.contribution, 0)
  const recency = recencyMultiplier(lastActivityAt)
  const score = Number((base * recency * 100).toFixed(1))

  return {
    /** 0–100, rounded to one decimal. */
    score,
    /** Attached here so no caller re-implements the thresholds. */
    level: performanceLevel(score),
    recency,
    components,
  }
}

/**
 * The formula, as data.
 *
 * Served with the leaderboard so the console can explain the score without
 * restating the rules in the interface — a second description that would drift
 * the first time a weight changed.
 */
export function scoreDefinition(windowDays = 30) {
  return {
    formula: 'score = Σ (weight × min(value / target, 1)) × recency × 100',
    windowDays,
    recency: {
      ...SCORE_RECENCY,
      note: 'Multiplier from last recorded activity. Decays linearly to the floor.',
    },
    factors: SCORE_FACTORS.map((factor) => ({
      key: factor.key,
      label: factor.label,
      weight: factor.weight,
      scaling: factor.scaling,
      target: Number(factorTarget(factor, windowDays).toFixed(1)),
      targetPer30Days: factor.target,
    })),
    levels: PERFORMANCE_LEVELS,
    caveat:
      'Counts activity, not outcome or value. A consultant working one large account will score below one handling many small enquiries.',
  }
}

export default computePerformanceScore
