/**
 * Per-agent RoleGate runtime. Applies the identity capability mask, the prompt
 * section, and the skill gate on the calling agent's scope. A switch updates
 * `desired`; `agent/pre-step` promotes it to `applied` and re-registers the
 * restriction, so an in-flight step is never interrupted.
 */

import {
  META_TOOLS,
  RoleGateError,
  computeAllow,
  isToolAuthorized,
  renderIdentitySection,
  resolveLibrary,
  skillGateReason,
  summarizeIdentity,
} from './identity.js'

const SECTION_NAME = 'role-gate:identity'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Names reported by `tools.restrict()` as not restrictable in this scope. */
function parseUnknownToolNames(error) {
  const message = errorMessage(error)
  const head = message.split('; known global tools:')[0]
  return [...head.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

export class RoleGateRuntime {
  /**
   * @param {{ctx: any, store: import('./store.js').RoleGateStore, config: object, logger?: object}} options
   */
  constructor({ ctx, store, config, logger }) {
    this.ctx = ctx
    this.store = store
    this.config = config
    this.logger = logger
    /** @type {Map<string, object>} */
    this.states = new Map()
    /** @type {Map<string, Promise<object|undefined>>} */
    this.attaching = new Map()
    this.library = { resolved: new Map(), errors: new Map() }
    this.suppressChange = false
    this.readyError = null
    this.ready = this.start()
  }

  warn(message) {
    try {
      this.logger?.warn?.(`dsh-role-gate: ${message}`)
    } catch {
      // Logging must never break identity handling.
    }
  }

  async start() {
    try {
      await this.store.load()
      this.rebuildLibrary()
      for (const agent of this.ctx.agents.list()) {
        try {
          await this.attach(agent)
        } catch (error) {
          this.warn(`cannot initialize agent ${agent.id}: ${errorMessage(error)}`)
        }
      }
    } catch (error) {
      this.readyError = error
      this.warn(`initialization failed: ${errorMessage(error)}`)
    }
  }

  rebuildLibrary() {
    this.library = resolveLibrary(this.store.identities)
  }

  identityUsable(name) {
    const definition = this.store.identities[name]
    return definition !== undefined && this.library.resolved.has(name)
  }

  /**
   * Initialize one agent. Deduplicated because startup and `agent/created` can
   * race for the same agent.
   * @param {any} agent
   * @returns {Promise<object|undefined>}
   */
  attach(agent) {
    const existing = this.states.get(agent.id)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = this.attaching.get(agent.id)
    if (pending !== undefined) return pending
    const promise = this.doAttach(agent).finally(() => {
      this.attaching.delete(agent.id)
    })
    this.attaching.set(agent.id, promise)
    return promise
  }

  async doAttach(agent) {
    if (this.states.has(agent.id)) return this.states.get(agent.id)
    let desired = null
    let persist = false
    let parentDecided = false
    let pendingConsumed = false
    const ownRecord = this.store.getSessionRecord(agent.id)
    if (ownRecord !== undefined) {
      desired = ownRecord.identity
    } else {
      const parentId = agent.session?.header?.parentSession
      if (typeof parentId === 'string' && parentId !== '') {
        const parentState = this.states.get(parentId)
        const parentRecord = this.store.getSessionRecord(parentId)
        const inherited = parentState !== undefined
          ? parentState.desired
          : parentRecord !== undefined
            ? parentRecord.identity
            : undefined
        if (inherited !== undefined) {
          desired = inherited
          persist = true
          parentDecided = true
        }
      }
      if (!parentDecided && desired === null) {
        const pending = this.store.getPendingIdentity()
        if (pending !== undefined) {
          if (this.identityUsable(pending)) {
            desired = pending
            persist = true
            pendingConsumed = true
          } else {
            this.warn(`pending identity "${pending}" is unavailable; clearing it`)
            try {
              await this.store.clearPendingIdentity()
            } catch (error) {
              this.warn(`cannot clear invalid pending identity: ${errorMessage(error)}`)
            }
          }
        }
      }
      if (!parentDecided && desired === null && this.config.defaultIdentity) {
        desired = this.config.defaultIdentity
        persist = true
      }
    }
    if (desired !== null && !this.identityUsable(desired)) {
      this.warn(`identity "${desired}" is unavailable for session ${agent.id}; starting with no identity`)
      desired = null
      // Replace a stale record so the warning does not repeat on every attach.
      persist = ownRecord !== undefined
    }

    const state = {
      agent,
      desired,
      applied: null,
      appliedResolved: null,
      dirty: true,
      restrictionDisposer: null,
      appliedAllowKey: null,
      knownToolNames: null,
      knownTools: [],
      unrestrictableNames: new Set(),
      sectionDisposer: null,
      guardDisposer: null,
      preStepDisposer: null,
      assembleDisposer: null,
    }
    this.states.set(agent.id, state)
    this.registerSection(state)
    this.registerGuard(state)
    this.registerAssembleFilter(state)
    this.registerPreStep(state)

    // A freshly created/resumed agent has no in-flight step, so the initial
    // identity can be applied immediately.
    state.applied = desired
    state.appliedResolved = desired === null ? null : this.library.resolved.get(desired) ?? null
    if (state.appliedResolved === null && desired !== null) state.applied = null
    state.dirty = false
    this.applyRestriction(state)

    if (persist) {
      try {
        await this.store.setSessionIdentity(agent.id, state.applied)
      } catch (error) {
        this.warn(`cannot persist inherited identity for ${agent.id}: ${errorMessage(error)}`)
      }
    }
    if (pendingConsumed) {
      try {
        await this.store.clearPendingIdentity()
      } catch (error) {
        this.warn(`cannot clear the consumed pending identity: ${errorMessage(error)}`)
      }
    }
    return state
  }

  registerSection(state) {
    try {
      state.sectionDisposer = state.agent.ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: this.config.sectionOrder,
        text: () => renderIdentitySection(state.appliedResolved, this.config),
      })
    } catch (error) {
      this.warn(`cannot register prompt section for ${state.agent.id}: ${errorMessage(error)}`)
    }
  }

  registerGuard(state) {
    try {
      state.guardDisposer = state.agent.ctx.tools.guard((exec) => {
        const resolved = state.appliedResolved
        if (resolved === null) return undefined
        if (state.unrestrictableNames.has(exec.name)) return undefined
        if (exec.name === 'skill') {
          const args = exec.arguments
          const skillName = args && typeof args === 'object' ? args.name : undefined
          const reason = skillGateReason(resolved, skillName, this.config)
          if (reason !== undefined) return reason
        }
        if (!isToolAuthorized(resolved, exec.name, this.config)) {
          return `RoleGate: tool "${exec.name}" is not authorized by identity "${resolved.name}". Use role_gate_find_local to inspect local capabilities, or ask the user to switch or update the identity.`
        }
        return undefined
      })
    } catch (error) {
      this.warn(`cannot register skill/tool gate for ${state.agent.id}: ${errorMessage(error)}`)
    }
  }

  registerAssembleFilter(state) {
    try {
      state.assembleDisposer = state.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const resolved = state.appliedResolved
        const value = await next()
        if (resolved === null || !Array.isArray(value?.tools)) return value
        const tools = value.tools.filter((tool) => (
          state.unrestrictableNames.has(tool.name)
          || isToolAuthorized(resolved, tool.name, this.config)
        ))
        return tools.length === value.tools.length ? value : { ...value, tools }
      })
    } catch (error) {
      this.warn(`cannot register prompt tool filter for ${state.agent.id}: ${errorMessage(error)}`)
    }
  }

  registerPreStep(state) {
    try {
      state.preStepDisposer = state.agent.ctx.on('agent/pre-step', (_payload, next) => {
        try {
          this.promote(state)
        } catch (error) {
          this.warn(`cannot promote identity before step for ${state.agent.id}: ${errorMessage(error)}`)
        }
        return next()
      })
    } catch (error) {
      this.warn(`cannot register pre-step listener for ${state.agent.id}: ${errorMessage(error)}`)
    }
  }

  /** Move `desired` into `applied` and replace the restriction before assembly. */
  promote(state) {
    if (state.dirty === false && state.desired === state.applied) return
    let desired = state.desired
    let resolved = desired === null ? null : this.library.resolved.get(desired) ?? null
    if (desired !== null && resolved === null) {
      this.warn(`identity "${desired}" is no longer resolvable; clearing it for ${state.agent.id}`)
      desired = null
      state.desired = null
      resolved = null
    }
    state.applied = desired
    state.appliedResolved = resolved
    state.dirty = false
    this.applyRestriction(state)
  }

  globalToolNames() {
    return this.ctx.tools.schemas().map((schema) => schema.name)
  }

  applyRestriction(state) {
    this.suppressChange = true
    try {
      // Drop the old mask so the registry view exposes every inherited tool
      // name again — preset-scoped tools are inherited too, and `allow` must
      // name them or the restriction would hide them.
      this.disposeRestriction(state)
      const schemas = this.ctx.tools.schemas(state.agent)
      const known = new Set(schemas.map((schema) => schema.name))
      state.knownToolNames = known
      state.knownTools = schemas.map((schema) => ({
        name: schema.name,
        description: schema.description ?? '',
      }))
      state.unrestrictableNames = new Set()
      const allow = computeAllow(state.appliedResolved, known, this.config)
      if (allow === null) {
        state.appliedAllowKey = null
        return
      }
      let names = allow
      let nextDisposer = null
      for (let attempt = 0; attempt < 4 && nextDisposer === null; attempt += 1) {
        try {
          nextDisposer = state.agent.ctx.tools.restrict({ allow: names })
        } catch (error) {
          // The agent's own layer (for example a child's structured-output
          // tool) is not restrictable. Keep those names out of `allow` and
          // let the guard treat them as always available machinery.
          const unknown = parseUnknownToolNames(error)
          if (unknown.length === 0) {
            this.warn(`cannot apply tool restriction for ${state.agent.id}: ${errorMessage(error)}`)
            return
          }
          for (const name of unknown) {
            state.unrestrictableNames.add(name)
            names = names.filter((entry) => entry !== name)
          }
        }
      }
      if (nextDisposer === null) {
        this.warn(`cannot apply tool restriction for ${state.agent.id}: no restrictable allow list remained`)
        return
      }
      state.restrictionDisposer = nextDisposer
      state.appliedAllowKey = names.join('\n')
    } finally {
      this.suppressChange = false
    }
  }

  disposeRestriction(state) {
    const previous = state.restrictionDisposer
    state.restrictionDisposer = null
    state.appliedAllowKey = null
    if (previous !== null) {
      try {
        previous()
      } catch {
        // Already disposed with the agent scope.
      }
    }
  }

  /**
   * Select an identity for one agent. Persists the choice and defers the
   * capability change to the next `agent/pre-step`.
   * @param {any} agent
   * @param {string|null} name
   * @returns {Promise<object>}
   */
  async setDesired(agent, name) {
    await this.ready
    let state = this.states.get(agent.id)
    if (state === undefined) state = await this.attach(agent)
    if (state === undefined) throw new RoleGateError('AGENT_UNAVAILABLE', `agent ${agent.id} is not available`)
    let desired = null
    if (name !== null && name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new RoleGateError('INVALID_NAME', 'identity name must be a non-empty string, or null to clear it')
      }
      const candidate = name.trim()
      if (!Object.hasOwn(this.store.identities, candidate)) {
        const known = Object.keys(this.store.identities).sort().join(', ') || '(none)'
        throw new RoleGateError('MISSING_IDENTITY', `identity "${candidate}" does not exist; known identities: ${known}`)
      }
      if (this.library.errors.has(candidate)) {
        throw new RoleGateError('INVALID_IDENTITY', `identity "${candidate}" is invalid: ${this.library.errors.get(candidate).message}`)
      }
      desired = candidate
    }
    const previous = state.desired
    state.desired = desired
    state.dirty = true
    try {
      await this.store.setSessionIdentity(agent.id, desired)
    } catch (error) {
      state.desired = previous
      throw new RoleGateError('STORE_WRITE_FAILED', `cannot persist the identity choice: ${errorMessage(error)}`)
    }
    return state
  }

  appliedResolvedFor(agent) {
    return this.states.get(agent.id)?.appliedResolved ?? null
  }

  /**
   * Every tool name and description visible to this agent before RoleGate's
   * restriction was applied — the full local catalog `find_local` searches.
   * @param {any} agent live agent.
   * @returns {{name: string, description: string}[]} catalog.
   */
  knownToolsFor(agent) {
    const state = this.states.get(agent.id)
    if (state === undefined || state.appliedResolved === null) {
      return this.ctx.tools.schemas(agent).map((schema) => ({
        name: schema.name,
        description: schema.description ?? '',
      }))
    }
    if (Array.isArray(state.knownTools) && state.knownTools.length > 0) return state.knownTools
    return this.ctx.tools.schemas(agent).map((schema) => ({
      name: schema.name,
      description: schema.description ?? '',
    }))
  }

  /**
   * The model-facing tool names and the RoleGate prompt section after every
   * assembly filter runs. This is the real surface the next request will carry,
   * not the registry view.
   * @param {any} agent live agent.
   * @returns {Promise<{tools: string[], section: string|null}|null>} surface, or null when assembly failed.
   */
  async effectiveSurface(agent) {
    try {
      const assembly = await this.ctx.systemPrompt.assemble({ scope: agent })
      const section = Array.isArray(assembly?.sections)
        ? assembly.sections.find((entry) => entry.name === 'role-gate:identity')?.text ?? null
        : null
      return {
        tools: Array.isArray(assembly?.tools) ? assembly.tools.map((tool) => tool.name) : [],
        section,
      }
    } catch (error) {
      this.warn(`cannot assemble the effective surface for ${agent.id}: ${errorMessage(error)}`)
      return null
    }
  }

  /**
   * Compact summaries of every defined identity, safe to expose without an
   * active session (used by the new-session selector).
   * @returns {object[]} summaries in name order.
   */
  identitySummaries() {
    return Object.keys(this.store.identities)
      .sort()
      .map((name) => {
        const resolved = this.library.resolved.get(name)
        if (resolved !== undefined) {
          return {
            ...summarizeIdentity(resolved),
            error: null,
          }
        }
        const definition = this.store.identities[name]
        return {
          name,
          title: definition?.title ?? name,
          description: definition?.description ?? '',
          inherits: [...(definition?.inherits ?? [])],
          toolCount: 0,
          skillCount: 0,
          tools: [],
          skills: [],
          allowWebFallback: definition?.allowWebFallback,
          draft: definition?.draft === true,
          error: this.library.errors.get(name)?.message ?? 'identity cannot be resolved',
        }
      })
  }

  /**
   * @param {any} agent
   * @param {{detailed?: boolean}} [options]
   * @returns {object}
   */
  statusFor(agent, options = {}) {
    const state = this.states.get(agent.id)
    const current = state?.desired ?? null
    const applied = state?.applied ?? null
    const currentResolved = current === null ? null : this.library.resolved.get(current) ?? null
    const appliedResolved = state?.appliedResolved ?? null
    const identities = this.identitySummaries()
    const detailed = options.detailed === true
    let visible = null
    let knownNames = null
    if (detailed) {
      const globalNames = this.globalToolNames()
      const agentNames = this.ctx.tools.schemas(agent).map((schema) => schema.name)
      knownNames = state?.knownToolNames ?? new Set([...globalNames, ...agentNames])
      visible = appliedResolved === null
        ? agentNames
        : agentNames.filter((name) => (
          state?.unrestrictableNames.has(name)
          || isToolAuthorized(appliedResolved, name, this.config)
        ))
    }
    return {
      sessionId: agent.id,
      current,
      applied,
      pending: state !== undefined ? state.desired !== state.applied || state.dirty : false,
      currentTitle: currentResolved?.title ?? null,
      appliedTitle: appliedResolved?.title ?? null,
      currentDraft: currentResolved?.draft === true,
      appliedDraft: appliedResolved?.draft === true,
      currentTools: currentResolved ? [...currentResolved.tools] : [],
      currentSkills: currentResolved ? [...currentResolved.skills] : [],
      appliedTools: appliedResolved ? [...appliedResolved.tools] : [],
      appliedSkills: appliedResolved ? [...appliedResolved.skills] : [],
      pendingMissingTools: detailed && currentResolved
        ? currentResolved.tools.filter((name) => name !== '*' && !knownNames.has(name))
        : [],
      identities,
      loadError: this.store.loadError,
      revision: this.store.revision,
      visibleToolCount: visible === null ? null : visible.length,
      visibleTools: visible,
      skillGate: this.config.enforceSkills !== false,
    }
  }

  listText(agent) {
    const status = this.statusFor(agent)
    const lines = ['RoleGate identities:']
    if (status.identities.length === 0) {
      lines.push('  (none defined)')
      lines.push('Create one with role_gate_author action=catalog, then action=create with confirmed=true.')
    } else {
      for (const identity of status.identities) {
        const marker = identity.name === status.current ? '*' : identity.name === status.applied ? '+' : ' '
        const toolCount = identity.toolCount === 'all' ? 'all tools' : `${identity.toolCount} tools`
        const skillCount = identity.skillCount === 'all' ? 'all skills' : `${identity.skillCount} skills`
        const error = identity.error ? `  ERROR: ${identity.error}` : ''
        const draft = identity.draft ? ' [draft]' : ''
        lines.push(`  ${marker} ${identity.name}${draft} — ${identity.title} (${toolCount}, ${skillCount})${error}`)
      }
      lines.push('  * = selected, + = currently applied')
      if (status.identities.some((identity) => identity.draft)) {
        lines.push('  [draft] is an advisory marker; drafts remain selectable.')
      }
    }
    lines.push(`Current: ${status.current ?? 'none'}${status.pending ? ' (next step)' : ''}`)
    if (status.loadError) lines.push(`Load warning: ${status.loadError}`)
    lines.push('Switch with role_gate action=switch name=<identity>, or clear with action=clear.')
    return lines.join('\n')
  }

  async currentText(agent) {
    const status = this.statusFor(agent, { detailed: true })
    const surface = await this.effectiveSurface(agent)
    const effective = surface === null ? null : surface.tools
    const section = surface === null ? null : surface.section
    const lines = [
      `Current identity: ${status.current ?? 'none'}`,
      `Applied identity: ${status.applied ?? 'none'}${status.pending ? ' (change pending for the next step)' : ''}`,
      `Visible tools (registry): ${status.visibleToolCount ?? 0}`,
      `Effective model tools: ${effective === null ? 'unavailable' : effective.length}`,
      `Identity prompt section: ${section ? `${section.length} chars` : 'absent'}`,
      `Draft marker: ${status.currentDraft ? 'yes (advisory; still usable)' : 'no'}`,
      `Skill gate: ${status.skillGate ? 'enabled' : 'disabled'}`,
    ]
    if (effective !== null) lines.push(`  ${effective.join(', ')}`)
    if (status.currentTools.length > 0) {
      lines.push(`Selected tools: ${status.currentTools.includes('*') ? 'all known tools' : status.currentTools.join(', ')}`)
    }
    if (status.currentSkills.length > 0) {
      lines.push(`Selected skills: ${status.currentSkills.includes('*') ? 'all skills' : status.currentSkills.join(', ')}`)
    }
    if (status.pendingMissingTools.length > 0) {
      lines.push(`Not currently registered: ${status.pendingMissingTools.join(', ')}`)
    }
    if (status.loadError) lines.push(`Load warning: ${status.loadError}`)
    return lines.join('\n')
  }

  async clearIdentityFromLiveSessions(name) {
    const affected = []
    for (const state of this.states.values()) {
      if (state.desired !== name && state.applied !== name) continue
      state.desired = null
      state.applied = null
      state.appliedResolved = null
      state.dirty = false
      this.disposeRestriction(state)
      affected.push(state.agent.id)
      try {
        await this.store.setSessionIdentity(state.agent.id, null)
      } catch (error) {
        this.warn(`cannot clear identity for ${state.agent.id}: ${errorMessage(error)}`)
      }
    }
    return affected
  }

  reloadLibrary() {
    this.rebuildLibrary()
    for (const state of this.states.values()) state.dirty = true
  }

  toolsChanged() {
    if (this.suppressChange) return
    for (const state of this.states.values()) {
      if (state.desired !== null) state.dirty = true
    }
  }

  detach(agent) {
    const state = this.states.get(agent.id)
    if (state === undefined) return
    this.states.delete(agent.id)
    this.disposeState(state)
  }

  disposeState(state) {
    for (const key of ['preStepDisposer', 'assembleDisposer', 'guardDisposer', 'sectionDisposer', 'restrictionDisposer']) {
      const disposer = state[key]
      state[key] = null
      if (typeof disposer === 'function') {
        try {
          disposer()
        } catch {
          // Registrations may already be unwound with the agent scope.
        }
      }
    }
  }

  disposeAll() {
    for (const state of this.states.values()) this.disposeState(state)
    this.states.clear()
  }

  /** Exposed for tests and diagnostics. */
  metaTools() {
    return [...META_TOOLS]
  }
}
