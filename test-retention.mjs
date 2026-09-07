/**
 * Pure-function unit tests for the retention planning core.
 * Run: node test-retention.mjs  (imports the compiled lib/)
 */
import assert from 'node:assert/strict'
import { planRetention, planOrphans, retentionToMs, cronDueSince, isPlausibleCron } from './lib/index.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

const NOW = 1_800_000_000_000

console.log('retentionToMs')
check('days unit multiplies by 24h', () => {
  assert.equal(retentionToMs(7, 'days'), 7 * 86_400_000)
})
check('hours unit multiplies by 1h', () => {
  assert.equal(retentionToMs(12, 'hours'), 12 * 3_600_000)
})

console.log('planRetention')
check('dir older than cutoff is eligible', () => {
  const [e] = planRetention(
    [{ id: 'a', scope: 'archive-dir', lastWriteMs: NOW - 8 * 86_400_000, attached: false }],
    NOW, NOW - 7 * 86_400_000,
  )
  assert.equal(e.eligible, true)
})
check('dir written after cutoff is within-retention', () => {
  const [e] = planRetention(
    [{ id: 'a', scope: 'gui-archived', lastWriteMs: NOW - 6 * 86_400_000, attached: false }],
    NOW, NOW - 7 * 86_400_000,
  )
  assert.equal(e.eligible, false)
  assert.equal(e.skipReason, 'within-retention')
})
check('attached session is never eligible, whatever its age', () => {
  const [e] = planRetention(
    [{ id: 'a', scope: 'gui-archived', lastWriteMs: NOW - 30 * 86_400_000, attached: true }],
    NOW, NOW - 7 * 86_400_000,
  )
  assert.equal(e.eligible, false)
  assert.equal(e.skipReason, 'attached')
})
check('empty dir is skipped', () => {
  const [e] = planRetention(
    [{ id: 'a', scope: 'archive-dir', lastWriteMs: undefined, attached: false }],
    NOW, NOW - 7 * 86_400_000,
  )
  assert.equal(e.eligible, false)
  assert.equal(e.skipReason, 'empty-dir')
})
check('hour-level retention boundary: exactly at cutoff is kept (>=)', () => {
  const cutoff = NOW - 5 * 3_600_000
  const [at] = planRetention([{ id: 'a', scope: 'archive-dir', lastWriteMs: cutoff, attached: false }], NOW, cutoff)
  const [past] = planRetention([{ id: 'b', scope: 'archive-dir', lastWriteMs: cutoff - 1, attached: false }], NOW, cutoff)
  assert.equal(at.eligible, false)
  assert.equal(past.eligible, true)
})

console.log('cronDueSince / isPlausibleCron')
check('daily cron fires due after its wall-clock time passes', () => {
  // Time-independent formulation: cron parser resolves prev occurrence in the
  // process-local timezone, so all anchors derive from "now"'s own day.
  const now = new Date()
  const todayAt = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime() }
  const justAfter0430 = todayAt(4, 31)
  const nightBefore = todayAt(0, 0)
  const lateSameDay = todayAt(23, 59)
  assert.equal(cronDueSince('0 4 * * *', nightBefore, justAfter0430), true)
  assert.equal(cronDueSince('0 4 * * *', justAfter0430, lateSameDay), false) // today's fire already consumed
})
check('invalid cron is never due', () => {
  assert.equal(cronDueSince('not a cron', 0, Date.now()), false)
})
check('plausibility regex accepts plain cron, rejects prose', () => {
  assert.equal(isPlausibleCron('0 4 * * *'), true)
  assert.equal(isPlausibleCron('*/30 * * * *'), true)
  assert.equal(isPlausibleCron('每天凌晨'), false)
})

console.log('planOrphans')
const CUTOFF = NOW - 3_600_000
check('orphan with missing parent and old write is eligible', () => {
  const [e] = planOrphans(
    [{ id: 'sub1', parentSession: 'session-gone', lastWriteMs: NOW - 2 * 3_600_000, attached: false }],
    new Set(['session-alive']), CUTOFF,
  )
  assert.equal(e.eligible, true)
})
check('parent still on disk keeps the child, whatever its age', () => {
  const [e] = planOrphans(
    [{ id: 'sub1', parentSession: 'session-alive', lastWriteMs: NOW - 30 * 86_400_000, attached: false }],
    new Set(['session-alive']), CUTOFF,
  )
  assert.equal(e.eligible, false)
  assert.equal(e.skipReason, 'parent-alive')
})
check('attached orphan is never eligible', () => {
  const [e] = planOrphans(
    [{ id: 'sub1', parentSession: 'session-gone', lastWriteMs: NOW - 2 * 3_600_000, attached: true }],
    new Set(), CUTOFF,
  )
  assert.equal(e.eligible, false)
  assert.equal(e.skipReason, 'attached')
})
check('warm orphan is within-retention', () => {
  const [e] = planOrphans(
    [{ id: 'sub1', parentSession: 'session-gone', lastWriteMs: NOW - 60_000, attached: false }],
    new Set(), CUTOFF,
  )
  assert.equal(e.eligible, false)
  assert.equal(e.skipReason, 'within-retention')
})
check('orphan without files is skipped (empty-dir)', () => {
  const [e] = planOrphans(
    [{ id: 'sub1', parentSession: 'session-gone', lastWriteMs: undefined, attached: false }],
    new Set(), CUTOFF,
  )
  assert.equal(e.eligible, false)
  assert.equal(e.skipReason, 'empty-dir')
})

console.log(`\n${passed} checks passed`)
