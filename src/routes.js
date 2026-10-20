/**
 * Same-origin HTTP bridge for the RoleGate client pill. The browser polls
 * `/role-gate/state` and posts `/role-gate/switch`; the host applies the same
 * `setDesired` path used by the model tool and `/identity`. No typert codegen.
 */

import { RoleGateError } from './identity.js'
import { authoringCatalog, mutateIdentity } from './tools.js'

const MAX_BODY_BYTES = 64 * 1024

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sameOrigin(req) {
  try {
    const origin = req.headers?.origin || req.headers?.referer
    if (!origin) return true
    if (origin === 'null') return false
    const host = req.headers?.host
    if (!host) return false
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function isJson(req) {
  const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
  return type === 'application/json' || type.startsWith('application/json;')
}

async function readBody(req) {
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new Error('request body is too large')
    error.statusCode = 413
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected a JSON object')
    }
    return value
  } catch (error) {
    const invalid = new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`)
    invalid.statusCode = 400
    throw invalid
  }
}

function fail(res, error) {
  if (error instanceof RoleGateError) {
    sendJson(res, 400, { ok: false, code: error.code, error: error.message })
    return
  }
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
  sendJson(res, status, { ok: false, code: status === 500 ? 'INTERNAL' : 'BAD_REQUEST', error: error instanceof Error ? error.message : String(error) })
}

function sessionIdOf(ctx, value) {
  if (typeof value !== 'string' || value === '') throw new RoleGateError('INVALID_ARGUMENT', 'sessionId is required')
  const agent = ctx.agents.get(value)
  if (!agent) throw new RoleGateError('SESSION_UNAVAILABLE', `session "${value}" is not live`)
  return { sessionId: value, agent }
}

export function registerRoutes({ ctx, runtime, store, config }) {
  const disposers = []
  const server = ctx.webServer
  if (!server) return () => {}

  disposers.push(server.register({
    kind: 'exact',
    path: '/role-gate/state',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET required' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'cross-origin request refused' })
          return
        }
        const url = new URL(req.url ?? '/role-gate/state', 'http://localhost')
        const { agent } = sessionIdOf(ctx, url.searchParams.get('sessionId'))
        await runtime.ready
        sendJson(res, 200, { ok: true, state: runtime.statusFor(agent) })
      } catch (error) {
        fail(res, error)
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: '/role-gate/switch',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'POST required' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'cross-origin request refused' })
          return
        }
        if (!isJson(req)) {
          sendJson(res, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'application/json required' })
          return
        }
        const body = await readBody(req)
        const { agent } = sessionIdOf(ctx, body.sessionId)
        const name = body.name === null || body.name === undefined ? null : body.name
        if (name !== null && typeof name !== 'string') {
          throw new RoleGateError('INVALID_ARGUMENT', 'name must be a string or null')
        }
        await runtime.ready
        await runtime.setDesired(agent, name)
        sendJson(res, 200, { ok: true, state: runtime.statusFor(agent) })
      } catch (error) {
        fail(res, error)
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: '/role-gate/author/catalog',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET required' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'cross-origin request refused' })
          return
        }
        const url = new URL(req.url ?? '/role-gate/author/catalog', 'http://localhost')
        const { agent } = sessionIdOf(ctx, url.searchParams.get('sessionId'))
        await runtime.ready
        const catalog = await authoringCatalog({ ctx, runtime, store, agent })
        sendJson(res, 200, { ok: true, catalog })
      } catch (error) {
        fail(res, error)
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: '/role-gate/author/save',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'POST required' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'cross-origin request refused' })
          return
        }
        if (!isJson(req)) {
          sendJson(res, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'application/json required' })
          return
        }
        const body = await readBody(req)
        const { agent } = sessionIdOf(ctx, body.sessionId)
        const mode = body.mode === 'update' ? 'update' : body.mode === 'create' ? 'create' : null
        if (mode === null) throw new RoleGateError('INVALID_ARGUMENT', 'mode must be "create" or "update"')
        const identity = body.identity && typeof body.identity === 'object' && !Array.isArray(body.identity)
          ? body.identity
          : {}
        const args = {
          ...identity,
          name: typeof identity.name === 'string' && identity.name !== '' ? identity.name : body.name,
          confirmed: true,
        }
        await runtime.ready
        const text = await mutateIdentity({
          action: mode,
          args,
          ctx,
          runtime,
          store,
          config,
          agent,
        })
        const catalog = await authoringCatalog({ ctx, runtime, store, agent })
        sendJson(res, 200, { ok: true, text, state: runtime.statusFor(agent), catalog })
      } catch (error) {
        fail(res, error)
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: '/role-gate/identities',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET required' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'cross-origin request refused' })
          return
        }
        await runtime.ready
        sendJson(res, 200, {
          ok: true,
          identities: runtime.identitySummaries(),
          pending: store.getPendingIdentity() ?? null,
          loadError: store.loadError,
          revision: store.revision,
        })
      } catch (error) {
        fail(res, error)
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: '/role-gate/pending',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'POST required' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'cross-origin request refused' })
          return
        }
        if (!isJson(req)) {
          sendJson(res, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'application/json required' })
          return
        }
        const body = await readBody(req)
        await runtime.ready
        if (body.identity === null || body.identity === undefined) {
          await store.clearPendingIdentity()
          sendJson(res, 200, { ok: true, pending: null })
          return
        }
        if (typeof body.identity !== 'string' || body.identity.trim() === '') {
          throw new RoleGateError('INVALID_ARGUMENT', 'identity must be a non-empty string or null')
        }
        const name = body.identity.trim()
        if (!runtime.identityUsable(name)) {
          throw new RoleGateError('MISSING_IDENTITY', `identity "${name}" is unavailable`)
        }
        await store.setPendingIdentity(name)
        sendJson(res, 200, { ok: true, pending: name })
      } catch (error) {
        fail(res, error)
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // The route may already be gone with the web server.
      }
    }
  }
}
