/**
 * Pure RoleGate identity model: validation, multi-parent resolution, capability
 * allow-list computation, and prompt rendering. No filesystem or Cordis access,
 * so every rule here is unit-testable in isolation.
 */

export const META_TOOLS = Object.freeze([
  'role_gate',
  'role_gate_find_local',
  'role_gate_author',
])

export const RESERVED_NAMES = Object.freeze(['none', '*'])

const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/
const DEFAULT_MAX_INSTRUCTIONS = 16_000
const DEFAULT_MAX_RESOLVED_INSTRUCTIONS = 32_000

/** A validation or resolution failure with a stable machine-readable code. */
export class RoleGateError extends Error {
  /**
   * @param {string} code stable lower-kebab code.
   * @param {string} message human-readable explanation.
   * @param {object} [details] optional structured details.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RoleGateError'
    this.code = code
    Object.assign(this, details)
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one identity name.
 * @param {unknown} value candidate.
 * @returns {string} trimmed name.
 */
export function normalizeName(value) {
  if (typeof value !== 'string') {
    throw new RoleGateError('INVALID_NAME', 'identity name must be a string')
  }
  const name = value.trim()
  if (!NAME_RE.test(name)) {
    throw new RoleGateError(
      'INVALID_NAME',
      `invalid identity name "${name}": use 2-40 lowercase letters, digits, or hyphens, starting with a letter`,
    )
  }
  if (RESERVED_NAMES.includes(name)) {
    throw new RoleGateError('RESERVED_NAME', `identity name "${name}" is reserved`)
  }
  return name
}

/**
 * Normalize a string array: strings only, trimmed, empty removed, deduplicated
 * in first-seen order.
 * @param {unknown} value raw value.
 * @param {string} field field name for the error message.
 * @param {number} maxItems maximum accepted entries.
 * @returns {string[]} normalized entries.
 */
export function normalizeStringList(value, field, maxItems = 400) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new RoleGateError('INVALID_FIELD', `${field} must be an array of strings`)
  }
  const seen = new Set()
  const result = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new RoleGateError('INVALID_FIELD', `${field} must contain only strings`)
    }
    const text = entry.trim()
    if (text === '') continue
    if (text.length > 200) {
      throw new RoleGateError('INVALID_FIELD', `${field} entry is longer than 200 characters`)
    }
    if (seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  if (result.length > maxItems) {
    throw new RoleGateError('INVALID_FIELD', `${field} accepts at most ${maxItems} entries`)
  }
  // A wildcard dominates every explicit entry; normalize it to the compact form.
  if (result.includes('*')) return ['*']
  return result
}

/**
 * Normalize one identity definition, filling optional fields and enforcing
 * limits. The returned object is frozen.
 * @param {unknown} raw raw definition.
 * @param {string} [keyName] map key the definition came from.
 * @param {{maxInstructionsChars?: number}} [options] limits.
 * @returns {Readonly<object>} normalized identity.
 */
export function normalizeIdentity(raw, keyName, options = {}) {
  if (!isRecord(raw)) {
    throw new RoleGateError('INVALID_IDENTITY', 'identity definition must be an object')
  }
  const name = normalizeName(raw.name ?? keyName)
  if (keyName !== undefined && name !== keyName) {
    throw new RoleGateError(
      'NAME_MISMATCH',
      `identity key "${keyName}" does not match its name field "${name}"`,
    )
  }
  const title = typeof raw.title === 'string' && raw.title.trim() !== ''
    ? raw.title.trim().slice(0, 120)
    : name
  const description = typeof raw.description === 'string'
    ? raw.description.trim().slice(0, 500)
    : ''
  const inherits = normalizeStringList(raw.inherits, 'inherits', 64).map((parent) => {
    const normalized = normalizeName(parent)
    if (normalized === name) {
      throw new RoleGateError('INVALID_IDENTITY', `identity "${name}" cannot inherit itself`)
    }
    return normalized
  })
  const tools = normalizeStringList(raw.tools, 'tools', 400)
  const skills = normalizeStringList(raw.skills, 'skills', 400)
  if (typeof raw.instructions !== 'undefined' && typeof raw.instructions !== 'string') {
    throw new RoleGateError('INVALID_FIELD', 'instructions must be a string')
  }
  const instructions = typeof raw.instructions === 'string' ? raw.instructions : ''
  const maxInstructions = options.maxInstructionsChars ?? DEFAULT_MAX_INSTRUCTIONS
  if (instructions.length > maxInstructions) {
    throw new RoleGateError(
      'INSTRUCTIONS_TOO_LONG',
      `identity "${name}" instructions exceed ${maxInstructions} characters`,
    )
  }
  if (typeof raw.allowWebFallback !== 'undefined' && typeof raw.allowWebFallback !== 'boolean') {
    throw new RoleGateError('INVALID_FIELD', 'allowWebFallback must be a boolean')
  }
  if (typeof raw.draft !== 'undefined' && typeof raw.draft !== 'boolean') {
    throw new RoleGateError('INVALID_FIELD', 'draft must be a boolean')
  }
  return Object.freeze({
    name,
    title,
    description,
    inherits: Object.freeze(inherits),
    tools: Object.freeze(tools),
    skills: Object.freeze(skills),
    instructions,
    allowWebFallback: typeof raw.allowWebFallback === 'boolean' ? raw.allowWebFallback : undefined,
    draft: raw.draft === true,
  })
}

/**
 * Merge one identity list with replacement, additions, and removals. The
 * replacement (when supplied) replaces the base, then additions are appended
 * and removals are filtered out.
 * @param {string[]} base current list.
 * @param {string[]|undefined} replacement full replacement list, when provided.
 * @param {string[]|undefined} add entries to append.
 * @param {string[]|undefined} remove entries to drop.
 * @returns {string[]} merged list.
 */
export function mergeStringList(base, replacement, add, remove) {
  const list = replacement !== undefined ? [...replacement] : [...(base ?? [])]
  if (add !== undefined) {
    for (const entry of add) if (!list.includes(entry)) list.push(entry)
  }
  if (remove !== undefined) {
    const dropped = new Set(remove)
    return list.filter((entry) => !dropped.has(entry))
  }
  return list
}

/**
 * Resolve one identity against the library: union tools/skills, ancestor-first
 * instructions with each identity emitted once, and nearest-wins web fallback.
 * @param {string} name identity name.
 * @param {Record<string, Readonly<object>>} definitions normalized library.
 * @returns {{resolved: Readonly<object>|undefined, errors: Map<string, object>}}
 */
export function resolveLibrary(definitions) {
  const resolved = new Map()
  const errors = new Map()
  const names = Object.keys(definitions).sort()
  for (const name of names) {
    try {
      resolved.set(name, resolveOne(name, definitions, resolved, []))
    } catch (error) {
      errors.set(name, {
        code: error instanceof RoleGateError ? error.code : 'RESOLVE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { resolved, errors }
}

function resolveOne(name, definitions, memo, stack) {
  const cached = memo.get(name)
  if (cached !== undefined) return cached
  if (stack.includes(name)) {
    throw new RoleGateError(
      'CYCLE',
      `cyclic inheritance: ${[...stack, name].join(' -> ')}`,
    )
  }
  const definition = definitions[name]
  if (definition === undefined) {
    throw new RoleGateError('MISSING_IDENTITY', `identity "${name}" does not exist`)
  }
  stack.push(name)
  try {
    const tools = new Set()
    const skills = new Set()
    const instructions = []
    const seenSources = new Set()
    let allowWebFallback

    for (const parentName of definition.inherits) {
      let parent
      try {
        parent = resolveOne(parentName, definitions, memo, stack)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new RoleGateError(
          error instanceof RoleGateError ? error.code : 'PARENT_INVALID',
          `identity "${name}" cannot inherit "${parentName}": ${reason}`,
        )
      }
      for (const tool of parent.tools) tools.add(tool)
      for (const skill of parent.skills) skills.add(skill)
      if (allowWebFallback === undefined && typeof parent.allowWebFallback === 'boolean') {
        allowWebFallback = parent.allowWebFallback
      }
      for (const segment of parent.instructions) {
        if (seenSources.has(segment.source)) continue
        seenSources.add(segment.source)
        instructions.push(segment)
      }
    }

    for (const tool of definition.tools) tools.add(tool)
    for (const skill of definition.skills) skills.add(skill)
    if (typeof definition.allowWebFallback === 'boolean') {
      allowWebFallback = definition.allowWebFallback
    }
    if (!seenSources.has(name)) {
      seenSources.add(name)
      instructions.push({ source: name, text: definition.instructions })
    }

    const result = Object.freeze({
      name,
      title: definition.title,
      description: definition.description,
      inherits: definition.inherits,
      tools: Object.freeze([...tools]),
      skills: Object.freeze([...skills]),
      instructions: Object.freeze(instructions),
      allowWebFallback,
      draft: definition.draft === true,
    })
    memo.set(name, result)
    return result
  } finally {
    stack.pop()
  }
}

/**
 * Expand a resolved identity into the exact `allow` list passed to
 * `agent.ctx.tools.restrict()`. `null` means "no restriction at all".
 * @param {Readonly<object>|null|undefined} resolved resolved identity.
 * @param {Iterable<string>} knownToolNames every inherited/visible tool name.
 * @param {{webTools?: string[], allowWebFallbackByDefault?: boolean}} config plugin config.
 * @returns {string[]|null} sorted allow list or null.
 */
export function computeAllow(resolved, globalToolNames, config = {}) {
  if (resolved === null || resolved === undefined) return null
  const globals = new Set(globalToolNames)
  globals.delete('run_code')
  const allowed = new Set(META_TOOLS)
  if (resolved.tools.includes('*')) {
    for (const name of globals) allowed.add(name)
  } else {
    for (const name of resolved.tools) {
      if (globals.has(name)) allowed.add(name)
    }
  }
  const webEnabled = typeof resolved.allowWebFallback === 'boolean'
    ? resolved.allowWebFallback
    : config.allowWebFallbackByDefault !== false
  if (webEnabled) {
    for (const name of config.webTools ?? []) {
      if (globals.has(name)) allowed.add(name)
    }
  }
  if (resolved.skills.length > 0 && globals.has('skill')) allowed.add('skill')
  return [...allowed].sort()
}

/**
 * Decide whether the current identity authorizes one tool name. This predicate
 * is shared by the prompt-tool filter, the execution guard, and the local
 * catalog. It covers preset-scoped tools that `restrict` cannot mask.
 * @param {Readonly<object>|null|undefined} resolved resolved identity.
 * @param {string} toolName model-facing tool name.
 * @param {{webTools?: string[], allowWebFallbackByDefault?: boolean}} config plugin config.
 * @returns {boolean} whether the identity authorizes the tool.
 */
export function isToolAuthorized(resolved, toolName, config = {}) {
  if (resolved === null || resolved === undefined) return true
  if (toolName === 'run_code') return true
  if (META_TOOLS.includes(toolName)) return true
  if (resolved.tools.includes('*')) return true
  if (resolved.tools.includes(toolName)) return true
  const webEnabled = typeof resolved.allowWebFallback === 'boolean'
    ? resolved.allowWebFallback
    : config.allowWebFallbackByDefault !== false
  if (webEnabled && (config.webTools ?? []).includes(toolName)) return true
  if (resolved.skills.length > 0 && toolName === 'skill') return true
  return false
}

/**
 * Render the system-prompt section for one applied identity.
 * @param {Readonly<object>|null|undefined} resolved resolved identity.
 * @param {{maxResolvedInstructionsChars?: number}} config plugin config.
 * @returns {string} prompt text, or an empty string without an identity.
 */
export function renderIdentitySection(resolved, config = {}) {
  if (resolved === null || resolved === undefined) return ''
  const toolSummary = resolved.tools.includes('*') ? 'all known tools' : String(resolved.tools.length)
  const skillSummary = resolved.skills.includes('*')
    ? 'all skills'
    : resolved.skills.length === 0
      ? 'none'
      : resolved.skills.join(', ')
  const webEnabled = typeof resolved.allowWebFallback === 'boolean'
    ? resolved.allowWebFallback
    : config.allowWebFallbackByDefault !== false
  const blocks = resolved.instructions
    .filter((segment) => segment.text.trim() !== '')
    .map((segment) => `[role-gate:${segment.source}]\n${segment.text.trim()}`)
  let instructionText = blocks.join('\n\n')
  const limit = config.maxResolvedInstructionsChars ?? DEFAULT_MAX_RESOLVED_INSTRUCTIONS
  if (instructionText.length > limit) {
    instructionText = `${instructionText.slice(0, limit)}\n\n[role-gate: instructions truncated]`
  }
  const lines = [
    `## RoleGate identity: ${resolved.name}`,
    '',
    `You are currently operating as the "${resolved.name}" identity. Its capability set is authoritative for this step.`,
    '',
    'Capability priority:',
    '1. Use the tools and skills available to this identity first.',
    '2. If they are insufficient, call `role_gate_find_local` to search the local tool and skill catalog.',
    '3. Only if the local catalog has no suitable capability and a web tool is visible, use web search or fetch.',
    '4. Do not claim to be a different identity; identity changes are runtime state, not conversation content.',
    'These instructions shape your defaults but never override the user\'s explicit current request.',
    '',
    `Identity tools: ${toolSummary}.`,
    `Authorized skills: ${skillSummary}.`,
    `Web fallback: ${webEnabled ? 'enabled' : 'disabled'}.`,
  ]
  if (instructionText !== '') {
    lines.push('', '### Identity instructions', instructionText)
  }
  return lines.join('\n')
}

/**
 * Decide whether the current identity allows loading one skill.
 * @param {Readonly<object>|null|undefined} resolved resolved identity.
 * @param {unknown} skillName requested skill name.
 * @param {{enforceSkills?: boolean}} config plugin config.
 * @returns {string|undefined} denial reason, or undefined to allow.
 */
export function skillGateReason(resolved, skillName, config = {}) {
  if (config.enforceSkills === false) return undefined
  if (resolved === null || resolved === undefined) return undefined
  if (typeof skillName !== 'string' || skillName === '') return undefined
  if (resolved.skills.includes('*')) return undefined
  if (resolved.skills.length === 0) {
    return `RoleGate: identity "${resolved.name}" authorizes no skills. Ask the user to add a skill to this identity, or switch identity with role_gate.`
  }
  if (resolved.skills.includes(skillName)) return undefined
  return `RoleGate: skill "${skillName}" is not authorized by identity "${resolved.name}". Authorized skills: ${resolved.skills.join(', ')}. Use role_gate_find_local to inspect local capabilities, or ask the user to update the identity.`
}

/**
 * Build the compact description the UI and catalog tools consume. Instructions
 * stay out of this projection.
 * @param {Readonly<object>} resolved resolved identity.
 * @returns {object} summary.
 */
export function summarizeIdentity(resolved) {
  return {
    name: resolved.name,
    title: resolved.title,
    description: resolved.description,
    inherits: [...resolved.inherits],
    toolCount: resolved.tools.includes('*') ? 'all' : resolved.tools.length,
    skillCount: resolved.skills.includes('*') ? 'all' : resolved.skills.length,
    tools: [...resolved.tools],
    skills: [...resolved.skills],
    allowWebFallback: resolved.allowWebFallback,
    draft: resolved.draft === true,
  }
}
