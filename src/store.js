/**
 * Durable RoleGate storage: identities.json plus per-session state.json under
 * $DSH_HOME/role-gate. Corrupt files are preserved next to the original and the
 * plugin continues with an empty in-memory view. All writes are serialized and
 * replace the target through a temporary file.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { normalizeIdentity } from './identity.js'

const VERSION = 1
const DEFAULT_MAX_STATE_ENTRIES = 500

/**
 * Resolve the DeepSeek Harness home without importing a DSH package, so the
 * plugin keeps working when it is linked into a profile.
 * @param {string|null|undefined} configured explicit override.
 * @returns {string} absolute home directory.
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return path.resolve(process.env.DSH_HOME.trim())
  }
  return path.join(homedir(), '.dsh')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Replace one JSON file without exposing partial content. Windows can refuse a
 * rename while another handle is closing, so transient codes are retried.
 * @param {string} file target path.
 * @param {unknown} value JSON-serializable value.
 */
async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(temp, text, 'utf8')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt === 5) {
        await unlink(temp).catch(() => {})
        throw error
      }
      await delay(20 * (attempt + 1))
    }
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

export class RoleGateStore {
  /**
   * @param {{home?: string, maxStateEntries?: number, maxInstructionsChars?: number, logger?: object}} options
   */
  constructor(options = {}) {
    this.root = path.join(resolveDshHome(options.home), 'role-gate')
    this.identityPath = path.join(this.root, 'identities.json')
    this.statePath = path.join(this.root, 'state.json')
    this.maxStateEntries = Number.isSafeInteger(options.maxStateEntries) && options.maxStateEntries > 0
      ? options.maxStateEntries
      : DEFAULT_MAX_STATE_ENTRIES
    this.maxInstructionsChars = options.maxInstructionsChars
    this.logger = options.logger
    this.identities = {}
    this.state = { version: VERSION, sessions: {} }
    this.errors = []
    this.loadError = null
    this.revision = 0
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
  }

  warn(message) {
    try {
      this.logger?.warn?.(`dsh-role-gate: ${message}`)
    } catch {
      // A logger failure must never break identity state.
    }
  }

  /** Load both files, quarantining corrupt content. Never throws. */
  async load() {
    await mkdir(this.root, { recursive: true })
    this.errors = []
    this.identities = await this.loadIdentities()
    const loadedState = await this.loadState()
    this.state = {
      version: VERSION,
      sessions: loadedState.sessions,
      ...(loadedState.pending ? { pending: loadedState.pending } : {}),
    }
    this.loadError = this.errors.length === 0
      ? null
      : this.errors.map((entry) => `${entry.file}: ${entry.message}`).join('; ')
    return {
      identities: this.identities,
      state: cloneJson(this.state),
      errors: this.errors.slice(),
    }
  }

  async loadIdentities() {
    const parsed = await this.readJsonFile(this.identityPath)
    if (parsed.kind === 'missing') return {}
    if (parsed.kind === 'invalid') {
      await this.quarantine(this.identityPath, parsed.message)
      this.errors.push({ file: this.identityPath, message: parsed.message })
      return {}
    }
    const root = parsed.value
    if (!root || typeof root !== 'object' || Array.isArray(root) || !root.identities || typeof root.identities !== 'object' || Array.isArray(root.identities)) {
      const message = 'expected an object with an "identities" map'
      await this.quarantine(this.identityPath, message)
      this.errors.push({ file: this.identityPath, message })
      return {}
    }
    const next = {}
    for (const [key, raw] of Object.entries(root.identities)) {
      try {
        next[key] = normalizeIdentity(raw, key, { maxInstructionsChars: this.maxInstructionsChars })
      } catch (error) {
        this.errors.push({ file: this.identityPath, message: `identity "${key}": ${errorMessage(error)}` })
        this.warn(`ignoring invalid identity "${key}": ${errorMessage(error)}`)
      }
    }
    return next
  }

  async loadState() {
    const parsed = await this.readJsonFile(this.statePath)
    if (parsed.kind === 'missing') return { sessions: {} }
    if (parsed.kind === 'invalid') {
      await this.quarantine(this.statePath, parsed.message)
      this.errors.push({ file: this.statePath, message: parsed.message })
      return { sessions: {} }
    }
    const root = parsed.value
    if (!root || typeof root !== 'object' || Array.isArray(root) || !root.sessions || typeof root.sessions !== 'object' || Array.isArray(root.sessions)) {
      const message = 'expected an object with a "sessions" map'
      await this.quarantine(this.statePath, message)
      this.errors.push({ file: this.statePath, message })
      return { sessions: {} }
    }
    const sessions = {}
    for (const [sessionId, record] of Object.entries(root.sessions)) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue
      const identity = record.identity
      if (identity !== null && typeof identity !== 'string') continue
      sessions[sessionId] = {
        identity: identity === null ? null : identity.trim(),
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
      }
    }
    let pending
    const rawPending = root.pending
    if (rawPending && typeof rawPending === 'object' && !Array.isArray(rawPending)
      && typeof rawPending.identity === 'string' && rawPending.identity.trim() !== '') {
      pending = {
        identity: rawPending.identity.trim(),
        updatedAt: typeof rawPending.updatedAt === 'string' ? rawPending.updatedAt : new Date(0).toISOString(),
      }
    }
    return { sessions, ...(pending ? { pending } : {}) }
  }

  async readJsonFile(file) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'invalid', message: `cannot read file: ${errorMessage(error)}` }
    }
    try {
      return { kind: 'ok', value: JSON.parse(text) }
    } catch (error) {
      return { kind: 'invalid', message: `invalid JSON: ${errorMessage(error)}` }
    }
  }

  async quarantine(file, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let target = `${file}.corrupt-${stamp}`
    for (let index = 2; index < 100; index += 1) {
      try {
        await rename(file, target)
        this.warn(`quarantined ${file} to ${target}: ${reason}`)
        return target
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'EEXIST') {
          target = `${file}.corrupt-${stamp}-${index}`
          continue
        }
        this.warn(`could not quarantine ${file}: ${errorMessage(error)}`)
        return undefined
      }
    }
    return undefined
  }

  enqueue(operation) {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** @param {Record<string, object>} next normalized identity map. */
  async replaceIdentities(next) {
    const payload = { version: VERSION, identities: next }
    await this.enqueue(() => writeJsonAtomic(this.identityPath, payload))
    this.identities = next
    this.revision += 1
  }

  /**
   * @param {string} sessionId live session id.
   * @param {string|null} identity identity name or null.
   */
  async setSessionIdentity(sessionId, identity) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('sessionId must be a non-empty string')
    }
    const previousSessions = this.state.sessions
    this.state.sessions = {
      ...this.state.sessions,
      [sessionId]: {
        identity,
        updatedAt: new Date().toISOString(),
      },
    }
    this.pruneState()
    try {
      await this.enqueue(() => writeJsonAtomic(this.statePath, this.state))
    } catch (error) {
      this.state.sessions = previousSessions
      throw error
    }
    this.revision += 1
  }

  /** @param {string} sessionId @returns {{identity: string|null, updatedAt: string}|undefined} */
  getSessionRecord(sessionId) {
    return this.state.sessions[sessionId]
  }

  /** @returns {string|undefined} identity chosen for the next new session. */
  getPendingIdentity() {
    return this.state.pending?.identity
  }

  /** @param {string} identity identity to apply to the next new session. */
  async setPendingIdentity(identity) {
    if (typeof identity !== 'string' || identity.trim() === '') {
      throw new Error('identity must be a non-empty string')
    }
    const previous = this.state.pending
    this.state.pending = {
      identity: identity.trim(),
      updatedAt: new Date().toISOString(),
    }
    try {
      await this.enqueue(() => writeJsonAtomic(this.statePath, this.state))
    } catch (error) {
      if (previous === undefined) delete this.state.pending
      else this.state.pending = previous
      throw error
    }
    this.revision += 1
  }

  /** @returns {Promise<boolean>} whether a pending identity was removed. */
  async clearPendingIdentity() {
    if (this.state.pending === undefined) return false
    const previous = this.state.pending
    delete this.state.pending
    try {
      await this.enqueue(() => writeJsonAtomic(this.statePath, this.state))
    } catch (error) {
      this.state.pending = previous
      throw error
    }
    this.revision += 1
    return true
  }

  /**
   * Clear every persisted session reference to a deleted identity, including
   * sessions that are no longer live. Live agents are handled by the runtime.
   * @param {string} identityName removed identity.
   * @returns {Promise<number>} number of rewritten session records.
   */
  async clearIdentityReferences(identityName) {
    const sessions = { ...this.state.sessions }
    let changed = 0
    const now = new Date().toISOString()
    for (const [sessionId, record] of Object.entries(sessions)) {
      if (record.identity !== identityName) continue
      sessions[sessionId] = { identity: null, updatedAt: now }
      changed += 1
    }
    if (changed === 0) return 0
    const previousSessions = this.state.sessions
    this.state.sessions = sessions
    try {
      await this.enqueue(() => writeJsonAtomic(this.statePath, this.state))
    } catch (error) {
      this.state.sessions = previousSessions
      throw error
    }
    this.revision += 1
    return changed
  }

  async deleteSession(sessionId) {
    if (!Object.hasOwn(this.state.sessions, sessionId)) return false
    const previousSessions = this.state.sessions
    const nextSessions = { ...this.state.sessions }
    delete nextSessions[sessionId]
    this.state.sessions = nextSessions
    try {
      await this.enqueue(() => writeJsonAtomic(this.statePath, this.state))
    } catch (error) {
      this.state.sessions = previousSessions
      throw error
    }
    this.revision += 1
    return true
  }

  pruneState() {
    const entries = Object.entries(this.state.sessions)
    if (entries.length <= this.maxStateEntries) return
    entries.sort((a, b) => {
      const left = Date.parse(a[1].updatedAt) || 0
      const right = Date.parse(b[1].updatedAt) || 0
      return right - left
    })
    this.state.sessions = Object.fromEntries(entries.slice(0, this.maxStateEntries))
  }

  snapshot() {
    return {
      identities: cloneJson(this.identities),
      state: cloneJson(this.state),
      loadError: this.loadError,
      revision: this.revision,
    }
  }
}
