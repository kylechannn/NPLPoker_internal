import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const directory = await mkdtemp(join(tmpdir(), 'npl-os-transport-'))
after(() => rm(directory, { recursive: true, force: true }))
for (const name of ['reconciler', 'sessionPuller', 'sessionUpdates', 'transportDiagnostics']) {
  const source = await readFile(new URL(`../src/realtime/${name}.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"./reconciler"', '"./reconciler.mjs"')
  await writeFile(join(directory, `${name}.mjs`), compiled)
}
const { createReconciler } = await import(pathToFileURL(join(directory, 'reconciler.mjs')))
const { createSessionPuller } = await import(pathToFileURL(join(directory, 'sessionPuller.mjs')))
const { sessionUpdateMatches, sessionCommandsNeedRefresh } = await import(pathToFileURL(join(directory, 'sessionUpdates.mjs')))
const { createTransportDiagnostics } = await import(pathToFileURL(join(directory, 'transportDiagnostics.mjs')))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('transport diagnostics bound the rolling window and ignore arbitrary labels and values', () => {
  let now = 0
  const metrics = createTransportDiagnostics(() => now)
  metrics.count('reconnects', 2)
  for (let i = 0; i < 1000; i++) { metrics.count('private-player-' + i); metrics.count('targets') }
  metrics.count('targets', Infinity); metrics.count('targets', -1)
  metrics.count('targets', 'PRIVATE-TOKEN')
  for (const ms of [100, 101, 300, 301, 1000, 1001, 3000, 3001, 10000, 10001]) metrics.duration(ms)
  metrics.duration(NaN)
  assert.deepEqual(metrics.snapshot().duration_buckets, [1, 2, 2, 2, 2, 1])
  assert.equal(metrics.snapshot().counters.targets, 1000)
  assert.equal(metrics.snapshot().counters.reconnects, 2)
  assert.equal(JSON.stringify(metrics.snapshot()).includes('PRIVATE'), false)
  now = 60 * 60000
  assert.equal(metrics.snapshot().counters.targets, 0)
  assert.deepEqual(metrics.snapshot().duration_buckets, [0, 0, 0, 0, 0, 0])
  metrics.count('retries'); now = 0
  assert.equal(metrics.snapshot().counters.retries, 0, 'clock rollback cannot retain future buckets')
})

test('one thousand coalesced targets stay in fifty bounded requests and fault retries remain intact', async () => {
  const metrics = createTransportDiagnostics()
  let flush; let retry; let calls = 0; let fail = true; const applied = []
  const puller = createSessionPuller(async update => {
    calls++; metrics.count('targeted_batches'); metrics.count('targets', update.sessionIds.length)
    if (fail) { fail = false; metrics.count('failed_pulls'); throw Error('temporary') }
  }, update => applied.push(...update.sessionIds), callback => { retry = callback; return () => { retry = undefined } },
  callback => { flush = callback; return () => { flush = undefined } })
  puller.setVenue(7)
  const pending = Array.from({length:1000}, (_, i) => puller.request(i + 1))
  const settled = Promise.allSettled(pending)
  flush(); await settled
  assert.equal(calls, 1); assert.equal(applied.length, 0)
  metrics.count('retries'); retry(); await new Promise(done => setImmediate(done))
  // The retained first batch plus all queued targets are delivered once.
  assert.equal(calls, 51); assert.equal(applied.length, 1000); assert.equal(new Set(applied).size, 1000)
  assert.equal(metrics.snapshot().counters.failed_pulls, 1)
  assert.equal(metrics.snapshot().counters.targets, 1020)
})

test('burst during an HTTP call waits for one trailing reconciliation without overlap', async () => {
  const gate = deferred(); let calls = 0; let active = 0; let maximum = 0
  const worker = createReconciler(async () => { calls++; maximum = Math.max(maximum, ++active); if (calls === 1) await gate.promise; active-- })
  const first = worker.request()
  const second = worker.request(); worker.request(); worker.request()
  assert.equal(calls, 1)
  gate.resolve(); await Promise.all([first, second])
  assert.equal(calls, 2); assert.equal(maximum, 1)
})

test('unmount/identity change fences a late response and pending work', async () => {
  const gate = deferred(); const applied = []
  const worker = createReconciler(async current => { await gate.promise; if (current()) applied.push('old session') })
  const done = worker.request(); worker.request(); worker.stop(); gate.resolve(); await done
  assert.deepEqual(applied, [])
})

test('a stopped/resumed owner never adopts the previous lifecycle response', async () => {
  const gate = deferred(); let calls = 0; const applied = []
  const worker = createReconciler(async current => { const n = ++calls; if (n === 1) await gate.promise; if (current()) applied.push(n) })
  const done = worker.request(); worker.stop(); worker.resume(); worker.request(); gate.resolve(); await done
  assert.deepEqual(applied, [2])
})

test('venue change discards old completion and never mixes targets', async () => {
  const gate = deferred(); const requests = []; const updates = []
  const puller = createSessionPuller(async update => { requests.push(update); if (requests.length === 1) await gate.promise }, update => updates.push(update))
  puller.setVenue(7); const done = puller.request(101); puller.request(102)
  puller.setVenue(8); puller.request(201); gate.resolve(); await done
  assert.deepEqual(requests, [{venueId:7,sessionIds:[101]}, {venueId:8,sessionIds:[201]}])
  assert.deepEqual(updates, [{venueId:8,sessionIds:[201]}])
})

test('failed HTTP pull retains its targets until a confirmed retry', async () => {
  const requests = []; const updates = []
  const puller = createSessionPuller(async update => { requests.push(update); if (requests.length === 1) throw Error('offline') }, update => updates.push(update))
  puller.setVenue(7); await assert.rejects(puller.request(101), /offline/)
  assert.deepEqual(updates, [])
  await puller.request(102)
  assert.deepEqual(new Set(requests[1].sessionIds), new Set([101,102])); assert.equal(updates.length, 1)
})

test('full reconnect catch-up dominates queued targeted signals', async () => {
  const gate = deferred(); const requests = []
  const puller = createSessionPuller(async update => { requests.push(update); if (requests.length === 1) await gate.promise }, () => {})
  puller.setVenue(7); const done = puller.request(101); puller.request(102); puller.request(); gate.resolve(); await done
  assert.equal(requests[1].sessionIds, null)
})

test('failed realtime HTTP delivery schedules recovery without another socket event', async () => {
  let retry; let calls = 0; const updates = []
  const puller = createSessionPuller(async () => { if (++calls === 1) throw Error('temporary HTTP failure') }, update => updates.push(update), callback => { retry = callback; return () => { retry = undefined } })
  puller.setVenue(7); await assert.rejects(puller.request(101))
  assert.equal(typeof retry, 'function'); retry(); await new Promise(done => setImmediate(done))
  assert.deepEqual(updates, [{venueId:7,sessionIds:[101]}]); assert.equal(calls,2)
})

test('leaving the venue cancels both queued work and a scheduled retry', async () => {
  let retry; let calls = 0
  const puller = createSessionPuller(async () => { calls++; throw Error('offline') }, () => assert.fail('unconfirmed response'), callback => { retry = callback; return () => { retry = undefined } })
  puller.setVenue(7); await assert.rejects(puller.request(101)); puller.setVenue(null)
  assert.equal(retry,undefined); await puller.request(); assert.equal(calls,1)
})

test('HostDesk matches cloud session IDs and accepts legacy/full catch-up events', () => {
  assert.equal(sessionUpdateMatches({detail:{sessionIds:[101]}},101), true)
  assert.equal(sessionUpdateMatches({detail:{sessionIds:[102]}},101), false)
  assert.equal(sessionUpdateMatches({detail:{sessionIds:null}},101), true)
  assert.equal(sessionUpdateMatches({},101), true)
})

test('one fixed batching window combines twenty phone signals into one request', async () => {
  let flush; const requests = []
  const puller = createSessionPuller(async update => requests.push(update), () => {}, undefined,
    callback => { flush = callback; return () => { flush = undefined } })
  puller.setVenue(7)
  const pending = Array.from({length:20}, (_, i) => puller.request(101+i))
  assert.equal(requests.length, 0)
  flush(); await Promise.all(pending)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionIds.length, 20)
})

test('a large burst drains batches of twenty and never requests a full venue', async () => {
  let flush; const requests = []
  const puller = createSessionPuller(async update => requests.push(update), () => {}, undefined,
    callback => { flush = callback; return () => { flush = undefined } })
  puller.setVenue(7)
  const pending = Array.from({length:43}, (_, i) => puller.request(101+i))
  flush(); await Promise.all(pending)
  assert.deepEqual(requests.map(row => row.sessionIds.length), [20,20,3])
  assert.equal(new Set(requests.flatMap(row => row.sessionIds)).size,43)
})

test('signals arriving during HTTP keep one trailing batch without an empty full pull', async () => {
  let flush; const requests = []; const gate = deferred()
  const puller = createSessionPuller(async update => { requests.push(update); if(requests.length===1) await gate.promise }, () => {}, undefined,
    callback => { flush = callback; return () => { flush = undefined } })
  puller.setVenue(7)
  const first = puller.request(101); flush()
  const second = puller.request(102)
  gate.resolve(); await first
  assert.equal(requests.length,1)
  flush(); await second
  assert.deepEqual(requests.map(row=>row.sessionIds),[[101],[102]])
})

test('venue switch cancels a scheduled batch before it can send old targets', async () => {
  let flush; const requests = []
  const puller = createSessionPuller(async update => requests.push(update), () => {}, undefined,
    callback => { flush = callback; return () => { flush = undefined } })
  puller.setVenue(7); const pending=puller.request(101); puller.setVenue(8); await pending
  assert.equal(flush,undefined); assert.deepEqual(requests,[])
})

test('mirror completion skips duplicate commands but legacy catch-up still reconciles', () => {
  assert.equal(sessionCommandsNeedRefresh({detail:{commandsNotified:true}}),false)
  assert.equal(sessionCommandsNeedRefresh({detail:{sessionIds:[101]}}),true)
  assert.equal(sessionCommandsNeedRefresh({}),true)
})
