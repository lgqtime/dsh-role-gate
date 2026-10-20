import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RoleGateRuntime } from '../src/runtime.js'
import { RoleGateStore } from '../src/store.js'
import { normalizeIdentity } from '../src/identity.js'

const GLOBAL_SCHEMAS = [
  { name: 'role_gate', description: '' },
  { name: 'role_gate_find_local', description: '' },
  { name: 'role_gate_author', description: '' },
  { name: 'read', description: 'Read a file' },
  { name: 'write', description: 'Write a file' },
  { name: 'web_search', description: 'Search the web' },
  { name: 'web_fetch', description: 'Fetch a URL' },
  { name: 'skill', description: 'Load a skill' },
]

function makeAgent(id, header = {}) {
  const calls = {
    restrict: [],
    restrictDisposers: [],
    guard: null,
    section: null,
    preStep: null,
    assemble: null,
    disposed: [],
  }
  const agent = {
    id,
    session: { header },
    ctx: {
      systemPrompt: {
        section(options) {
          calls.section = options
          return () => calls.disposed.push('section')
        },
      },
      tools: {
        guard(fn) {
          calls.guard = fn
          return () => calls.disposed.push('guard')
        },
        restrict(filter) {
          calls.restrict.push(filter)
          return () => {
            calls.disposed.push('restrict')
            calls.restrictDisposers.push(filter)
          }
        },
      },
      on(name, fn) {
        if (name === 'agent/pre-step') calls.preStep = fn
        if (name === 'system-prompt/assemble') calls.assemble = fn
        return () => calls.disposed.push(name)
      },
      get() {
        return undefined
      },
    },
  }
  return { agent, calls }
}

function makeCtx(agents = []) {
  return {
    agents: { list: () => agents },
    tools: {
      schemas(scope) {
        void scope
        return GLOBAL_SCHEMAS
      },
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
}

async function promote(calls) {
  assert.equal(typeof calls.preStep, 'function')
  const value = await calls.preStep({}, () => Promise.resolve('next'))
  assert.equal(value, 'next')
}

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'role-gate-runtime-'))
  const store = new RoleGateStore({ home, logger: { warn() {} } })
  await store.load()
  await store.replaceIdentities({
    review: normalizeIdentity({
      name: 'review',
      title: 'Reviewer',
      inherits: [],
      tools: ['read'],
      skills: ['tdd'],
      instructions: 'review carefully',
    }, 'review'),
    drafty: normalizeIdentity({
      name: 'drafty',
      title: 'Draft',
      inherits: [],
      tools: ['read'],
      skills: [],
      instructions: '',
      draft: true,
    }, 'drafty'),
  })
  const ctx = makeCtx()
  const runtime = new RoleGateRuntime({
    ctx,
    store,
    config: {
      defaultIdentity: null,
      webTools: ['web_search', 'web_fetch'],
      allowWebFallbackByDefault: true,
      enforceSkills: true,
      sectionOrder: 450,
      maxInstructionsChars: 16_000,
      maxResolvedInstructionsChars: 32_000,
      maxStateEntries: 500,
    },
    logger: { warn() {} },
  })
  await runtime.ready
  return { home, store, ctx, runtime }
}

test('applies the identity mask, prompt section, and skill gate on the next step', async () => {
  const { home, store, runtime } = await setup()
  try {
    const { agent, calls } = makeAgent('session-review')
    await runtime.attach(agent)
    assert.equal(calls.section.text(), '')
    assert.equal(calls.restrict.length, 0, 'no identity means no restriction')
    assert.equal(runtime.statusFor(agent).current, null)
    assert.equal(runtime.statusFor(agent).pending, false)

    await runtime.setDesired(agent, 'review')
    assert.equal(runtime.statusFor(agent).pending, true)
    assert.equal(calls.restrict.length, 0, 'switch must not change tools mid-step')

    await promote(calls)
    assert.equal(calls.restrict.length, 1)
    const allow = calls.restrict[0].allow
    assert.ok(allow.includes('read'))
    assert.ok(allow.includes('skill'))
    assert.ok(allow.includes('web_search'))
    assert.ok(!allow.includes('write'))
    assert.match(calls.section.text(), /RoleGate identity: review/)
    assert.equal(calls.guard({ name: 'skill', arguments: { name: 'tdd' } }), undefined)
    assert.match(calls.guard({ name: 'skill', arguments: { name: 'write-docs' } }), /not authorized/)
    assert.equal(calls.guard({ name: 'read', arguments: {} }), undefined)
    assert.match(calls.guard({ name: 'write', arguments: {} }), /not authorized/)

    const assembled = await calls.assemble({}, {}, async () => ({
      sections: [],
      contexts: [],
      variables: {},
      tools: [
        { name: 'role_gate' },
        { name: 'read' },
        { name: 'write' },
        { name: 'web_search' },
        { name: 'preset_secret_tool' },
      ],
    }))
    assert.deepEqual(assembled.tools.map((tool) => tool.name), ['role_gate', 'read', 'web_search'])

    assert.equal(store.getSessionRecord('session-review').identity, 'review')

    await runtime.setDesired(agent, null)
    await promote(calls)
    assert.equal(store.getSessionRecord('session-review').identity, null)
    assert.equal(calls.section.text(), '')
  } finally {
    runtime.disposeAll()
    await rm(home, { recursive: true, force: true })
  }
})

test('draft identities remain selectable and keep the advisory marker', async () => {
  const { home, runtime } = await setup()
  try {
    const { agent, calls } = makeAgent('session-draft')
    await runtime.attach(agent)
    await runtime.setDesired(agent, 'drafty')
    await promote(calls)
    const status = runtime.statusFor(agent)
    assert.equal(status.current, 'drafty')
    assert.equal(status.applied, 'drafty')
    assert.equal(status.currentDraft, true)
    assert.equal(status.appliedDraft, true)
    assert.equal(status.pending, false)
    assert.match(calls.section.text(), /RoleGate identity: drafty/)
    assert.ok(calls.restrict[0].allow.includes('read'))
  } finally {
    runtime.disposeAll()
    await rm(home, { recursive: true, force: true })
  }
})

test('a pending identity is applied to the next new session and then cleared', async () => {
  const { home, store, runtime } = await setup()
  try {
    await store.setPendingIdentity('review')
    const { agent } = makeAgent('session-new')
    await runtime.attach(agent)
    assert.equal(runtime.statusFor(agent).current, 'review')
    assert.equal(runtime.statusFor(agent).applied, 'review')
    assert.equal(store.getSessionRecord('session-new').identity, 'review')
    assert.equal(store.getPendingIdentity(), undefined)
  } finally {
    runtime.disposeAll()
    await rm(home, { recursive: true, force: true })
  }
})

test('subagent inherits the parent desired identity', async () => {
  const { home, runtime } = await setup()
  try {
    const parent = makeAgent('session-parent')
    await runtime.attach(parent.agent)
    await runtime.setDesired(parent.agent, 'review')
    await promote(parent.calls)

    const child = makeAgent('session-child', { parentSession: 'session-parent', origin: 'subagent' })
    await runtime.attach(child.agent)
    assert.equal(runtime.statusFor(child.agent).current, 'review')
    assert.equal(runtime.statusFor(child.agent).applied, 'review')
    const allow = child.calls.restrict[0].allow
    assert.ok(allow.includes('read'))
    assert.ok(!allow.includes('write'))
  } finally {
    runtime.disposeAll()
    await rm(home, { recursive: true, force: true })
  }
})

test('restart restores the per-session identity from state.json', async () => {
  const { home, runtime } = await setup()
  try {
    const { agent } = makeAgent('session-persist')
    await runtime.attach(agent)
    await runtime.setDesired(agent, 'review')
    runtime.disposeAll()

    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    const reopened = new RoleGateRuntime({
      ctx: makeCtx(),
      store,
      config: {
        defaultIdentity: null,
        webTools: ['web_search', 'web_fetch'],
        allowWebFallbackByDefault: true,
        enforceSkills: true,
        sectionOrder: 450,
        maxInstructionsChars: 16_000,
        maxResolvedInstructionsChars: 32_000,
        maxStateEntries: 500,
      },
      logger: { warn() {} },
    })
    await reopened.ready
    const next = makeAgent('session-persist')
    await reopened.attach(next.agent)
    assert.equal(reopened.statusFor(next.agent).current, 'review')
    reopened.disposeAll()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
