/**
 * Tests for the Host half — the routes' pure pieces.
 *
 * The routes need a live `ctx`, but everything that decides their answers is a
 * plain function: validation, method handling, the bounded body read, the
 * mode→argument mapping, the query parse, and the health payload.
 *
 * Run: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import {
  inject,
  ROUTE,
  HEALTH_ROUTE,
  PLAN_COMMAND,
  OFF_INPUT,
  MAX_BODY_BYTES,
  inputFor,
  methodRejection,
  parseRequest,
  readBody,
  sessionIdOf,
  healthFor,
} from '../index.js'

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
const testAsync = async (name, fn) => {
  try {
    await fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}

test('declares the services the routes cannot work without', () => {
  // `planMode` deliberately absent: the plan-mode row owns that service on its
  // own context, so a sibling row can never inject it. The switch goes through
  // the injectable `commands` registry instead.
  assert.deepEqual([...inject], ['webServer', 'agents', 'commands'])
  assert.equal([...inject].includes('planMode'), false)
})

test('serves top-level routes, clear of the core /api namespace', () => {
  assert.equal(ROUTE, '/plugin-mode-cycle/set')
  assert.equal(HEALTH_ROUTE, '/plugin-mode-cycle/health')
  assert.equal(ROUTE.startsWith('/api/'), false)
  assert.equal(HEALTH_ROUTE.startsWith('/api/'), false)
})

test('the switch targets the plan command', () => {
  assert.equal(PLAN_COMMAND, 'plan')
  assert.equal(OFF_INPUT, 'off')
})

test('the mode maps to the plan argument that reaches it', () => {
  // Entering plan mode is a bare `/plan`; leaving is `/plan off`.
  assert.equal(inputFor(true), '')
  assert.equal(inputFor(false), OFF_INPUT)
})

test('the switch route accepts only POST', () => {
  assert.equal(methodRejection('POST'), undefined)
  assert.equal(methodRejection('GET'), 405)
  assert.equal(methodRejection('DELETE'), 405)
})

test('a route may allow its own methods', () => {
  assert.equal(methodRejection('GET', ['GET', 'HEAD']), undefined)
  assert.equal(methodRejection('HEAD', ['GET', 'HEAD']), undefined)
  assert.equal(methodRejection('POST', ['GET', 'HEAD']), 405)
})

test('a well-formed body yields the session and the wanted value', () => {
  assert.deepEqual(parseRequest('{"sessionId":"s1","active":true}'), { value: { sessionId: 's1', active: true } })
  assert.deepEqual(parseRequest('{"sessionId":"s1","active":false}'), { value: { sessionId: 's1', active: false } })
})

test('a body with unknown extra fields still yields the two known ones', () => {
  assert.deepEqual(parseRequest('{"sessionId":"s1","active":true,"extra":1}'), { value: { sessionId: 's1', active: true } })
})

test('malformed JSON is refused', () => {
  assert.equal(parseRequest('{').error, 'body must be JSON')
  assert.equal(parseRequest('').error, 'body must be JSON')
})

test('a non-object body is refused', () => {
  assert.equal(parseRequest('[]').error, 'body must be a JSON object')
  assert.equal(parseRequest('null').error, 'body must be a JSON object')
  assert.equal(parseRequest('"s1"').error, 'body must be a JSON object')
})

test('a missing, empty, or non-string sessionId is refused', () => {
  assert.equal(parseRequest('{"active":true}').error, 'sessionId must be a non-empty string')
  assert.equal(parseRequest('{"sessionId":"","active":true}').error, 'sessionId must be a non-empty string')
  assert.equal(parseRequest('{"sessionId":7,"active":true}').error, 'sessionId must be a non-empty string')
})

test('a missing or non-boolean active is refused', () => {
  assert.equal(parseRequest('{"sessionId":"s1"}').error, 'active must be a boolean')
  assert.equal(parseRequest('{"sessionId":"s1","active":"true"}').error, 'active must be a boolean')
  assert.equal(parseRequest('{"sessionId":"s1","active":1}').error, 'active must be a boolean')
})

test('a probe id is read from the query string', () => {
  assert.equal(sessionIdOf('/plugin-mode-cycle/health?sessionId=s1'), 's1')
  assert.equal(sessionIdOf('/plugin-mode-cycle/health?a=1&sessionId=s1&b=2'), 's1')
  assert.equal(sessionIdOf('/plugin-mode-cycle/health?sessionId='), undefined)
  assert.equal(sessionIdOf('/plugin-mode-cycle/health'), undefined)
  assert.equal(sessionIdOf(undefined), undefined)
})

test('health reports only presence', () => {
  assert.deepEqual(healthFor({ webServer: true, agents: true, commands: true, planCommand: true }), {
    ok: true,
    services: { webServer: true, agents: true, commands: true },
    planCommand: true,
  })
  const degraded = healthFor({ webServer: true, agents: false, commands: false, planCommand: false })
  assert.equal(degraded.ok, false)
  assert.equal(degraded.services.agents, false)
  // Absent fields read as false rather than leaking a value.
  assert.equal(healthFor({}).ok, false)
  assert.equal(healthFor({}).planCommand, false)
})

await testAsync('readBody returns the whole body while it is under the cap', async () => {
  const stream = (async function* () {
    yield Buffer.from('{"sessionId":')
    yield Buffer.from('"s1"}')
  })()
  assert.equal(await readBody(stream, MAX_BODY_BYTES), '{"sessionId":"s1"}')
})

await testAsync('readBody rejects a body over the cap', async () => {
  const stream = (async function* () {
    yield Buffer.alloc(MAX_BODY_BYTES + 1, 0x20)
  })()
  await assert.rejects(() => readBody(stream, MAX_BODY_BYTES), /body too large/)
})

await testAsync('readBody stops pulling as soon as the cap is crossed', async () => {
  let pulled = 0
  const stream = (async function* () {
    for (let index = 0; index < 100; index += 1) {
      pulled += 1
      yield Buffer.alloc(64)
    }
  })()
  await assert.rejects(() => readBody(stream, 128), /body too large/)
  assert.ok(pulled < 100, 'must not drain the whole stream after the cap is crossed')
})

console.log(results.join('\n'))
console.log(process.exitCode ? '\nFAILED' : `\n${results.length} passed`)