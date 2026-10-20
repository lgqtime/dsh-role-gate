import test from 'node:test'
import assert from 'node:assert/strict'
import {
  META_TOOLS,
  RoleGateError,
  computeAllow,
  isToolAuthorized,
  mergeStringList,
  normalizeIdentity,
  normalizeName,
  renderIdentitySection,
  resolveLibrary,
  skillGateReason,
  summarizeIdentity,
} from '../src/identity.js'

function identity(name, overrides = {}) {
  return normalizeIdentity({
    name,
    title: overrides.title ?? name,
    description: overrides.description ?? '',
    inherits: overrides.inherits ?? [],
    tools: overrides.tools ?? [],
    skills: overrides.skills ?? [],
    instructions: overrides.instructions ?? '',
    allowWebFallback: overrides.allowWebFallback,
    draft: overrides.draft,
  }, name)
}

function library(definitions) {
  return resolveLibrary(Object.fromEntries(definitions.map((definition) => [definition.name, definition])))
}

test('normalizes names and rejects reserved or invalid names', () => {
  assert.equal(normalizeName('code-review'), 'code-review')
  assert.throws(() => normalizeName('Code Review'), RoleGateError)
  assert.throws(() => normalizeName('none'), RoleGateError)
  assert.throws(() => normalizeName('*'), RoleGateError)
  assert.throws(() => normalizeName('a'), RoleGateError)
})

test('unions tools and skills across a diamond without duplicating instructions', () => {
  const base = identity('base', { tools: ['read'], skills: ['translate'], instructions: 'base text' })
  const left = identity('left', { inherits: ['base'], tools: ['grep'], instructions: 'left text' })
  const right = identity('right', { inherits: ['base'], tools: ['glob'], instructions: 'right text' })
  const current = identity('current', { inherits: ['left', 'right'], tools: ['edit'], instructions: 'current text' })
  const { resolved, errors } = library([base, left, right, current])
  assert.equal(errors.size, 0)
  const value = resolved.get('current')
  assert.deepEqual([...value.tools].sort(), ['edit', 'glob', 'grep', 'read'])
  assert.deepEqual([...value.skills], ['translate'])
  assert.deepEqual(value.instructions.map((segment) => segment.source), ['base', 'left', 'right', 'current'])
})

test('inherits instructions ancestor-first and keeps each source once', () => {
  const a = identity('alpha', { instructions: 'A' })
  const b = identity('beta', { inherits: ['alpha'], instructions: 'B' })
  const c = identity('gamma', { inherits: ['beta'], instructions: 'C' })
  const { resolved } = library([a, b, c])
  assert.deepEqual(resolved.get('gamma').instructions.map((segment) => segment.text), ['A', 'B', 'C'])
})

test('detects cycles and missing parents without discarding healthy identities', () => {
  const a = identity('alpha', { inherits: ['beta'] })
  const b = identity('beta', { inherits: ['alpha'] })
  const good = identity('good', { tools: ['read'] })
  const missing = identity('missing-parent', { inherits: ['nope'] })
  const { resolved, errors } = library([a, b, good, missing])
  assert.ok(resolved.has('good'))
  assert.match(errors.get('alpha').message, /cyclic inheritance/i)
  assert.match(errors.get('beta').message, /cyclic inheritance/i)
  assert.match(errors.get('missing-parent').message, /does not exist/i)
})

test('nearest explicit allowWebFallback wins over inherited values', () => {
  const base = identity('base', { allowWebFallback: true })
  const child = identity('child', { inherits: ['base'], allowWebFallback: false })
  const grandchild = identity('grandchild', { inherits: ['child'] })
  const { resolved } = library([base, child, grandchild])
  assert.equal(resolved.get('child').allowWebFallback, false)
  assert.equal(resolved.get('grandchild').allowWebFallback, false)
})

test('computeAllow always keeps meta tools and expands wildcards', () => {
  const globals = ['read', 'write', 'web_search', 'web_fetch', 'skill', 'mcp__x__y', 'run_code']
  const wildcard = identity('wildcard', { tools: ['*'], skills: ['*'], allowWebFallback: false })
  const value = library([wildcard]).resolved.get('wildcard')
  const allow = computeAllow(value, globals, { webTools: ['web_search', 'web_fetch'], allowWebFallbackByDefault: true })
  for (const name of META_TOOLS) assert.ok(allow.includes(name))
  assert.ok(allow.includes('read'))
  assert.ok(allow.includes('mcp__x__y'))
  assert.ok(allow.includes('skill'))
  assert.ok(!allow.includes('run_code'))
})

test('computeAllow adds web tools by default and skill for a non-empty skill list', () => {
  const value = library([identity('review', { tools: ['read'], skills: ['tdd'] })]).resolved.get('review')
  const allow = computeAllow(value, ['read', 'write', 'web_search', 'web_fetch', 'skill'], {
    webTools: ['web_search', 'web_fetch'],
    allowWebFallbackByDefault: true,
  })
  assert.ok(allow.includes('read'))
  assert.ok(allow.includes('skill'))
  assert.ok(allow.includes('web_search'))
  assert.ok(!allow.includes('write'))
})

test('isToolAuthorized covers meta, global, scoped, web, skill, and run_code', () => {
  const value = library([identity('review', { tools: ['read'], skills: ['tdd'] })]).resolved.get('review')
  assert.equal(isToolAuthorized(value, 'read', {}), true)
  assert.equal(isToolAuthorized(value, 'write', {}), false)
  assert.equal(isToolAuthorized(value, 'preset-scoped-tool', {}), false)
  assert.equal(isToolAuthorized(value, 'role_gate', {}), true)
  assert.equal(isToolAuthorized(value, 'web_search', { webTools: ['web_search'], allowWebFallbackByDefault: true }), true)
  assert.equal(isToolAuthorized(value, 'web_search', { webTools: ['web_search'], allowWebFallbackByDefault: false }), false)
  assert.equal(isToolAuthorized(value, 'skill', {}), true)
  assert.equal(isToolAuthorized(value, 'run_code', {}), true)
  assert.equal(isToolAuthorized(null, 'anything', {}), true)
  const wildcard = library([identity('wild', { tools: ['*'] })]).resolved.get('wild')
  assert.equal(isToolAuthorized(wildcard, 'preset-scoped-tool', {}), true)
})

test('empty skill list blocks every skill and wildcard allows all', () => {
  const strict = library([identity('strict', { skills: [] })]).resolved.get('strict')
  assert.match(skillGateReason(strict, 'tdd', { enforceSkills: true }), /authorizes no skills/)
  const open = library([identity('open', { skills: ['*'] })]).resolved.get('open')
  assert.equal(skillGateReason(open, 'tdd', { enforceSkills: true }), undefined)
  const listed = library([identity('listed', { skills: ['tdd'] })]).resolved.get('listed')
  assert.equal(skillGateReason(listed, 'tdd', { enforceSkills: true }), undefined)
  assert.match(skillGateReason(listed, 'write-docs', { enforceSkills: true }), /not authorized/)
})

test('renderIdentitySection includes policy, counts, and truncates long instructions', () => {
  const value = library([identity('review', {
    tools: ['read', 'grep'],
    skills: ['tdd'],
    instructions: 'x'.repeat(200),
    allowWebFallback: false,
  })]).resolved.get('review')
  const text = renderIdentitySection(value, { maxResolvedInstructionsChars: 80, allowWebFallbackByDefault: true })
  assert.match(text, /RoleGate identity: review/)
  assert.match(text, /Identity tools: 2/)
  assert.match(text, /Authorized skills: tdd/)
  assert.match(text, /Web fallback: disabled/)
  assert.match(text, /instructions truncated/)
})

test('no identity renders no prompt section and no allow restriction', () => {
  assert.equal(renderIdentitySection(null, {}), '')
  assert.equal(computeAllow(null, ['read'], {}), null)
})

test('identity validation rejects self-inheritance and overlong instructions', () => {
  assert.throws(() => identity('self', { inherits: ['self'] }), RoleGateError)
  assert.throws(() => normalizeIdentity({
    name: 'long',
    instructions: 'x'.repeat(20),
  }, 'long', { maxInstructionsChars: 10 }), RoleGateError)
})

test('draft is explicit, preserved through resolution, and summarized', () => {
  const normal = identity('normal')
  const draft = identity('drafty', { draft: true })
  assert.equal(normal.draft, false)
  assert.equal(draft.draft, true)
  assert.equal(summarizeIdentity(normal).draft, false)
  const { resolved } = library([draft])
  assert.equal(resolved.get('drafty').draft, true)
  assert.equal(summarizeIdentity(resolved.get('drafty')).draft, true)
})

test('mergeStringList supports replacement, append, and removal', () => {
  assert.deepEqual(mergeStringList(['read'], undefined, ['write'], undefined), ['read', 'write'])
  assert.deepEqual(mergeStringList(['read', 'write'], undefined, undefined, ['read']), ['write'])
  assert.deepEqual(mergeStringList(['read'], ['grep'], ['write'], undefined), ['grep', 'write'])
  assert.deepEqual(mergeStringList(['*'], undefined, ['read'], ['*']), ['read'])
})
