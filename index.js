/**
 * dsh-plugin-mode-cycle — Host half.
 *
 * The Client half asks this route for a mode, and this half switches it without
 * leaving a command row in the transcript.
 *
 * Why the obvious approach does not work: `ctx.planMode` is not reachable here.
 * `dsh-plan-mode`'s default export is its service class, so the loader
 * instantiates it on *that row's* context, and cordis exposes a service only to
 * the registering context's subtree. A sibling row can never inject it — which
 * is also why no shipped plugin declares `planMode` in an `inject` list. An
 * earlier version of this file did, and the plugin simply never activated.
 *
 * What works instead: the `/plan` command's own handler. `ctx.commands` *is*
 * injectable (the plan-mode package acquires it the same way), and
 * `ctx.commands.find(agent, 'plan')` returns the command definition, whose
 * `handler` is documented as the "direct UI handler" that "runs directly
 * against the agent; no model message is created". `execute()` is what appends
 * the durable `command/run` + `command/done` pair that the core `command`
 * conversation definition renders as a transcript row; calling the handler
 * directly skips only that pair. Every semantic stays official — the same
 * handler, the same `plan/mode` session event, the same `plan:policy` prompt
 * section, and the same narration message the controller appends by design.
 *
 * Service contracts this file relies on, all read out of the shipped packages:
 *
 * - `ctx.webServer.register({ kind, path, handler })` returns a disposer.
 * - `ctx.agents.get(sessionId)` yields the agent for a session (the registry is
 *   keyed by session id).
 * - `ctx.commands.find(agent, name)` returns the scoped command definition.
 * - A command handler receives `{ commandId, agent, rawInput, attachments, signal }`.
 * - `ctx.connection.requestRejection(req)` returns an HTTP status when the
 *   request must be refused, and `undefined` when it may proceed.
 */

/**
 * Services this feature cannot work without, so a profile lacking any of them
 * leaves the plugin inactive instead of serving a dead route. The connection
 * service is optional and wired separately.
 */
export const inject = ['webServer', 'agents', 'commands']

/** Exact route the Client half POSTs a switch to; top-level, clear of `/api/*`. */
export const ROUTE = '/plugin-mode-cycle/set'

/** Exact route that reports what resolved; used to diagnose a dead switch. */
export const HEALTH_ROUTE = '/plugin-mode-cycle/health'

/** The command whose handler performs the switch. */
export const PLAN_COMMAND = 'plan'

/** The argument that leaves plan mode; an empty line enters it. */
export const OFF_INPUT = 'off'

/** The switch payload is two fields, so anything larger is not our client. */
export const MAX_BODY_BYTES = 1024

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/**
 * @param active - whether plan mode is wanted.
 * @returns the `/plan` argument that reaches that mode.
 */
export function inputFor(active) {
  return active ? '' : OFF_INPUT
}

/**
 * @param method - the request method.
 * @param allowed - the methods the route serves.
 * @returns the status to refuse with, or undefined when the method may proceed.
 */
export function methodRejection(method, allowed = ['POST']) {
  return allowed.includes(method) ? undefined : 405
}

/**
 * Validate a request body. Kept free of the wire so it can be tested directly.
 *
 * @param raw - the body as text.
 * @returns `{ value }` when usable, otherwise `{ error }` with a client-safe message.
 */
export function parseRequest(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'body must be JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'body must be a JSON object' }
  }
  const { sessionId, active } = parsed
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { error: 'sessionId must be a non-empty string' }
  }
  if (typeof active !== 'boolean') {
    return { error: 'active must be a boolean' }
  }
  return { value: { sessionId, active } }
}

/**
 * Read a request body under a hard byte cap.
 *
 * @param req - the incoming request stream.
 * @param limit - the largest body to accept, in bytes.
 * @returns the body as text.
 * @throws when the cap is exceeded.
 */
export async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param url - a request URL.
 * @returns the non-empty `sessionId` query value, or undefined.
 */
export function sessionIdOf(url) {
  if (typeof url !== 'string') return undefined
  const query = url.indexOf('?')
  if (query < 0) return undefined
  const found = new URLSearchParams(url.slice(query + 1)).get('sessionId')
  return found === null || found === '' ? undefined : found
}

/**
 * Build the health payload from what resolved at request time. Deliberately
 * reports presence, never content.
 *
 * @param presence - whether each capability answered.
 * @returns the payload the health route sends.
 */
export function healthFor(presence) {
  return {
    ok: presence.commands === true && presence.agents === true,
    services: {
      webServer: presence.webServer === true,
      agents: presence.agents === true,
      commands: presence.commands === true,
    },
    planCommand: presence.planCommand === true,
  }
}

export function apply(ctx) {
  /**
   * Set while the optional connection service is present. Absent in a profile
   * without it, where the routes simply answer without the extra guard.
   */
  let rejectUnauthorized

  ctx.effect(() => ctx.inject(['connection'], (scoped) => {
    rejectUnauthorized = (req, res) => {
      const status = scoped.connection.requestRejection(req)
      if (status === undefined) return false
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return true
    }
    return () => {
      rejectUnauthorized = undefined
    }
  }), 'mode-cycle: optional unauthorized-request guard')

  ctx.effect(() => {
    /**
     * Switch one session's plan mode through the official command handler,
     * without running the command pipeline.
     *
     * @param sessionId - the session whose mode changes.
     * @param active - whether plan mode is wanted.
     * @returns the status and payload to answer with.
     */
    const switchMode = async (sessionId, active) => {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) {
        return { status: 409, payload: { error: 'session is not running' } }
      }
      const definition = ctx.commands.find(agent, PLAN_COMMAND)
      if (definition === undefined || typeof definition.handler !== 'function') {
        return { status: 409, payload: { error: `the /${PLAN_COMMAND} command is not registered in this profile` } }
      }
      const result = await definition.handler({
        commandId: `mode-cycle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        agent,
        rawInput: inputFor(active),
        attachments: [],
        signal: new AbortController().signal,
      })
      const shaped = result !== null && typeof result === 'object' ? result : {}
      return {
        status: 200,
        payload: { active, kind: shaped.kind ?? null, text: shaped.text ?? null },
      }
    }

    /**
     * @param req - the incoming request.
     * @param res - the response to write.
     */
    const handleSet = async (req, res) => {
      if (rejectUnauthorized !== undefined && rejectUnauthorized(req, res)) return

      const refused = methodRejection(req.method)
      if (refused !== undefined) {
        res.writeHead(refused, { ...JSON_HEADERS, allow: 'POST' })
        res.end(JSON.stringify({ error: 'use POST' }))
        return
      }

      let raw
      try {
        raw = await readBody(req, MAX_BODY_BYTES)
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'body too large'
        res.writeHead(tooLarge ? 413 : 400, JSON_HEADERS)
        res.end(JSON.stringify({ error: tooLarge ? 'body too large' : 'unreadable body' }))
        return
      }

      const parsed = parseRequest(raw)
      if (parsed.error !== undefined) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ error: parsed.error }))
        return
      }

      const { sessionId, active } = parsed.value
      const answered = await switchMode(sessionId, active)
      res.writeHead(answered.status, JSON_HEADERS)
      res.end(JSON.stringify(answered.payload))
    }

    /**
     * Report what resolved. Pass `?sessionId=<id>` to also probe whether the
     * `/plan` command is registered for that session's agent.
     *
     * @param req - the incoming request.
     * @param res - the response to write.
     */
    const handleHealth = (req, res) => {
      if (rejectUnauthorized !== undefined && rejectUnauthorized(req, res)) return

      const refused = methodRejection(req.method, ['GET', 'HEAD'])
      if (refused !== undefined) {
        res.writeHead(refused, { ...JSON_HEADERS, allow: 'GET, HEAD' })
        res.end(JSON.stringify({ error: 'use GET' }))
        return
      }

      const probeId = sessionIdOf(req.url)
      const probe = probeId === undefined ? undefined : ctx.agents.get(probeId)
      const definition = probe === undefined ? undefined : ctx.commands.find(probe, PLAN_COMMAND)

      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(healthFor({
        webServer: typeof ctx.webServer?.register === 'function',
        agents: typeof ctx.agents?.get === 'function',
        commands: typeof ctx.commands?.find === 'function',
        planCommand: typeof definition?.handler === 'function',
      })))
    }

    /**
     * Contain every route failure: log it with the context, answer 500, and
     * never leak a stack to the client.
     *
     * @param route - the route path, for the log line.
     * @param handle - the route body.
     * @returns the request handler to register.
     */
    const contain = (route, handle) => (req, res) => {
      void Promise.resolve(handle(req, res)).catch((error) => {
        ctx.logger.warn('mode-cycle: %s %s failed', req.method, route)
        ctx.logger.warn(error)
        if (!res.headersSent) res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({ error: 'internal' }))
      })
    }

    const disposeSet = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: contain(ROUTE, handleSet) })
    const disposeHealth = ctx.webServer.register({ kind: 'exact', path: HEALTH_ROUTE, handler: contain(HEALTH_ROUTE, handleHealth) })
    return () => {
      disposeSet()
      disposeHealth()
    }
  }, 'mode-cycle: host routes for silent mode switching')
}