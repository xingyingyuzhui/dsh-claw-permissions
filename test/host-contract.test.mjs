import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, _internal } from '../host.js'

async function clawHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsp-host-'))
  const clawA = join(home, 'DSclaw', 'alpha')
  const clawB = join(home, 'DSclaw', 'beta')
  await mkdir(join(home, 'workspace-agents'), { recursive: true })
  await mkdir(clawA, { recursive: true })
  await mkdir(clawB, { recursive: true })
  await writeFile(join(home, 'settings.yaml'), 'permission:\n  defaultPreset: danger-full-access\n')
  await writeFile(join(home, 'workspace-agents', 'registry.json'), JSON.stringify({
    version: 1,
    agents: {
      wa_a: {
        agentId: 'wa_a',
        title: 'alpha',
        preset: 'developer',
        dshPreset: 'wa-alpha',
        canonicalRoot: clawA,
        status: 'active',
      },
      wa_b: {
        agentId: 'wa_b',
        title: 'beta',
        preset: 'research',
        dshPreset: 'wa-beta',
        canonicalRoot: clawB,
        status: 'active',
      },
    },
  }))
  return { home, clawA, clawB }
}

function stubCtx(agents) {
  return {
    agents,
    connection: {
      fetch: {
        register() { return () => {} },
      },
    },
    systemPrompt: { section() { return () => {} } },
    on() { return () => {} },
    effect() {},
  }
}

test('apply pins existing live claw agents via agents.list', async () => {
  const { home, clawA, clawB } = await clawHome()
  _internal.setDshHome(home)
  const appendedA = []
  const appendedB = []
  const sessionA = {
    id: 'session-aaaa-1111-2222-3333-444444444444',
    header: { cwd: clawA, agentPreset: 'wa-alpha' },
    events: [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
    append(type, data) { appendedA.push({ type, data }); this.events.push({ type, data }) },
  }
  const sessionB = {
    id: 'session-bbbb-1111-2222-3333-444444444444',
    header: { cwd: clawB, agentPreset: 'wa-beta' },
    events: [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
    append(type, data) { appendedB.push({ type, data }); this.events.push({ type, data }) },
  }
  let valuesCalled = false
  const agents = {
    list() {
      return [
        { id: 'agent-a', session: sessionA },
        { id: 'agent-b', session: sessionB },
      ]
    },
    values() {
      valuesCalled = true
      throw new Error('agents.values must not be called')
    },
  }
  apply(stubCtx(agents))
  assert.equal(valuesCalled, false)
  assert.ok(appendedA.some((row) => row.type === 'sandbox/mode' && row.data.mode !== 'danger-full-access'))
  assert.ok(appendedB.some((row) => row.type === 'sandbox/mode' && row.data.mode !== 'danger-full-access'))
  const sweep = _internal.pinOpenSessions(stubCtx(agents))
  assert.equal(sweep.visited, 2)
  assert.equal(sweep.pinned, 2)
  assert.equal(sweep.failed.length, 0)
  assert.equal(sweep.degraded, undefined)
})

test('one pin throw still pins the other; failed length 1', async () => {
  const { home, clawA, clawB } = await clawHome()
  _internal.setDshHome(home)
  const appendedB = []
  const sessionA = {
    id: 'session-cccc-1111-2222-3333-444444444444',
    header: { cwd: clawA, agentPreset: 'wa-alpha' },
    events: [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
    append() { throw new Error('append boom') },
  }
  const sessionB = {
    id: 'session-dddd-1111-2222-3333-444444444444',
    header: { cwd: clawB, agentPreset: 'wa-beta' },
    events: [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
    append(type, data) { appendedB.push({ type, data }); this.events.push({ type, data }) },
  }
  const agents = {
    list() {
      return [
        { id: 'agent-a', session: sessionA },
        { id: 'agent-b', session: sessionB },
      ]
    },
    values() { throw new Error('agents.values must not be called') },
  }
  const sweep = _internal.pinOpenSessions(stubCtx(agents))
  assert.equal(sweep.visited, 2)
  assert.equal(sweep.failed.length, 1)
  assert.equal(sweep.failed[0].sessionId, sessionA.id)
  assert.match(sweep.failed[0].error, /append boom/)
  assert.equal(sweep.pinned, 1)
  assert.ok(appendedB.some((row) => row.type === 'sandbox/mode'))
})

test('agents.list throws → summary.degraded', async () => {
  const { home } = await clawHome()
  _internal.setDshHome(home)
  const agents = {
    list() { throw new Error('list exploded') },
    values() { throw new Error('agents.values must not be called') },
  }
  const sweep = _internal.pinOpenSessions(stubCtx(agents))
  assert.equal(sweep.degraded, true)
  assert.match(sweep.error, /list exploded/)
  assert.equal(sweep.visited, 0)
})

test('agents.values is never called even when present', async () => {
  const { home, clawA } = await clawHome()
  _internal.setDshHome(home)
  let valuesCalled = false
  const session = {
    id: 'session-eeee-1111-2222-3333-444444444444',
    header: { cwd: clawA, agentPreset: 'wa-alpha' },
    events: [],
    append() {},
  }
  const agents = {
    list() { return [{ id: 'a', session }] },
    values() {
      valuesCalled = true
      throw new Error('agents.values must not be called')
    },
  }
  _internal.pinOpenSessions(stubCtx(agents))
  assert.equal(valuesCalled, false)
})

test('non-claw session is not pinned tighter', async () => {
  const { home } = await clawHome()
  _internal.setDshHome(home)
  const desktop = join(home, 'Desktop', 'project')
  await mkdir(desktop, { recursive: true })
  const appended = []
  const session = {
    id: 'session-ffff-1111-2222-3333-444444444444',
    header: { cwd: desktop, agentPreset: 'standard' },
    events: [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
    append(type, data) { appended.push({ type, data }) },
  }
  const agents = {
    list() { return [{ id: 'ordinary', session }] },
    values() { throw new Error('agents.values must not be called') },
  }
  const sweep = _internal.pinOpenSessions(stubCtx(agents))
  assert.equal(sweep.visited, 1)
  assert.equal(sweep.pinned, 0)
  assert.equal(appended.length, 0)
})

test('agent/created awaits pin and rethrows claw pin failures', async () => {
  const { home, clawA } = await clawHome()
  _internal.setDshHome(home)
  const session = {
    id: 'session-gggg-1111-2222-3333-444444444444',
    header: { cwd: clawA, agentPreset: 'wa-alpha' },
    events: [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
    append() { throw new Error('claw pin failed') },
  }
  const events = {}
  apply({
    connection: {
      fetch: {
        register() { return () => {} },
      },
    },
    systemPrompt: { section() { return () => {} } },
    on(name, fn) { events[name] = fn; return () => {} },
    effect() {},
  })
  await assert.rejects(
    () => events['agent/created']({ agent: { session } }),
    /claw pin failed/,
  )
})
