/**
 * Logic tests for dsh-plugin-mode-cycle.
 *
 * The plugin registers through `window.__ModuleLoader__`, and its arbitration
 * rules are pure functions, so a stub loader captures the factory and the
 * gated `__test` surface exposes those rules — no browser, no DOM required.
 *
 * Run: node test/mode-cycle.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** Capture the module definition the way the browser module loader would. */
let captured
const sandbox = {
  __DSH_MODE_CYCLE_TEST__: true,
  window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.ok(captured, 'client.js must register through window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-plugin-mode-cycle', 'module id must equal the package name')

/** Minimal React stand-in: the pure helpers never render. */
const require = (name) => {
  if (name === 'react') return { createElement: () => null, useEffect: () => {} }
  throw new Error(`unexpected require: ${name}`)
}

const api = captured.factory(require)
const { MODES, WANTED_FOR, ROUTE, foldPlan, cycleFrom, isInComposer, overlayOpen, bodyFor } = api.__test

const results = []
const test = (name, fn) => {
  try {
    fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}

/**
 * Values cross a `vm` realm boundary, so their prototypes differ from this
 * realm's. Normalize before comparing structure.
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

test('injects only the slots service, now that switching leaves the command pipeline', () => {
  assert.deepEqual(plain(api.inject), ['slots'])
})

test('cycle order is normal then plan, with two entries', () => {
  assert.deepEqual([...MODES], ['normal', 'plan'])
})

test('each mode names the plan-mode value the host should apply', () => {
  // Switching no longer runs /plan; the client asks the host for a value.
  assert.equal(plain(WANTED_FOR).plan, true)
  assert.equal(plain(WANTED_FOR).normal, false)
})

test('the value requested from each mode matches the gesture target', () => {
  const wanted = (current, forward) => plain(WANTED_FOR)[cycleFrom(current, forward)]
  assert.equal(wanted('normal', true), true)
  assert.equal(wanted('plan', true), false)
  assert.equal(wanted('normal', false), true)
  assert.equal(wanted('plan', false), false)
})

test('the request body carries the session and the wanted value', () => {
  assert.deepEqual(plain(JSON.parse(bodyFor('session-1', true))), { sessionId: 'session-1', active: true })
  assert.deepEqual(plain(JSON.parse(bodyFor('session-1', false))), { sessionId: 'session-1', active: false })
})

test('the route is a top-level path, clear of the core /api namespace', () => {
  assert.equal(ROUTE, '/plugin-mode-cycle/set')
  assert.equal(ROUTE.startsWith('/api/'), false)
})

test('Tab advances the cycle', () => {
  assert.equal(cycleFrom('normal', true), 'plan')
})

test('Tab wraps past the last mode back to the first', () => {
  assert.equal(cycleFrom('plan', true), 'normal')
})

test('Shift+Tab walks the cycle backward', () => {
  assert.equal(cycleFrom('plan', false), 'normal')
  assert.equal(cycleFrom('normal', false), 'plan')
})

test('an unknown current mode lands on the first entry', () => {
  assert.equal(cycleFrom('nonsense', true), 'normal')
})

test('a missing projection reports itself unseen and inactive', () => {
  assert.deepEqual(plain(foldPlan(undefined)), { active: false, pending: false, seen: false })
  assert.deepEqual(plain(foldPlan(null)), { active: false, pending: false, seen: false })
})

test('a settled projection reports its own active flag', () => {
  assert.deepEqual(plain(foldPlan({ active: true, pending: false })), { active: true, pending: false, seen: true })
  assert.deepEqual(plain(foldPlan({ active: false, pending: false })), { active: false, pending: false, seen: true })
})

test('a queued toggle targets the opposite of the committed value', () => {
  // Mirrors the official PlanChip fold: pending already points at !active.
  assert.equal(foldPlan({ active: true, pending: true }).active, false)
  assert.equal(foldPlan({ active: false, pending: true }).active, true)
  assert.equal(foldPlan({ active: true, pending: true }).pending, true)
})

test('a composer descendant counts as being in the composer', () => {
  const chip = { closest: (selector) => (selector.includes('data-composer-input') ? { tag: 'div' } : null) }
  assert.equal(isInComposer(chip), true)
})

test('a node outside the composer does not', () => {
  assert.equal(isInComposer({ closest: () => null }), false)
})

test('a target without closest() is rejected instead of throwing', () => {
  assert.equal(isInComposer(undefined), false)
  assert.equal(isInComposer({}), false)
  assert.equal(isInComposer({ closest: null }), false)
})

test('an open trigger menu is detected', () => {
  assert.equal(overlayOpen({ querySelector: (selector) => (selector.includes('data-trigger-menu') ? {} : null) }), true)
})

test('no overlay means the gesture owns Tab', () => {
  assert.equal(overlayOpen({ querySelector: () => null }), false)
})

test('a document without querySelector is treated as no overlay', () => {
  assert.equal(overlayOpen({}), false)
})

console.log(results.join('\n'))
console.log(process.exitCode ? '\nFAILED' : `\n${results.length} passed`)