/**
 * An in-memory `LeadShare` collection, for the harnesses that never touch Mongo.
 *
 * ## Why every lead harness needs this
 *
 * Standing sharing grants live in their own collection, and the read paths —
 * the register listing, the facets, and `loadLead` whenever shared access is
 * allowed — ask it "whose registers may this person read?". Mongoose buffers a
 * query made with no connection and then throws after ten seconds, so a harness
 * that mocks `Lead` but not this one does not fail an assertion: it dies.
 *
 * Shared rather than copied into each harness because there are a dozen of
 * them, and a stub that drifts between files is worse than no stub — one suite
 * would be asserting against sharing rules a different suite does not have.
 *
 * `install()` with no grants is the important default: it reproduces the state
 * every existing suite was written against, where nobody holds a standing
 * grant, so those suites keep asserting exactly what they always did.
 */

const B = new URL('../../src', import.meta.url).href
const { LeadShare } = await import(`${B}/models/leadShare.model.js`)

/** Matches a row against the small filter shapes this collection is queried with. */
function matches(row, filter = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$in' in value) {
      return value.$in.some((candidate) => String(candidate) === String(row[key]))
    }
    if (value && typeof value === 'object' && '$nin' in value) {
      return !value.$nin.some((candidate) => String(candidate) === String(row[key]))
    }
    return String(row[key]) === String(value)
  })
}

/**
 * Replaces the model's statics with an in-memory store.
 *
 * @param {Array<{ owner: string, viewer: string, createdBy?: string }>} [seed]
 * @returns {{ rows: object[], grant: Function, calls: object[], reset: Function }}
 *   `rows` is live — read it to assert what a save wrote.
 */
export function installLeadShareMock(seed = []) {
  const state = { rows: seed.map((row) => ({ createdBy: null, ...row })), calls: [] }

  LeadShare.distinct = async (field, filter) => {
    state.calls.push({ op: 'distinct', field, filter })
    const seen = new Map()
    for (const row of state.rows) {
      if (matches(row, filter)) seen.set(String(row[field]), row[field])
    }
    return [...seen.values()]
  }

  LeadShare.find = (filter) => {
    const found = state.rows.filter((row) => matches(row, filter))
    const chain = { lean: async () => found, then: (res, rej) => Promise.resolve(found).then(res, rej) }
    return chain
  }

  LeadShare.countDocuments = async (filter) => state.rows.filter((row) => matches(row, filter)).length

  /** Upsert only, which is all `setGrantsForOwner` asks of it. */
  LeadShare.updateOne = async (filter, update, options = {}) => {
    state.calls.push({ op: 'updateOne', filter, update, options })

    const existing = state.rows.find((row) => matches(row, filter))
    if (existing) return { matchedCount: 1, modifiedCount: 0, upsertedCount: 0 }
    if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }

    state.rows.push({ createdBy: null, ...update.$setOnInsert, createdAt: new Date() })
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
  }

  LeadShare.deleteMany = async (filter) => {
    state.calls.push({ op: 'deleteMany', filter })
    const before = state.rows.length
    state.rows = state.rows.filter((row) => !matches(row, filter))
    return { deletedCount: before - state.rows.length }
  }

  return {
    get rows() {
      return state.rows
    },
    get calls() {
      return state.calls
    },
    /** Pairs currently granted, as `owner>viewer` strings, for compact assertions. */
    pairs() {
      return state.rows.map((row) => `${String(row.owner)}>${String(row.viewer)}`).sort()
    },
    grant(owner, viewer, createdBy = null) {
      state.rows.push({ owner, viewer, createdBy, createdAt: new Date() })
    },
    reset(next = []) {
      state.rows = next.map((row) => ({ createdBy: null, ...row }))
      state.calls = []
    },
  }
}

export default { installLeadShareMock }
