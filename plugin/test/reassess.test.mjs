import test from 'node:test';
import assert from 'node:assert/strict';
import { reassess } from '../scripts/reassess.mjs';

const keep = () => Object.fromEntries(['plugins', 'model', 'reasoning', 'preset'].map(key => [key, { action: 'keep', reason: '当前证据支持继续沿用，尚未出现需要调整的变化。' }]));
const config = () => ({ taskId: 'animation', roundId: 'round-1', phase: 'implementation', taskType: 'custom', sessionId: 'owned', currentPreset: 'standard', decisions: keep() });
function fixture() {
  const calls = [];
  const data = {
    health: { instanceId: 'host-1', pluginVersion: '0.4.2' },
    catalog: { models: { default: { provider: 'official', model: 'flash', reasoningEffort: 'high' }, routableProviders: ['official'], groups: [{ id: 'official', models: ['flash', 'pro'].map(id => ({ id, reasoning: { efforts: ['low', 'high'].map(id => ({ id })) } })) }] }, presets: { presets: [{ id: 'standard', isDefault: true }, { id: 'minimal' }] } },
    plan: { revision: 'revision-1', requirements: ['files.read'], session: { available: true, tools: [{ name: 'read' }], requirements: [{ id: 'files.read', tools: ['read'] }] }, candidates: [] },
    status: { requestId: 'request-1', agentStatus: 'idle', task: { state: 'ended', receipt: true, executionEnded: true, modelVerified: true, reason: { kind: 'completed' }, modelUsage: [{ seq: 3, selection: { provider: 'official', model: 'flash', reasoningEffort: 'high' } }], output: 'Do not print this model output', reasoning: 'private' } },
    model: { next: { provider: 'official', model: 'flash', reasoningEffort: 'high' } },
  };
  const call = async (method, path) => {
    calls.push({ method, path });
    assert.ok(method === 'GET' || method === 'POST' && path === '/v1/capabilities/plan', 'review attempted a mutation');
    if (path === '/v1/health') return structuredClone(data.health);
    if (path === '/v1/catalog') return structuredClone(data.catalog);
    if (path === '/v1/capabilities/plan') return structuredClone(data.plan);
    if (path.startsWith('/v1/sessions/owned/status')) return structuredClone(data.status);
    if (path === '/v1/sessions/owned/model') return structuredClone(data.model);
    throw new Error('Unexpected path: ' + path);
  };
  return { data, calls, call };
}

test('all stages refresh facts even when decisions and configuration stay unchanged', async () => {
  const f = fixture(); let previous = null;
  for (const [index, phase] of ['initial', 'implementation', 'debug', 'check', 'acceptance'].entries()) {
    const review = await reassess({ ...config(), phase, roundId: 'round-' + index }, { call: f.call, previous });
    assert.equal(review.status, 'reviewed'); assert.equal(review.automaticChanges, false);
    assert.equal(review.semanticAcceptance, 'not-evaluated');
    assert.deepEqual(review.nextActions, []); if (previous) assert.deepEqual(review.delta, []);
    previous = review;
  }
  assert.equal(f.calls.length, 25);
  assert.equal(JSON.stringify(previous).includes('Do not print'), false);
  assert.equal(JSON.stringify(previous).includes('private'), false);
});

test('an omitted decision stays unresolved instead of silently keeping or escalating a model', async () => {
  const f = fixture(), input = config(); delete input.decisions.reasoning;
  const review = await reassess(input, { call: f.call });
  assert.ok(review.blockers.includes('decision-required:reasoning'));
  assert.equal(review.desired.modelSelection.model, 'flash');
  assert.equal(review.nextActions.some(row => row.action === 'set-session-model'), false);
});

test('new failures and configuration drift are reviewed without reusing historical successful receipts', async () => {
  const f = fixture(); const first = await reassess(config(), { call: f.call });
  f.data.health.instanceId = 'host-2'; f.data.plan.revision = 'revision-2';
  f.data.plan.session = { available: true, tools: [], requirements: [{ id: 'files.read', tools: [] }], successfulToolCalls: ['read'] };
  f.data.status.task.reason = { kind: 'error' }; f.data.status.task.modelVerified = false;
  const next = await reassess({ ...config(), roundId: 'round-2', phase: 'debug', evidence: [{ id: 'A1', summary: '关键画面在窗口边缘发生裁切', source: 'checks/A1.png' }] }, { call: f.call, previous: first });
  assert.ok(next.delta.includes('instanceId')); assert.ok(next.delta.includes('toolNames'));
  assert.ok(next.findings.some(row => row.code === 'capability-gap'));
  assert.ok(next.findings.some(row => row.code === 'execution-error-needs-diagnosis'));
  assert.ok(next.findings.some(row => row.code === 'request-model-mismatch'));
  assert.equal(next.evidence[0].id, 'A1');
});

test('model and effort decisions are validated together against the fresh catalog and inherited user constraints', async () => {
  const f = fixture();
  const first = await reassess({ ...config(), constraints: { modelSelection: { model: 'flash' } } }, { call: f.call });
  const input = config(); input.decisions.model = { action: 'change', selection: { provider: 'official', model: 'pro' }, reason: '需要更复杂推理', evidenceIds: ['runtime.lifecycle'] };
  input.decisions.reasoning = { action: 'change', effort: 'max', reason: '本轮质量要求', evidenceIds: ['runtime.catalog'] };
  const next = await reassess(input, { call: f.call, previous: first });
  assert.ok(next.blockers.includes('explicit-model-constraint:model'));
  assert.ok(next.blockers.includes('reasoning-effort-unavailable'));
  assert.deepEqual(next.constraints, first.constraints);
});

test('a preset change requires a new session and preserves the task budget; running work blocks configuration changes', async () => {
  const f = fixture(); f.data.status.agentStatus = 'running'; f.data.status.task.executionEnded = false;
  const input = config(); input.decisions.preset = { action: 'new-session', id: 'minimal', reason: '缩小调试工具范围', evidenceIds: ['runtime.capabilities'] };
  const review = await reassess(input, { call: f.call });
  assert.ok(review.blockers.includes('wait-for-current-execution-to-settle'));
  assert.deepEqual(review.nextActions.find(row => row.action === 'create-new-session'), { action: 'create-new-session', preset: 'minimal', preserveTaskBudget: true });
  assert.ok(review.nextActions.some(row => row.action === 'reassess-after-configuration'));
});

test('changes need evidence; unknown evidence and cross-task history are refused', async () => {
  const f = fixture(), input = config();
  input.decisions.plugins = { action: 'prepare', reason: '缺少浏览器工具' };
  assert.ok((await reassess(input, { call: f.call })).blockers.includes('change-needs-evidence:plugins'));
  input.decisions.plugins.evidenceIds = ['unknown'];
  await assert.rejects(reassess(input, { call: f.call }), /Unknown evidence/);
  await assert.rejects(reassess(config(), { call: f.call, previous: { version: 1, taskId: 'another-task' } }), /another task/);
});

test('default model and historical images never become current-session or visual-understanding proof', async () => {
  const f = fixture(); f.data.model = { next: null, requested: null };
  f.data.plan.requirements.push('vision.review'); f.data.plan.session.imagePayloadObserved = true;
  const review = await reassess(config(), { call: f.call });
  assert.equal(review.snapshot.modelSource, 'default-not-session-readback');
  assert.ok(review.findings.some(row => row.code === 'session-model-unverified'));
  assert.ok(review.findings.some(row => row.code === 'visual-feedback-needs-verification'));
  assert.equal(review.semanticAcceptance, 'not-evaluated');
});

test('request-specific lifecycle is requested explicitly and unrelated prompt intervals remain flagged', async () => {
  const f = fixture(); f.data.status.task.intervalIncludesOtherInputs = true;
  const review = await reassess({ ...config(), requestId: 'request/one' }, { call: f.call });
  assert.ok(f.calls.some(row => row.path.endsWith('?requestId=request%2Fone')));
  assert.ok(review.findings.some(row => row.code === 'request-interval-includes-other-inputs'));
});

test('a cold session may have reviewed decisions while still being unready to execute', async () => {
  const f = fixture();
  f.data.plan.session = { available: false, tools: [], requirements: [{ id: 'files.read', tools: [] }] };
  f.data.model = { next: null, requested: { provider: 'official', model: 'flash', reasoningEffort: 'high' } };
  const review = await reassess(config(), { call: f.call });
  assert.equal(review.status, 'reviewed'); assert.equal(review.executionReadiness, 'needs-capabilities');
  assert.equal(review.snapshot.modelSource, 'requested-intent-only');
  assert.ok(review.nextActions.some(row => row.action === 'resume-or-create-session-and-read-capabilities'));
});
