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

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-control-'));
  const agents = new Map(), logs = new Map(), listeners = new Map();
  let admissions = 0, creations = 0, disposed = 0;
  const ctx = {
    agents: { get: id => agents.get(id) },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    workspaceController: { create: async ({ path }) => ({ workspace: { workspaceId: 'workspace-fixture', path } }) },
    sessionQuery: { observeSession: async id => ({ events: logs.get(id), [Symbol.dispose]() { disposed++; } }) },
    sessionController: {
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
      modelCatalog: async () => ({ groups: [] }),
    },
  };
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
