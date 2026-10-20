import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'

test('config defaults are safe and stable', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.defaultIdentity, null)
  assert.deepEqual(config.webTools, ['web_search', 'web_fetch'])
  assert.equal(config.allowWebFallbackByDefault, true)
  assert.equal(config.enforceSkills, true)
  assert.equal(config.sectionOrder, 450)
  assert.equal(config.maxInstructionsChars, 16_000)
  assert.equal(config.maxResolvedInstructionsChars, 32_000)
  assert.equal(config.maxStateEntries, 500)
})

test('config accepts explicit values and ignores malformed ones', () => {
  const config = normalizeConfig({
    defaultIdentity: 'code-review',
    webTools: ['web_search', 'web_search', 'custom_fetch', 42],
    allowWebFallbackByDefault: false,
    enforceSkills: false,
    sectionOrder: 700,
    maxInstructionsChars: 1000,
    maxResolvedInstructionsChars: 2000,
    maxStateEntries: 10,
  })
  assert.equal(config.defaultIdentity, 'code-review')
  assert.deepEqual(config.webTools, ['web_search', 'custom_fetch'])
  assert.equal(config.allowWebFallbackByDefault, false)
  assert.equal(config.enforceSkills, false)
  assert.equal(config.sectionOrder, 700)
  assert.equal(config.maxInstructionsChars, 1000)
  assert.equal(config.maxResolvedInstructionsChars, 2000)
  assert.equal(config.maxStateEntries, 10)
})

test('invalid default identity falls back to null instead of failing activation', () => {
  assert.equal(normalizeConfig({ defaultIdentity: 'Code Review' }).defaultIdentity, null)
  assert.equal(normalizeConfig({ defaultIdentity: 'none' }).defaultIdentity, null)
  assert.equal(normalizeConfig({ defaultIdentity: 42 }).defaultIdentity, null)
})
