/**
 * RoleGate host entry: load the identity library, attach the per-agent runtime,
 * register the persistent meta tools and `/identity`, and expose the small
 * same-origin HTTP bridge used by the composer dock pill.
 */

import { normalizeName } from './src/identity.js'
import { RoleGateRuntime } from './src/runtime.js'
import { RoleGateStore } from './src/store.js'
import { registerRoutes } from './src/routes.js'
import { registerTools } from './src/tools.js'

export const name = 'dsh-role-gate'
export const inject = ['tools', 'systemPrompt', 'agents', 'commands']

const DEFAULT_WEB_TOOLS = ['web_search', 'web_fetch']

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice()
  const seen = new Set()
  const result = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

/**
 * Normalize the Loader config. Invalid values fall back to defaults instead of
 * failing activation, so a typo cannot lock a session out of its tools.
 * @param {unknown} raw row config.
 * @returns {Readonly<object>} effective config.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  let defaultIdentity = null
  if (typeof source.defaultIdentity === 'string' && source.defaultIdentity.trim() !== '') {
    try {
      defaultIdentity = normalizeName(source.defaultIdentity)
    } catch {
      defaultIdentity = null
    }
  }
  return Object.freeze({
    home: typeof source.home === 'string' && source.home.trim() !== '' ? source.home.trim() : undefined,
    defaultIdentity,
    webTools: stringList(source.webTools, DEFAULT_WEB_TOOLS),
    allowWebFallbackByDefault: source.allowWebFallbackByDefault !== false,
    enforceSkills: source.enforceSkills !== false,
    sectionOrder: Number.isFinite(source.sectionOrder) ? source.sectionOrder : 450,
    maxInstructionsChars: positiveInteger(source.maxInstructionsChars, 16_000),
    maxResolvedInstructionsChars: positiveInteger(source.maxResolvedInstructionsChars, 32_000),
    maxStateEntries: positiveInteger(source.maxStateEntries, 500),
  })
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger
  const store = new RoleGateStore({
    home: config.home,
    maxStateEntries: config.maxStateEntries,
    maxInstructionsChars: config.maxInstructionsChars,
    logger,
  })
  const runtime = new RoleGateRuntime({ ctx, store, config, logger })

  ctx.effect(() => () => runtime.disposeAll(), 'role-gate: runtime')

  registerTools({ ctx, runtime, store, config })

  ctx.on('agent/created', async (payload) => {
    try {
      await runtime.ready
      await runtime.attach(payload.agent)
    } catch (error) {
      try {
        logger?.warn?.(`dsh-role-gate: cannot attach agent ${payload?.agent?.id}: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // Keep agent creation alive.
      }
    }
  })

  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent) runtime.detach(payload.agent)
  })

  ctx.on('tools/change', () => {
    runtime.toolsChanged()
  })

  try {
    ctx.commands.register({
      name: 'identity',
      description: 'List or switch the RoleGate identity for this session',
      input: { hint: '<name>|list|none' },
      handler: async ({ agent, rawInput }) => {
        await runtime.ready
        const input = typeof rawInput === 'string' ? rawInput.trim() : ''
        if (input === '' || input === 'list') {
          return { kind: 'success', text: runtime.listText(agent) }
        }
        if (input === 'none' || input === 'clear') {
          await runtime.setDesired(agent, null)
          return { kind: 'success', text: 'RoleGate: identity cleared. The next step restores the full tool set.' }
        }
        try {
          await runtime.setDesired(agent, input)
          return { kind: 'success', text: `RoleGate: selected identity "${input}". It takes effect from the next step.` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  } catch (error) {
    try {
      logger?.warn?.(`dsh-role-gate: cannot register /identity: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // Duplicate registration is non-fatal.
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => registerRoutes({ ctx: webCtx, runtime, store, config }),
      'role-gate: routes',
    )
  })
}
