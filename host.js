import { listLiveAgents } from 'dsh-claw-core/live-agents'
import { classifySession } from 'dsh-claw-core/session-classifier'
import { httpError, registerJsonRoute } from 'dsh-claw-core/http'
import { isSessionId } from './perm-schema.mjs'
import { defaultDshHome, resetPolicy, savePolicy } from './perm-store.mjs'
import {
  composeLayers,
  isClawContext,
  loadAgentHintSync,
  readOfficialName,
  resolveLayersSync,
  sessionFacts,
} from './perm-layers.mjs'
import { pinLiveSession, renderPolicyPrompt } from './perm-official.mjs'

export const name = 'dsh-claw-permissions'
export const inject = ['connection', 'systemPrompt']

let dshHome = defaultDshHome()

const _internal = {
  setDshHome(dir) { dshHome = dir },
  getDshHome() { return dshHome },
  pinOpenSessions(ctx) { return pinOpenSessions(ctx) },
}
export { _internal }

function payload(layers) {
  return {
    ok: true,
    record: layers.record,
    official: { name: layers.officialName, policy: layers.official },
    agent: layers.agent,
    ceiling: layers.ceiling,
    session: layers.session,
    effective: layers.effective,
    inherited: layers.inherited,
    claw: !!layers.claw,
    enforced: !!layers.claw,
  }
}

function resolveFor(ctx, sessionId, body) {
  return resolveLayersSync(dshHome, sessionFacts(ctx, sessionId, body))
}

function cwdOf(agent) {
  const session = agent && agent.session
  const header = session && session.header
  return header && header.cwd ? String(header.cwd) : ''
}

function optionalService(ctx, key) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const got = ctx.get(key)
      if (got != null) return got
    } catch { /* not injected */ }
  }
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key]
  return undefined
}

function liveSession(ctx, sessionId) {
  const sessions = optionalService(ctx, 'sessions')
  if (!sessions || !sessionId) return null
  try {
    if (typeof sessions.binding === 'function') {
      const bound = sessions.binding(sessionId)
      return (bound && bound.session) || null
    }
  } catch {
    return null
  }
  return null
}

function layersOfSession(session) {
  if (!session || !session.id) return null
  const header = session.header || {}
  return resolveLayersSync(dshHome, {
    sessionId: session.id,
    cwd: header.cwd,
    preset: header.agentPreset,
    events: session.events,
  })
}

function sessionKind(session) {
  const header = (session && session.header) || {}
  return classifySession({
    dshHome,
    cwd: header.cwd,
    agentPreset: header.agentPreset,
  })
}

function pinSession(session) {
  if (!session) return null
  let layers
  try {
    layers = layersOfSession(session)
  } catch (error) {
    // Non-claw: classifier miss / layers noise must not fail-close first turn.
    if (sessionKind(session) === 'ordinary') return null
    throw error
  }
  return pinLiveSession(session, layers)
}

function pinOpenSessions(ctx) {
  const summary = { visited: 0, pinned: 0, failed: [] }
  try {
    const agents = optionalService(ctx, 'agents')
    const list = listLiveAgents(agents ? { agents } : ctx)
    for (const agent of list) {
      summary.visited++
      const session = agent && agent.session
      try {
        const layers = layersOfSession(session)
        pinSession(session)
        if (layers && layers.claw) summary.pinned++
      } catch (error) {
        summary.failed.push({
          sessionId: session && session.id,
          error: String(error && error.message || error),
        })
      }
    }
  } catch (error) {
    summary.degraded = true
    summary.error = String(error && error.message || error)
  }
  return summary
}

export function apply(ctx) {
  const stopPrompt = ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function'
    ? ctx.systemPrompt.section({
      name: 'dsh-claw-permissions',
      order: 14,
      text(assemble) {
        const agent = assemble && assemble.agent
        const session = agent && agent.session
        const header = session && session.header
        const cwd = cwdOf(agent)
        if (!cwd && !session) return ''
        const layers = resolveLayersSync(dshHome, {
          sessionId: session && session.id,
          cwd,
          preset: header && header.agentPreset,
          events: session && session.events,
        })
        if (!layers || !layers.claw) return ''
        return renderPolicyPrompt(layers.effective)
      },
    })
    : function () {}

  // DSH 0.1.6+: pin sandbox on agent/created (serial await) so the first turn sees the tight mode.
  // Claw pin failures must rethrow so the Host serial barrier fail-closes the first turn.
  const stopStart = typeof ctx.on === 'function'
    ? ctx.on('agent/created', async (payload) => {
      pinSession(payload && payload.agent && payload.agent.session)
    })
    : function () {}

  const sweep = pinOpenSessions(ctx)
  if (sweep.degraded) {
    // agents.list failed — open sessions were not re-pinned; do not swallow silently
  }

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/permissions/read',
    handle: async (body) => {
      const sessionId = body && body.sessionId
      if (!isSessionId(sessionId)) {
        throw httpError(400, 'invalid session id')
      }
      return payload(resolveFor(ctx, sessionId, body))
    },
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/permissions/write',
    handle: async (body) => {
      const sessionId = body && body.sessionId
      if (!isSessionId(sessionId)) {
        throw httpError(400, 'invalid session id')
      }
      const facts = sessionFacts(ctx, sessionId, body)
      const agent = loadAgentHintSync(dshHome, facts)
      if (!isClawContext(facts, agent)) {
        return payload(resolveFor(ctx, sessionId, body))
      }
      const composed = composeLayers({
        officialName: readOfficialName(dshHome, facts.events),
        agent,
        sessionRecord: { source: 'session', policy: body && body.policy },
        claw: true,
      })
      const record = await savePolicy(dshHome, sessionId, composed.session)
      pinSession(liveSession(ctx, sessionId))
      return payload({ ...composed, record })
    },
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/permissions/reset',
    handle: async (body) => {
      const sessionId = body && body.sessionId
      if (!isSessionId(sessionId)) {
        throw httpError(400, 'invalid session id')
      }
      await resetPolicy(dshHome, sessionId)
      pinSession(liveSession(ctx, sessionId))
      return payload(resolveFor(ctx, sessionId, body))
    },
  })

  ctx.effect(() => () => {
    if (typeof stopPrompt === 'function') stopPrompt()
    if (typeof stopStart === 'function') stopStart()
  })
}
