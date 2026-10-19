/**
 * dsh-plugin-mode-cycle — Client half.
 *
 * Tab cycles composer modes forward, Shift+Tab cycles them backward: the
 * gesture opencode binds as `agent_cycle` / `agent_cycle_reverse`.
 *
 * Four facts read out of the shipped packages carry this file:
 *
 * 1. The composer is `[data-composer-input]`, a Lexical contenteditable inside
 *    `[data-composer-card]` since dsh 0.1.5; pre-0.1.5 builds used a textarea.
 * 2. Plan state is a session projection. A slot component reads it with
 *    `useProjection('plan')` and receives `{ active, pending }`, where `pending`
 *    means a requested change has not landed yet.
 * 3. Mode switching does NOT ride the `/plan` command. A command run logs
 *    durable `command/run` + `command/done` events, and the core `command`
 *    conversation definition renders those as a transcript row — one visible
 *    line per switch. The Host half therefore drives `ctx.planMode` directly,
 *    an entry point the plan-mode package documents, and this half reaches it
 *    over the plugin's own HTTP route.
 * 4. While the slash/trigger menu is open the keyboard belongs to it: rows
 *    settle with Tab, the menu exits with Shift+Tab, and Tab passes through
 *    untouched when nothing is highlighted. The menu root carries
 *    `data-trigger-menu`, and the highlight rides `aria-activedescendant`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mode-cycle',
  factory(require) {
    const React = require('react')

    /**
     * Cycle order; the last entry wraps to the first. DSH exposes two composer
     * modes today, so the cycle behaves as a toggle — the same shape opencode
     * has with two agents. Extending the cycle means adding an entry here.
     */
    const MODES = ['normal', 'plan']

    /**
     * Composer surface: the Lexical contenteditable, with the pre-0.1.5
     * textarea kept as a fallback. `closest()` walks ancestors, so a caret
     * inside a chip node still counts as being in the composer.
     */
    const COMPOSER = '[data-composer-input], [contenteditable="true"], textarea'

    /**
     * Overlays that own the keyboard while mounted. Hijacking Tab inside one of
     * them would rewrite the core contract, so the handler stands down.
     */
    const OVERLAY = '[data-trigger-menu], [data-conversation-composer-overlay]'

    /**
     * Mode → the plan-mode value the Host should apply. Add one entry per mode
     * when the cycle grows.
     */
    const WANTED_FOR = { normal: false, plan: true }

    /**
     * Exact route the Host half serves. Registered at a top-level path so it
     * cannot collide with the core `/api/*` namespace.
     */
    const ROUTE = '/plugin-mode-cycle/set'

    /**
     * The plan state arrives as a slot prop and a document-level key listener
     * has no props, so the bridge component publishes it here. `seen` records
     * whether the projection was available at all.
     */
    const bridge = { sessionId: undefined, active: false, pending: false, seen: false }

    /** Guards against a second switch while the first is still in flight. */
    let inFlight = false

    /**
     * Mirror the official PlanChip fold: a queued change already targets the
     * opposite of the currently committed value.
     *
     * @param plan - the `plan` projection, or undefined when unavailable.
     * @returns the effective active/pending flags plus whether it was seen.
     */
    function foldPlan(plan) {
      if (plan === undefined || plan === null) return { active: false, pending: false, seen: false }
      return {
        active: plan.pending === true ? plan.active !== true : plan.active === true,
        pending: plan.pending === true,
        seen: true,
      }
    }

    /**
     * Publish session identity and plan state for the key listener. Renders
     * nothing: the slot exists only to observe the projection.
     */
    function ModeCycleBridge(props) {
      const plan = typeof props.useProjection === 'function' ? props.useProjection('plan') : undefined
      const sessionId = props.sessionId
      const active = plan === undefined || plan === null ? null : plan.active === true
      const pending = plan === undefined || plan === null ? null : plan.pending === true
      React.useEffect(() => {
        const folded = foldPlan(plan)
        bridge.sessionId = sessionId
        bridge.active = folded.active
        bridge.pending = folded.pending
        bridge.seen = folded.seen
      }, [sessionId, active, pending])
      return null
    }

    /**
     * @param target - the keydown target.
     * @returns whether the event came from the composer surface.
     */
    function isInComposer(target) {
      if (target === null || target === undefined) return false
      if (typeof target.closest !== 'function') return false
      return target.closest(COMPOSER) !== null
    }

    /**
     * @param doc - the document to scan.
     * @returns whether an overlay that owns Tab is currently mounted.
     */
    function overlayOpen(doc) {
      if (typeof doc.querySelector !== 'function') return false
      return doc.querySelector(OVERLAY) !== null
    }

    /**
     * @param current - the mode in effect.
     * @param forward - true for Tab, false for Shift+Tab.
     * @returns the mode one step away in the cycle, wrapping at both ends.
     */
    function cycleFrom(current, forward) {
      const index = MODES.indexOf(current)
      if (index < 0) return MODES[0]
      const step = forward ? 1 : MODES.length - 1
      return MODES[(index + step) % MODES.length]
    }

    /**
     * The body the Host route expects.
     *
     * @param sessionId - the session the composer belongs to.
     * @param active - whether plan mode should be active.
     * @returns the JSON request body.
     */
    function bodyFor(sessionId, active) {
      return JSON.stringify({ sessionId, active })
    }

    function apply(ctx) {
      /**
       * Ask the Host half to apply the mode. It calls `ctx.planMode` directly,
       * so no slash command runs and the transcript stays clean.
       *
       * @param sessionId - the session the composer belongs to.
       * @param active - whether plan mode should be active.
       * @returns the Host outcome, e.g. `committed`, `queued`, or `noop`.
       */
      const dispatch = async (sessionId, active) => {
        const response = await fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: bodyFor(sessionId, active),
        })
        if (!response.ok) throw new Error(`host replied ${response.status}`)
        return response.json()
      }

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'mode-cycle-bridge',
        order: 99,
      }, ModeCycleBridge))

      ctx.effect(() => {
        /**
         * Bubble phase, not capture: core and other composer plugins attach
         * deeper, so they decide first and `defaultPrevented` reports that the
         * Tab was already claimed. That is how this coexists with the slash
         * menu and with a ghost-text plugin that accepts Tab.
         *
         * @param event - the document keydown.
         */
        const onKeyDown = (event) => {
          if (event.key !== 'Tab' || event.isComposing || event.repeat) return
          if (event.defaultPrevented) return
          if (event.ctrlKey || event.metaKey || event.altKey) return
          if (!isInComposer(event.target)) return
          if (overlayOpen(document)) return

          const sessionId = bridge.sessionId
          if (sessionId === undefined) return

          // Without the projection the mode is unknown, and a blind switch
          // could fight a change made elsewhere: stay out of the way.
          if (!bridge.seen) return

          // A request already in flight must not be joined by a second one:
          // claim the key so focus does not jump, but send nothing. The
          // projection's own `pending` deliberately does not gate this — it
          // reports a requested change that has not landed yet, and gating on
          // it swallowed the exit gesture.
          if (inFlight) {
            event.preventDefault()
            return
          }

          const current = bridge.active ? 'plan' : 'normal'
          const target = cycleFrom(current, !event.shiftKey)
          if (target === current) return

          // Claim the Tab only when the cycle actually advances, so native
          // focus traversal survives everywhere this plugin does not act.
          event.preventDefault()
          inFlight = true
          void dispatch(sessionId, WANTED_FOR[target])
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error)
              // No command fallback on purpose: silently running /plan would
              // put the transcript row back and make the noise look random.
              console.debug('[mode-cycle] switch failed:', message)
            })
            .then(() => {
              inFlight = false
            })
        }

        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, 'mode-cycle: Tab and Shift+Tab cycle composer modes')
    }

    const api = { inject: ['slots'], apply }

    /**
     * Test-only surface, gated the way community plugins gate theirs. The
     * arbitration rules are pure functions, so they can be exercised without a
     * browser; nothing here runs in production.
     */
    if (globalThis.__DSH_MODE_CYCLE_TEST__ === true) {
      api.__test = { MODES, WANTED_FOR, ROUTE, foldPlan, cycleFrom, isInComposer, overlayOpen, bodyFor }
    }

    return api
  },
})