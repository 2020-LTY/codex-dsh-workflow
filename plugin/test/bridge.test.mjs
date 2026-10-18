import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startBridge, summarize } from '../src/server.mjs';
import { selectionView } from '../src/model-selection.mjs';
import { prepare } from '../scripts/prepare.mjs';
import { reassess } from '../scripts/reassess.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-control-'));
  const agents = new Map(), logs = new Map(), listeners = new Map();
  let admissions = 0, creations = 0, disposed = 0;
  const ctx = {
    get(name) { return options.services?.[name] ?? (name === 'llm' ? { resolveCallConfig: async selection => ({ reasoningEffort: 'high', ...selection }) } : undefined); },
    agents: { get: id => agents.get(id) },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    workspaceController: { create: async ({ path }) => ({ workspace: { workspaceId: 'workspace-fixture', path } }) },
    sessionQuery: { observeSession: async id => ({ events: logs.get(id), [Symbol.dispose]() { disposed++; } }) },
    sessionController: {
      agents: {
        serializeImageAdmission: async (_agent, fn) => fn(),
        selectForNextRequest(agent, selection) { logs.get(agent.id).push({ type: 'model/selection', seq: logs.get(agent.id).length, data: selection }); },
      },
      create: async ({ sessionId }) => {
        creations++; agents.set(sessionId, { id: sessionId, status: 'idle' }); logs.set(sessionId, []);
        return { sessionId, agentPreset: 'default' };
      },
      rename: async request => request,
      prompt: async ({ sessionId, requestId }) => {
        const events = logs.get(sessionId);
        if (events.some(e => e.data.source?.rpcId === requestId)) return { accepted: true };
        admissions++;
        agents.get(sessionId).status = 'running';
        events.push({ type: 'turn/start', seq: events.length, data: { turn: admissions } });
        events.push({ type: 'user/message', seq: events.length, data: { source: { kind: 'user', rpcId: requestId }, content: [] } });
        return { accepted: true };
      },
      cancel: async ({ sessionId }) => { agents.get(sessionId).status = 'idle'; return { cancelled: true }; },
      modelCatalog: async () => ({ routableProviders: ['fixture'], groups: [{ id: 'fixture', models: ['flash', 'pro'].map(id => ({ id, reasoning: { efforts: ['off', 'low', 'high', 'max'].map(id => ({ id })) } })) }] }),
    },
  };
  if (options.unsupported) delete ctx.sessionController.agents;
  const bridge = await startBridge(ctx, { port: 0, stateDir: dir, outputChars: 100 });
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (path, body, headers = {}) => {
    const response = await fetch(bridge.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bridge.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { code: response.status, body: await response.json() };
  };
  const create = async (options = {}) => {
    const packet = { requestId: randomUUID(), cwd: dir, title: '接口测试', ...options };
    const result = await call('/v1/sessions', packet);
    assert.equal(result.code, 200);
    return { id: result.body.sessionId, packet };
  };
  return { bridge, call, create, agents, logs, listeners, ctx, dir, counts: () => ({ admissions, creations, disposed }) };
}

test('HTTP capability management and resumable preparation use the supported Host services', async t => {
  const bundles = []; let installs = 0;
  const services = {
    pluginManager: {
      listBundles: async () => bundles, listPlugins: async () => [],
      inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'fixture-browser', version: '1.0.0', bundle: true }),
      installBundle: async (spec, options) => {
        assert.equal(spec, 'fixture-browser@1.0.0'); installs++;
        bundles.push({ name: 'fixture-browser', version: '1.0.0', description: 'Browser automation', installed: true, enabled: options.enabled, availability: 'profile', rows: [] });
        return { application: 'applied', bundle: 'fixture-browser', changed: true };
      },
      cancelInstall: async () => ({ status: 'not-running' }), setBundleEnabled: async () => ({}), setPluginEnabled: async () => ({}),
    },
    tools: { view: agent => { assert.ok(agent.id); return { visible: new Map(['browser_open', 'browser_click', 'browser_screenshot'].map(name => [name, {}])) }; }, wireSchemas: () => ({ schemas: [{ name: 'run_code' }] }), modeFor: () => 'ptc' },
  };
  const f = await fixture(t, { services });
  const call = async (method, path, body) => {
    const result = await f.call(path, method === 'GET' ? undefined : body);
    if (result.code !== 200) throw Object.assign(new Error(result.body.error), { status: result.code });
    return result.body;
  };
  const config = { taskType: 'browser', plugins: [{ spec: 'fixture-browser@1.0.0', enabled: true }] };
  const options = { apply: true, stateFile: join(f.dir, 'prepare-state.json'), call };
  const first = await prepare(config, options);
  assert.equal(first.status, 'configured-needs-session-smoke-test'); assert.equal(installs, 1);
  const second = await prepare(config, options); assert.equal(second.operations[0].requestId, first.operations[0].requestId); assert.equal(installs, 1);
  bundles[0].enabled = false;
  const drift = await prepare(config, options); assert.equal(drift.status, 'needs-attention'); assert.equal(installs, 1);
  bundles[0].enabled = true;
  const { id } = await f.create({ requirements: ['browser.navigate', 'browser.interact', 'browser.screenshot'] });
  const readback = await f.call(`/v1/sessions/${id}/capabilities`);
  assert.equal(readback.body.tools.length, 3); assert.deepEqual(readback.body.wireTools, ['run_code']);
  assert.ok(readback.body.requirements.every(row => row.state === 'registered-needs-smoke-test'));
  assert.equal((await f.call('/v1/health')).body.capabilities.pluginInstall, true);
  assert.equal((await f.call('/v1/sessions/foreign/capabilities')).code, 403);
});

test('per-round reassessment uses real HTTP readbacks without prompting or applying configuration', async t => {
  let names = ['read'];
  const f = await fixture(t, { services: {
    pluginManager: { listBundles: () => [], listPlugins: () => [] },
    tools: { view: () => ({ visible: new Map(names.map(name => [name, {}])) }) },
    agentPresets: { compositionInventory: () => [], remoteExportList: () => ({ presets: [{ id: 'standard', isDefault: true }] }) },
  } });
  const { id } = await f.create({ agentPreset: 'standard', modelSelection: { provider: 'fixture', model: 'flash', reasoningEffort: 'low' } });
  const call = async (method, path, payload) => {
    assert.ok(method === 'GET' || path === '/v1/capabilities/plan');
    const result = await f.call(path, method === 'GET' ? undefined : payload);
    if (result.code !== 200) throw new Error(result.body.error);
    return result.body;
  };
  const input = { taskId: 'fixture-task', roundId: 'first', phase: 'implementation', taskType: 'custom', requirements: ['files.read'], sessionId: id, currentPreset: 'standard',
    decisions: Object.fromEntries(['plugins', 'model', 'reasoning', 'preset'].map(key => [key, { action: 'keep', reason: '本轮读回支持沿用' }])) };
  const first = await reassess(input, { call });
  assert.equal(first.status, 'reviewed');
  names = [];
  const second = await reassess({ ...input, roundId: 'second', phase: 'check' }, { call, previous: first });
  assert.ok(second.delta.includes('toolNames'));
  assert.ok(second.findings.some(row => row.code === 'capability-gap'));
  assert.equal(f.counts().admissions, 0);
});

test('authentication, browser rejection, and foreign session protection', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/v1/health', undefined, { Authorization: 'Bearer wrong' })).code, 401);
  assert.equal((await f.call('/v1/health', undefined, { Origin: 'http://localhost' })).code, 403);
  assert.equal((await f.call('/v1/sessions/foreign/cancel', {})).code, 403);
  assert.equal((await f.call('/v1/sessions', { requestId: '__proto__', cwd: f.dir, title: 'x' })).code, 400);
});

test('concurrent creation retries publish only one session', async t => {
  const f = await fixture(t);
  const packet = { requestId: randomUUID(), cwd: f.dir, title: '同一任务' };
  const responses = await Promise.all([f.call('/v1/sessions', packet), f.call('/v1/sessions', packet)]);
  assert.equal(responses[0].body.sessionId, responses[1].body.sessionId);
  assert.equal(f.counts().creations, 1);
  assert.equal((await f.call('/v1/sessions', { ...packet, title: '另一任务' })).code, 409);
});

test('concurrent prompt retries admit once and changed text conflicts', async t => {
  const f = await fixture(t), { id } = await f.create();
  const packet = { requestId: randomUUID(), text: '执行一个明确任务' };
  const path = `/v1/sessions/${id}/prompt`;
  const results = await Promise.all([f.call(path, packet), f.call(path, packet)]);
  assert.ok(results.every(r => r.code === 200));
  assert.equal(f.counts().admissions, 1);
  assert.equal((await f.call(path, { ...packet, text: 'different' })).code, 409);
  assert.equal((await f.call(path, { ...packet, requestId: randomUUID() })).code, 409);
});

test('idle alone cannot settle queued work; completed turn requires receipt and idle', async t => {
  const f = await fixture(t), { id } = await f.create();
  const packet = { requestId: randomUUID(), text: 'task' };
  await f.call(`/v1/sessions/${id}/prompt`, packet);
  f.agents.get(id).status = 'idle';
  assert.equal((await f.call(`/v1/sessions/${id}/status`)).body.task.executionEnded, false);
  f.logs.get(id).push({ type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'secret reasoning' }, { type: 'text', text: 'x'.repeat(120) }] }, usage: { outputTokens: 3 } } });
  f.logs.get(id).push({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'FAIL' } } } });
  const status = (await f.call(`/v1/sessions/${id}/status`)).body.task;
  assert.equal(status.executionEnded, true);
  assert.equal(status.reason.kind, 'error');
  assert.equal(status.output.length, 100);
  assert.equal(status.outputTruncated, true);
  assert.equal(JSON.stringify(status).includes('secret reasoning'), false);
  assert.equal(status.acceptance, 'requires-independent-verification');
  assert.ok(f.counts().disposed > 0);
  f.agents.get(id).status = 'running';
  assert.equal((await f.call(`/v1/sessions/${id}/status`)).body.task.executionEnded, false);
});

test('desktop mode delegates interaction to ordinary desktop provider', async t => {
  const f = await fixture(t), { id } = await f.create();
  assert.equal(await f.listeners.get('approval/request')({ agent: f.agents.get(id) }, () => 'desktop-provider'), 'desktop-provider');
  assert.equal(await f.listeners.get('approval/request')({ agent: { id: 'manual-session' } }, () => 'manual-provider'), 'manual-provider');
});

test('API approvals are explicit, scoped, once-only and abortable', async t => {
  const f = await fixture(t), { id } = await f.create({ interactionMode: 'api' });
  const ac = new AbortController();
  const outcome = f.listeners.get('approval/request')({ agent: f.agents.get(id), toolName: 'bash', signal: ac.signal }, () => assert.fail('must not delegate'));
  const pending = (await f.call(`/v1/sessions/${id}/status`)).body.pending[0];
  assert.equal((await f.call(`/v1/sessions/${id}/answer`, { interactionId: pending.interactionId, decision: 'allow-all' })).code, 400);
  assert.equal((await f.call(`/v1/sessions/${id}/answer`, { interactionId: pending.interactionId, decision: 'allowed-once' })).code, 200);
  assert.equal(await outcome, 'allowed-once');
  assert.equal((await f.call(`/v1/sessions/${id}/answer`, { interactionId: pending.interactionId, decision: 'allowed-once' })).code, 409);
  const aborted = f.listeners.get('approval/request')({ agent: f.agents.get(id), signal: ac.signal }, () => {});
  ac.abort(); assert.equal(await aborted, 'cancelled');
});

test('question answers reject unknown labels and settle exact questions', async t => {
  const f = await fixture(t), { id } = await f.create({ interactionMode: 'api' });
  const outcome = f.listeners.get('user-questions/request')({ agent: f.agents.get(id), questions: [{ id: 'q', question: '选择', options: [{ label: 'A' }] }] }, () => assert.fail());
  const p = (await f.call(`/v1/sessions/${id}/status`)).body.pending[0];
  assert.equal((await f.call(`/v1/sessions/${id}/answer`, { interactionId: p.interactionId, answers: [{ id: 'q', selected: ['B'] }] })).code, 400);
  const answers = [{ id: 'q', selected: ['A'] }];
  assert.equal((await f.call(`/v1/sessions/${id}/answer`, { interactionId: p.interactionId, answers })).code, 200);
  assert.deepEqual(await outcome, { answers });
});

test('shutdown settles pending requests, closes port, removes credentials and listeners', async t => {
  const f = await fixture(t), { id } = await f.create({ interactionMode: 'api' });
  const outcome = f.listeners.get('approval/request')({ agent: f.agents.get(id) }, () => {});
  const question = f.listeners.get('user-questions/request')({ agent: f.agents.get(id), questions: [{ id: 'q', question: '?' }] }, () => {});
  const rejected = assert.rejects(question, /aborted/);
  await f.bridge.close();
  assert.equal(await outcome, 'cancelled'); await rejected;
  assert.equal(f.listeners.size, 0);
  await assert.rejects(readFile(join(f.dir, 'endpoint.json')), { code: 'ENOENT' });
  await assert.rejects(fetch(f.bridge.origin + '/v1/health'));
});

test('ledger retains ownership and request fingerprint across restarts', async t => {
  const f = await fixture(t), { id, packet } = await f.create();
  const prompt = { requestId: randomUUID(), text: 'task' };
  await f.call(`/v1/sessions/${id}/prompt`, prompt);
  await f.bridge.close();
  const bridge = await startBridge(f.ctx, { port: 0, stateDir: f.dir });
  t.after(() => bridge.close());
  const response = await fetch(bridge.origin + '/v1/sessions', { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(packet) });
  assert.equal((await response.json()).sessionId, id);
  assert.equal(f.counts().creations, 1);
});

test('missing receipt cannot be mistaken for an unrelated finished turn', () => {
  const result = summarize([{ type: 'turn/end', seq: 0, data: { turn: 1, reason: { kind: 'stop' } } }], randomUUID(), false, 100);
  assert.equal(result.executionEnded, false);
  assert.equal(result.receipt, false);
});

test('later continuation turns contribute output and must close before completion', () => {
  const key = randomUUID();
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: key } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
    { type: 'assistant/message', seq: 4, data: { turn: 2, message: { content: [{ type: 'text', text: '最终结果' }] } } },
  ];
  assert.equal(summarize(events, key, false, 100).executionEnded, false);
  events.push({ type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } });
  const result = summarize(events, key, false, 100);
  assert.equal(result.executionEnded, true);
  assert.equal(result.output, '最终结果');
  assert.equal(result.finalTurn, 2);
});

test('tool output is opt-in and bounded independently of reasoning', async t => {
  const f = await fixture(t), { id } = await f.create();
  await f.call(`/v1/sessions/${id}/prompt`, { requestId: randomUUID(), text: 'task' });
  f.logs.get(id).push({ type: 'tool/result', seq: 2, data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-test', isError: true, content: [{ type: 'text', text: 'x'.repeat(100) + 'failure' }] }] } } });
  assert.equal((await f.call(`/v1/sessions/${id}/status`)).body.task.recentToolOutputs, undefined);
  const outputs = (await f.call(`/v1/sessions/${id}/status?includeToolOutput=true`)).body.task.recentToolOutputs;
  assert.equal(outputs[0].isError, true);
  assert.equal(outputs[0].tail.length, 33);
  assert.ok(outputs[0].tail.endsWith('failure'));
});

test('approval operation lookup is pending-scoped and reports truncation', async t => {
  const f = await fixture(t), { id } = await f.create({ interactionMode: 'api' });
  f.logs.get(id).push({ type: 'tool/call', seq: 0, data: { name: 'bash', callId: 'call', arguments: 'x'.repeat(120) } });
  const outcome = f.listeners.get('approval/request')({ agent: f.agents.get(id), toolName: 'bash', callId: 'call' }, () => {});
  const p = (await f.call(`/v1/sessions/${id}/status`)).body.pending[0];
  const view = await f.call(`/v1/sessions/${id}/operation?interactionId=${p.interactionId}`);
  assert.equal(view.body.operation.truncated, true);
  assert.equal(view.body.operation.arguments.length, 100);
  await f.call(`/v1/sessions/${id}/answer`, { interactionId: p.interactionId, decision: 'rejected' });
  assert.equal(await outcome, 'rejected');
  assert.equal((await f.call(`/v1/sessions/${id}/operation?interactionId=${p.interactionId}`)).code, 409);
});

test('shipped client discovers endpoint and never prints its credential', async t => {
  const f = await fixture(t);
  const run = promisify(execFile);
  const result = await run(process.execPath, [fileURLToPath(new URL('../scripts/client.mjs', import.meta.url)), 'GET', '/v1/health'], { env: { ...process.env, DSH_CODEX_CONTROL_DIR: f.dir } });
  assert.equal(JSON.parse(result.stdout).transport, 'same-host-controllers');
  assert.equal(result.stdout.includes(f.bridge.token), false);
});

test('installed v4 direct tool message is summarized without a nested block', async t => {
  const f = await fixture(t), { id } = await f.create();
  await f.call(`/v1/sessions/${id}/prompt`, { requestId: randomUUID(), text: 'task' });
  f.logs.get(id).push({ type: 'tool/result', seq: 2, data: { message: { role: 'tool', toolCallId: 'actual-v4-call', content: [{ type: 'text', text: 'execution.json\ntask.json' }], isError: false } } });
  const result = await f.call(`/v1/sessions/${id}/status?includeToolOutput=true`);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.task.recentToolOutputs[0], { seq: 2, callId: 'actual-v4-call', isError: false, tail: 'execution.json\ntask.json', truncated: false });
});

test('explicit session model selection validates catalog and reads back without saving defaults', async t => {
  const f = await fixture(t);
  const selection = { provider: 'fixture', model: 'flash', reasoningEffort: 'low' };
  const { id } = await f.create({ modelSelection: selection });
  assert.deepEqual((await f.call(`/v1/sessions/${id}/model`)).body.next, selection);
  assert.deepEqual((await f.call('/v1/catalog')).body.capabilities.selectionScope, 'session');
  for (const invalid of [
    { ...selection, model: 'missing' }, { ...selection, provider: 'missing' },
    { ...selection, reasoningEffort: 'turbo' }, { model: 'flash' }, { ...selection, token: 'secret' },
  ]) {
    assert.equal((await f.call('/v1/sessions', { requestId: randomUUID(), cwd: f.dir, title: 'invalid', modelSelection: invalid })).code, 400);
  }
  assert.equal(f.counts().creations, 1);
  const prompt = { requestId: randomUUID(), text: 'task' };
  await f.call(`/v1/sessions/${id}/prompt`, prompt);
  assert.equal((await f.call(`/v1/sessions/${id}/status`)).body.task.modelVerified, null);
  const events = f.logs.get(id);
  events.push({ type: 'request/header', seq: events.length, data: { header: { config: { ...selection, apiKey: 'must-not-leak' } } } });
  const status = await f.call(`/v1/sessions/${id}/status`);
  assert.equal(status.body.task.modelVerified, true);
  assert.equal(JSON.stringify(status).includes('must-not-leak'), false);
  events.push({ type: 'request/header', seq: events.length, data: { header: { config: { ...selection, model: 'pro' } } } });
  assert.equal((await f.call(`/v1/sessions/${id}/status`)).body.task.modelVerified, false);
});

test('unsupported Host keeps default creation but rejects explicit selection', async t => {
  const f = await fixture(t, { unsupported: true });
  await f.create();
  assert.equal((await f.call('/v1/health')).body.capabilities.sessionModelSelection, false);
  assert.equal((await f.call('/v1/sessions', { requestId: randomUUID(), cwd: f.dir, title: 'explicit', modelSelection: { provider: 'fixture', model: 'flash' } })).code, 501);
});

test('idle model changes are owned, idempotent, conflict checked and never replay old settings', async t => {
  const f = await fixture(t), { id } = await f.create();
  const path = `/v1/sessions/${id}/model`;
  const body = { requestId: randomUUID(), modelSelection: { provider: 'fixture', model: 'pro', reasoningEffort: 'max' } };
  assert.equal((await f.call('/v1/sessions/foreign/model', body)).code, 403);
  assert.equal((await f.call(path, body)).code, 200);
  assert.equal((await f.call(path, { ...body, modelSelection: { ...body.modelSelection, reasoningEffort: 'low' } })).code, 409);
  const later = { requestId: randomUUID(), modelSelection: { provider: 'fixture', model: 'flash', reasoningEffort: 'off' } };
  assert.equal((await f.call(path, later)).code, 200);
  assert.equal((await f.call(path, body)).body.current.next.model, 'flash');
  const events = f.logs.get(id);
  events.push({ type: 'model/selection', seq: events.length, data: body.modelSelection });
  assert.equal((await f.call(`/v1/sessions/${id}/prompt`, { requestId: randomUUID(), text: 'task' })).code, 409);
  await f.call(path, { ...later, requestId: randomUUID() });
  await f.call(`/v1/sessions/${id}/prompt`, { requestId: randomUUID(), text: 'task' });
  assert.equal((await f.call(path, { ...body, requestId: randomUUID() })).code, 409);
  f.agents.get(id).status = 'idle';
  assert.equal((await f.call(path, { ...body, requestId: randomUUID() })).code, 409);
});

test('normalization cannot silently substitute a requested route or effort', async t => {
  const f = await fixture(t);
  f.ctx.get = () => ({ resolveCallConfig: async () => ({ provider: 'fixture', model: 'pro', reasoningEffort: 'max' }) });
  // 适配器捕获的是启动时的服务对象；重启模拟不同 Host 的解析行为。
  await f.bridge.close();
  const bridge = await startBridge(f.ctx, { port: 0, stateDir: f.dir });
  t.after(() => bridge.close());
  const response = await fetch(bridge.origin + '/v1/sessions', { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), cwd: f.dir, title: 'reject substitution', modelSelection: { provider: 'fixture', model: 'flash', reasoningEffort: 'low' } }) });
  assert.equal(response.status, 409);
  assert.equal(f.counts().creations, 0);
});

test('durable pending selection survives unmatched headers and retires only on exact use', () => {
  const choice = { provider: 'fixture', model: 'pro', reasoningEffort: 'max' };
  const events = [
    { type: 'model/selection', seq: 0, data: choice },
    { type: 'request/header', seq: 1, data: { header: { config: { ...choice, reasoningEffort: 'low' } } } },
  ];
  assert.deepEqual(selectionView(events).pending, choice);
  events.push({ type: 'request/header', seq: 2, data: { header: { config: choice } } });
  assert.deepEqual(selectionView(events), { next: choice, lastUsed: choice, pending: null });
});

test('selection intent and per-request expectation survive bridge restart', async t => {
  const f = await fixture(t), choice = { provider: 'fixture', model: 'flash', reasoningEffort: 'low' };
  const { id, packet } = await f.create({ modelSelection: choice });
  const prompt = { requestId: randomUUID(), text: 'task' };
  await f.call(`/v1/sessions/${id}/prompt`, prompt);
  await f.bridge.close();
  const bridge = await startBridge(f.ctx, { port: 0, stateDir: f.dir });
  t.after(() => bridge.close());
  const response = await fetch(bridge.origin + `/v1/sessions/${id}/status`, { headers: { Authorization: `Bearer ${bridge.token}` } });
  const value = await response.json();
  assert.deepEqual(value.modelSelection.requested, choice);
  assert.deepEqual(value.modelSelection.next, choice);
  assert.deepEqual(value.task.modelExpected, choice);
  const retry = await fetch(bridge.origin + '/v1/sessions', { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(packet) });
  assert.equal(retry.status, 200);
  assert.equal(f.counts().creations, 1);
});
