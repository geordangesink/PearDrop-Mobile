const test = require('node:test')
const assert = require('node:assert/strict')
const { extractInviteUrl } = require('../src/lib/invite')

test('extractInviteUrl returns direct invite links', () => {
  const invite = 'peardrops://invite?drive=abc'
  assert.equal(extractInviteUrl(invite), invite)
})

test('extractInviteUrl reads invite query parameter', () => {
  const deepLink = 'peardrops://open?invite=' + encodeURIComponent('peardrops://invite?drive=xyz')
  assert.equal(extractInviteUrl(deepLink), 'peardrops://invite?drive=xyz')
})

test('extractInviteUrl rejects non-invite values', () => {
  assert.equal(extractInviteUrl('https://example.com'), '')
  assert.equal(extractInviteUrl(null), '')
})
