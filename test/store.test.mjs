import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RoleGateStore, resolveDshHome } from '../src/store.js'
import { normalizeIdentity } from '../src/identity.js'

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), 'role-gate-test-'))
}

function identity(name) {
  return normalizeIdentity({
    name,
    title: name,
    inherits: [],
    tools: ['read'],
    skills: [],
    instructions: '',
  }, name)
}

test('explicit home wins and empty values fall back', () => {
  const explicit = path.resolve('tmp-role-gate')
  assert.equal(resolveDshHome(explicit), explicit)
  assert.ok(resolveDshHome(undefined).length > 0)
})

test('round-trips identities and per-session state', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    assert.deepEqual(store.identities, {})
    await store.replaceIdentities({ review: identity('review') })
    await store.setSessionIdentity('session-1', 'review')

    const reopened = new RoleGateStore({ home, logger: { warn() {} } })
    await reopened.load()
    assert.equal(reopened.identities.review.name, 'review')
    assert.equal(reopened.getSessionRecord('session-1').identity, 'review')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('quarantines invalid identities JSON and starts empty', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    await writeFile(store.identityPath, '{not json', 'utf8')
    const reopened = new RoleGateStore({ home, logger: { warn() {} } })
    const result = await reopened.load()
    assert.deepEqual(reopened.identities, {})
    assert.match(reopened.loadError, /invalid JSON/i)
    const files = await readdir(reopened.root)
    assert.ok(files.some((name) => name.includes('identities.json.corrupt-')))
    assert.ok(result.errors.length > 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('quarantines invalid state JSON and starts with no sessions', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    await writeFile(store.statePath, '[]', 'utf8')
    const reopened = new RoleGateStore({ home, logger: { warn() {} } })
    await reopened.load()
    assert.deepEqual(reopened.state.sessions, {})
    assert.match(reopened.loadError, /sessions/i)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('prunes the oldest session records above the cap', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, maxStateEntries: 3, logger: { warn() {} } })
    await store.load()
    for (let index = 0; index < 6; index += 1) {
      await store.setSessionIdentity(`session-${index}`, null)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    assert.equal(Object.keys(store.state.sessions).length, 3)
    assert.ok(Object.hasOwn(store.state.sessions, 'session-5'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('serializes concurrent state writes', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.setSessionIdentity(`session-${index}`, null)))
    const reopened = new RoleGateStore({ home, logger: { warn() {} } })
    await reopened.load()
    assert.equal(Object.keys(reopened.state.sessions).length, 8)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('round-trips the pending identity for the next new session', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    await store.setPendingIdentity('review')
    assert.equal(store.getPendingIdentity(), 'review')
    const reopened = new RoleGateStore({ home, logger: { warn() {} } })
    await reopened.load()
    assert.equal(reopened.getPendingIdentity(), 'review')
    assert.equal(await reopened.clearPendingIdentity(), true)
    assert.equal(reopened.getPendingIdentity(), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('clears persisted references to a deleted identity', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    await store.replaceIdentities({ review: identity('review') })
    await store.setSessionIdentity('live-session', 'review')
    await store.setSessionIdentity('persisted-session', 'review')
    const cleared = await store.clearIdentityReferences('review')
    assert.equal(cleared, 2)
    assert.equal(store.getSessionRecord('live-session').identity, null)
    assert.equal(store.getSessionRecord('persisted-session').identity, null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('writes valid JSON with a trailing newline', async () => {
  const home = await tempHome()
  try {
    const store = new RoleGateStore({ home, logger: { warn() {} } })
    await store.load()
    await store.replaceIdentities({ review: identity('review') })
    const text = await readFile(store.identityPath, 'utf8')
    assert.ok(text.endsWith('\n'))
    assert.equal(JSON.parse(text).identities.review.name, 'review')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
