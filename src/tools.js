/**
 * Model-facing RoleGate tools. The schemas are raw JSON Schema (the same shape
 * `defineTool` emits) so the plugin stays free of package imports.
 */

import {
  META_TOOLS,
  RoleGateError,
  isToolAuthorized,
  mergeStringList,
  normalizeIdentity,
  normalizeName,
  normalizeStringList,
  resolveLibrary,
} from './identity.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }]
  },
}

const ROLE_GATE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'current', 'switch', 'clear'],
      description: 'list identities; current status; switch to name; clear the current identity',
    },
    name: {
      type: 'string',
      description: 'Identity name for action=switch.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

const FIND_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Capability to search for, for example "pdf", "browser", or "code review".',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 30,
      description: 'Maximum matches per section. Default 12.',
    },
  },
  required: ['query'],
  additionalProperties: false,
}

const AUTHOR_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['catalog', 'propose', 'create', 'update', 'delete'],
      description: 'catalog: read identities/tools/skills. propose: draft scaffold. create/update/delete: write, requires confirmed=true.',
    },
    name: {
      type: 'string',
      description: 'Identity name. Required for create/update/delete.',
    },
    seed: {
      type: 'string',
      description: 'Optional existing identity to use as the proposal seed.',
    },
    title: { type: 'string', description: 'Short UI title.' },
    description: { type: 'string', description: 'What this identity is for.' },
    inherits: {
      type: 'array',
      items: { type: 'string' },
      description: 'Parent identity names. Capabilities and instructions are inherited and unioned.',
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tool names. Use ["*"] for every tool known to this agent (global + preset-scoped); [] means no tools beyond RoleGate meta tools.',
    },
    addTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Append these tools to the current list instead of replacing it.',
    },
    removeTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Remove these tools from the current list.',
    },
    skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Authorized skill names. Use ["*"] for all; [] blocks every skill load.',
    },
    addSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Append these skills to the current list instead of replacing it.',
    },
    removeSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Remove these skills from the current list.',
    },
    draft: {
      type: 'boolean',
      description: 'Mark this identity with the advisory "unfinished" badge. Drafts remain selectable; the flag does not block switching.',
    },
    instructions: {
      type: 'string',
      description: 'Behavior instructions injected into the system prompt when this identity is applied.',
    },
    allowWebFallback: {
      type: 'boolean',
      description: 'Whether configured web tools are visible for this identity.',
    },
    activate: {
      type: 'boolean',
      description: 'After create/update, select the identity for the calling session.',
    },
    confirmed: {
      type: 'boolean',
      description: 'Must be true for create/update/delete, only after the user explicitly approved the draft.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function requireAgent(exec) {
  if (!exec || !exec.agent) {
    throw new RoleGateError('AGENT_REQUIRED', 'RoleGate tools require a live agent context')
  }
  return exec.agent
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function readString(args, field, options = {}) {
  const value = args[field]
  if (value === undefined || value === null) {
    if (options.required) throw new RoleGateError('INVALID_ARGUMENT', `${field} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new RoleGateError('INVALID_ARGUMENT', `${field} must be a string`)
  const text = value.trim()
  if (text === '' && options.required) throw new RoleGateError('INVALID_ARGUMENT', `${field} must not be empty`)
  if (options.max !== undefined && text.length > options.max) {
    throw new RoleGateError('INVALID_ARGUMENT', `${field} is longer than ${options.max} characters`)
  }
  return text
}

function readBoolean(args, field) {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new RoleGateError('INVALID_ARGUMENT', `${field} must be a boolean`)
  return value
}

function readList(args, field) {
  if (args[field] === undefined || args[field] === null) return undefined
  return normalizeStringList(args[field], field, 400)
}

function truncate(text, limit) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim()
  return single.length <= limit ? single : `${single.slice(0, Math.max(0, limit - 1))}…`
}

function identityScores(description) {
  const query = String(description ?? '').toLowerCase()
  const tokens = query.split(/[\s,，。;；/\\|_\-]+/).filter((token) => token.length >= 2)
  return (name, title, body) => {
    const text = `${name} ${title} ${body}`.toLowerCase()
    let score = 0
    for (const token of tokens) if (text.includes(token)) score += 1
    return score
  }
}

async function skillCatalog(ctx, agent) {
  const skills = agent.ctx?.get?.('skills') ?? ctx.get?.('skills')
  if (!skills || typeof skills.snapshot !== 'function') {
    return { available: false, skills: [], complete: true }
  }
  const workingDirectory = ctx.get?.('workingDirectory')
  let cwd
  try {
    cwd = workingDirectory && typeof workingDirectory.get === 'function'
      ? workingDirectory.get(agent.session)
      : agent.session?.header?.cwd
  } catch {
    cwd = agent.session?.header?.cwd
  }
  try {
    const snapshot = await skills.snapshot({ cwd, scope: agent })
    const entries = Array.isArray(snapshot?.skills) ? snapshot.skills : []
    return {
      available: true,
      skills: entries.filter((skill) => skill?.invocation?.modelInvocable !== false),
      complete: snapshot?.complete !== false,
    }
  } catch (error) {
    return { available: false, skills: [], complete: false, error: errorMessage(error) }
  }
}

function knownToolEntries(ctx, runtime, agent) {
  const globalNames = new Set(ctx.tools.schemas().map((schema) => schema.name))
  return runtime.knownToolsFor(agent)
    .filter((tool) => tool.name !== 'run_code')
    .map((tool) => ({
      ...tool,
      scope: globalNames.has(tool.name) ? 'global' : 'scoped',
    }))
}

function matchScore(query, name, description) {
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  const d = String(description ?? '').toLowerCase()
  const tokens = q.split(/[\s,，。;；/\\|_\-]+/).filter((token) => token.length >= 2)
  let score = 0
  if (n === q) score += 100
  else if (n.startsWith(q)) score += 70
  else if (n.includes(q)) score += 50
  for (const token of tokens) if (n.includes(token)) score += 15
  if (d.includes(q)) score += 25
  for (const token of tokens) if (d.includes(token)) score += 6
  return score
}

function formatMatches(query, limit, tools, skills, resolved, config) {
  const lines = [`Local capability search for "${query}":`]
  lines.push('', 'TOOLS')
  if (tools.length === 0) lines.push('  (no matching tools)')
  else {
    for (const tool of tools.slice(0, limit)) {
      const allowed = isToolAuthorized(resolved, tool.name, config)
      lines.push(`  [${allowed ? 'allowed' : 'blocked'}] ${tool.name} — ${truncate(tool.description, 160)}`)
    }
  }
  lines.push('', 'SKILLS')
  if (skills.length === 0) lines.push('  (no matching skills)')
  else {
    for (const skill of skills.slice(0, limit)) {
      const authorized = resolved === null
        || resolved.skills.includes('*')
        || resolved.skills.includes(skill.name)
      lines.push(`  [${authorized ? 'authorized' : 'blocked   '}] ${skill.name} — ${truncate(skill.description, 160)}`)
    }
  }
  lines.push(
    '',
    'Blocked tools and skills are not callable in the current identity. Switch identity or ask the user to update it before trying them.',
  )
  const webVisible = (config.webTools ?? []).filter((name) => isToolAuthorized(resolved, name, config))
  lines.push(`Web fallback: ${webVisible.length > 0 ? webVisible.join(', ') : 'not authorized in this identity'}.`)
  return lines.join('\n')
}

/**
 * Data shared by the model-facing catalog and the UI editor: every identity,
 * the full known tool catalog, and model-invocable skills.
 * @param {{ctx: any, runtime: any, store: any, agent: any}} options
 * @returns {Promise<object>} catalog payload.
 */
export async function authoringCatalog({ ctx, runtime, store, agent }) {
  const skills = await skillCatalog(ctx, agent)
  const tools = knownToolEntries(ctx, runtime, agent).filter((tool) => !META_TOOLS.includes(tool.name))
  const identities = Object.keys(store.identities).sort().map((name) => {
    const definition = store.identities[name]
    return {
      name,
      title: definition.title,
      description: definition.description,
      inherits: [...definition.inherits],
      tools: [...definition.tools],
      skills: [...definition.skills],
      allowWebFallback: definition.allowWebFallback,
      draft: definition.draft === true,
      instructions: definition.instructions,
      error: runtime.library.errors.get(name)?.message ?? null,
    }
  })
  return {
    identities,
    tools,
    skills: skills.skills,
    skillsAvailable: skills.available,
    skillsError: skills.error ?? null,
  }
}

async function formatCatalog(ctx, runtime, store, agent) {
  const catalog = await authoringCatalog({ ctx, runtime, store, agent })
  const lines = ['RoleGate authoring catalog:', '', 'IDENTITIES']
  if (catalog.identities.length === 0) lines.push('  (none defined)')
  for (const identity of catalog.identities) {
    const toolCount = identity.tools.includes('*') ? 'all tools' : `${identity.tools.length} tools`
    const skillCount = identity.skills.includes('*') ? 'all skills' : `${identity.skills.length} skills`
    const draft = identity.draft ? ' [draft]' : ''
    const error = identity.error ? ` ERROR: ${identity.error}` : ''
    lines.push(`  ${identity.name}${draft} — ${identity.title} (${toolCount}, ${skillCount})${error}`)
  }
  const globalTools = catalog.tools.filter((tool) => tool.scope === 'global')
  const scopedTools = catalog.tools.filter((tool) => tool.scope === 'scoped')
  lines.push('', `GLOBAL TOOL NAMES (${globalTools.length}; descriptions omitted, use role_gate_find_local for detail)`)
  const toolNames = globalTools.map((tool) => tool.name)
  const shownTools = toolNames.slice(0, 500)
  lines.push(`  ${shownTools.join(', ') || '(none)'}`)
  if (toolNames.length > shownTools.length) lines.push(`  … ${toolNames.length - shownTools.length} more`)
  if (scopedTools.length > 0) {
    lines.push('', `PRESET-SCOPED TOOL NAMES (${scopedTools.length}; inherited from the preset, list them to keep them)`)
    lines.push(`  ${scopedTools.slice(0, 200).map((tool) => tool.name).join(', ')}`)
  }
  lines.push('', `SKILLS (${catalog.skills.length})`)
  if (!catalog.skillsAvailable) lines.push('  (skill registry unavailable)')
  else if (catalog.skills.length === 0) lines.push('  (no model-invocable skills)')
  else {
    for (const skill of catalog.skills.slice(0, 200)) {
      lines.push(`  ${skill.name} — ${truncate(skill.description, 120)}`)
    }
    if (catalog.skills.length > 200) lines.push(`  … ${catalog.skills.length - 200} more`)
  }
  lines.push(
    '',
    'Draft rules: tools ["*"] = every tool known to this agent (global + preset-scoped); tools [] = only RoleGate meta tools. skills ["*"] = all skills; skills [] = no skill loads. addTools/addSkills append; removeTools/removeSkills drop. Inherits are unioned.',
    'Draft rules: draft=true only adds an advisory "unfinished" marker; drafts remain selectable and usable.',
    'Next: action=propose description="<task>", fill the scaffold, show it to the user, then action=create confirmed=true.',
  )
  return lines.join('\n')
}

function formatProposal(description, seed, identities) {
  const score = identityScores(description)
  const candidates = identities
    .map((identity) => ({
      name: identity.name,
      score: score(identity.name, identity.title, identity.description),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((candidate) => candidate.name)
  if (seed && identities.some((identity) => identity.name === seed)) {
    candidates.unshift(seed)
  }
  const inherits = [...new Set(candidates)]
  const base = seed !== undefined && seed !== null && seed !== '' ? `${seed}-variant` : 'new-identity'
  const name = base.length <= 40 ? base : base.slice(0, 40).replace(/-+$/g, '')
  const draft = {
    name,
    title: '<short title>',
    description,
    inherits,
    tools: [],
    skills: [],
    instructions: '<behavior instructions for this identity>',
    allowWebFallback: true,
    draft: true,
  }
  return [
    'RoleGate identity scaffold (not a semantic decision):',
    JSON.stringify(draft, null, 2),
    '',
    'Fill tools/skills from the catalog. Use role_gate_find_local for descriptions. Show the complete draft to the user, then call action=create with confirmed=true. draft=true is only an advisory marker: the identity can be used immediately; clear the marker with draft=false when the design is final.',
  ].join('\n')
}

export async function mutateIdentity({ action, args, ctx, runtime, store, config, agent }) {
  if (args.confirmed !== true) {
    return 'RoleGate authoring requires confirmation: show the complete draft to the user, then call again with confirmed=true. Nothing was written.'
  }
  const name = readString(args, 'name', { required: true, max: 40 })
  const identities = Object.fromEntries(
    Object.entries(store.identities).map(([key, value]) => [
      key,
      {
        ...value,
        inherits: [...value.inherits],
        tools: [...value.tools],
        skills: [...value.skills],
      },
    ]),
  )

  if (action === 'delete') {
    if (!Object.hasOwn(identities, name)) {
      throw new RoleGateError('MISSING_IDENTITY', `identity "${name}" does not exist`)
    }
    const children = Object.values(identities)
      .filter((identity) => identity.inherits.includes(name))
      .map((identity) => identity.name)
      .sort()
    if (children.length > 0) {
      throw new RoleGateError(
        'IDENTITY_IN_USE',
        `identity "${name}" is inherited by: ${children.join(', ')}; remove those references first`,
        { children },
      )
    }
    delete identities[name]
  } else if (action === 'create') {
    const normalized = normalizeName(name)
    if (Object.hasOwn(identities, normalized)) {
      throw new RoleGateError('IDENTITY_EXISTS', `identity "${normalized}" already exists; use action=update`)
    }
    identities[normalized] = normalizeIdentity({
      name: normalized,
      title: readString(args, 'title'),
      description: readString(args, 'description'),
      inherits: readList(args, 'inherits') ?? [],
      tools: mergeStringList([], readList(args, 'tools'), readList(args, 'addTools'), readList(args, 'removeTools')),
      skills: mergeStringList([], readList(args, 'skills'), readList(args, 'addSkills'), readList(args, 'removeSkills')),
      instructions: readString(args, 'instructions') ?? '',
      allowWebFallback: readBoolean(args, 'allowWebFallback'),
      draft: readBoolean(args, 'draft') ?? false,
    }, normalized, { maxInstructionsChars: config.maxInstructionsChars })
  } else if (action === 'update') {
    if (!Object.hasOwn(identities, name)) {
      throw new RoleGateError('MISSING_IDENTITY', `identity "${name}" does not exist; use action=create`)
    }
    const current = identities[name]
    const merged = {
      ...current,
      title: readString(args, 'title') ?? current.title,
      description: readString(args, 'description') ?? current.description,
      inherits: readList(args, 'inherits') ?? current.inherits,
      tools: mergeStringList(current.tools, readList(args, 'tools'), readList(args, 'addTools'), readList(args, 'removeTools')),
      skills: mergeStringList(current.skills, readList(args, 'skills'), readList(args, 'addSkills'), readList(args, 'removeSkills')),
      instructions: readString(args, 'instructions') ?? current.instructions,
      allowWebFallback: readBoolean(args, 'allowWebFallback') ?? current.allowWebFallback,
      draft: readBoolean(args, 'draft') ?? current.draft ?? false,
    }
    identities[name] = normalizeIdentity(merged, name, { maxInstructionsChars: config.maxInstructionsChars })
  } else {
    throw new RoleGateError('INVALID_ARGUMENT', `unsupported authoring action "${action}"`)
  }

  const previous = resolveLibrary(store.identities)
  const nextResolved = resolveLibrary(identities)
  if (action !== 'delete') {
    const targetError = nextResolved.errors.get(name)
    if (targetError !== undefined) {
      throw new RoleGateError(targetError.code, targetError.message)
    }
  }
  for (const [key, error] of nextResolved.errors) {
    if (previous.errors.has(key)) continue
    throw new RoleGateError(
      error.code,
      `cannot save this change: identity "${key}" would become invalid: ${error.message}`,
    )
  }

  await store.replaceIdentities(identities)
  runtime.reloadLibrary()

  let affected = []
  let persisted = 0
  if (action === 'delete') {
    affected = await runtime.clearIdentityFromLiveSessions(name)
    try {
      persisted = await store.clearIdentityReferences(name)
    } catch (error) {
      // The live cleanup already happened; a stale persisted record is harmless
      // and will be cleared when that session next resumes.
      runtime.warn(`cannot clear persisted references to "${name}": ${error.message}`)
    }
  }
  let activation = ''
  if (action !== 'delete' && args.activate === true) {
    await runtime.setDesired(agent, name)
    activation = ' It is selected for this session and takes effect from the next step.'
  }
  const lines = [
    `RoleGate: identity "${name}" ${action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted'}.`,
    action !== 'delete' && identities[name]?.draft === true
      ? 'Draft marker set; the identity remains selectable.'
      : '',
    action === 'delete' && affected.length > 0
      ? `Cleared the removed identity from ${affected.length} live session(s).`
      : '',
    action === 'delete' && persisted > 0
      ? `Cleared ${persisted} persisted session record(s).`
      : '',
    activation,
    `Library revision: ${store.revision}.`,
  ].filter((line) => line !== '')
  return lines.join('\n')
}

/**
 * Register the three persistent RoleGate tools on the host tool registry.
 * @param {{ctx: any, runtime: import('./runtime.js').RoleGateRuntime, store: import('./store.js').RoleGateStore, config: object}} options
 */
export function registerTools({ ctx, runtime, store, config }) {
  ctx.tools.register({
    name: 'role_gate',
    description: 'Inspect or switch the current RoleGate identity. Switching changes tools, skill authorization, and the system prompt from the next model step; it adds no conversation message. Use only when the user asks to switch or asks what identity is active.',
    parameters: ROLE_GATE_SCHEMA,
    output: TEXT_OUTPUT,
    async execute(rawArgs, exec) {
      const agent = requireAgent(exec)
      await runtime.ready
      const args = asObject(rawArgs)
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'list') return runtime.listText(agent)
      if (action === 'current') return await runtime.currentText(agent)
      if (action === 'switch') {
        const name = readString(args, 'name', { required: true, max: 40 })
        await runtime.setDesired(agent, name)
        const status = runtime.statusFor(agent, { detailed: true })
        const missing = status.pendingMissingTools
        return `RoleGate: selected identity "${name}". It takes effect from the next step.${missing.length > 0 ? ` Not currently registered: ${missing.join(', ')}.` : ''}`
      }
      if (action === 'clear') {
        await runtime.setDesired(agent, null)
        return 'RoleGate: identity cleared. The next step restores the full tool set.'
      }
      throw new RoleGateError('INVALID_ARGUMENT', 'action must be one of: list, current, switch, clear')
    },
  })

  ctx.tools.register({
    name: 'role_gate_find_local',
    description: 'Search the local tool and skill catalog for capabilities the current RoleGate identity may not expose. Use this before web search when the identity lacks a capability. Results mark each item allowed/blocked by the current identity.',
    parameters: FIND_SCHEMA,
    output: TEXT_OUTPUT,
    async execute(rawArgs, exec) {
      const agent = requireAgent(exec)
      await runtime.ready
      const args = asObject(rawArgs)
      const query = readString(args, 'query', { required: true, max: 200 })
      if (query.length < 2) throw new RoleGateError('INVALID_ARGUMENT', 'query must be at least 2 characters')
      const requestedLimit = args.limit
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(30, Math.max(1, requestedLimit)) : 12
      const tools = knownToolEntries(ctx, runtime, agent)
        .filter((tool) => !META_TOOLS.includes(tool.name))
        .map((tool) => ({ ...tool, score: matchScore(query, tool.name, tool.description) }))
        .filter((tool) => tool.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      const catalog = await skillCatalog(ctx, agent)
      const skills = catalog.skills
        .map((skill) => ({ ...skill, score: matchScore(query, skill.name, skill.description) }))
        .filter((skill) => skill.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      const resolved = runtime.appliedResolvedFor(agent)
      return formatMatches(query, limit, tools, skills, resolved, config)
    },
  })

  ctx.tools.register({
    name: 'role_gate_author',
    description: 'Create, update, delete, or inspect RoleGate identities. Workflow: action=catalog, then action=propose, show the complete draft to the user, then action=create/update/delete with confirmed=true. Never write without explicit user approval.',
    parameters: AUTHOR_SCHEMA,
    output: TEXT_OUTPUT,
    async execute(rawArgs, exec) {
      const agent = requireAgent(exec)
      await runtime.ready
      const args = asObject(rawArgs)
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'catalog') {
        return formatCatalog(ctx, runtime, store, agent)
      }
      if (action === 'propose') {
        const description = readString(args, 'description', { required: true, max: 2000 })
        const seed = readString(args, 'seed', { max: 40 })
        const identities = Object.values(store.identities).map((identity) => ({
          name: identity.name,
          title: identity.title,
          description: identity.description,
        }))
        return formatProposal(description, seed, identities)
      }
      if (action === 'create' || action === 'update' || action === 'delete') {
        return mutateIdentity({ action, args, ctx, runtime, store, config, agent })
      }
      throw new RoleGateError('INVALID_ARGUMENT', 'action must be one of: catalog, propose, create, update, delete')
    },
  })
}
