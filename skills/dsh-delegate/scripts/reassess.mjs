import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { request } from './client.mjs';

const dimensions = ['plugins', 'model', 'reasoning', 'preset'];
const phases = ['initial', 'implementation', 'debug', 'check', 'acceptance'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const selection = value => value ? pick(value, ['provider', 'model', 'reasoningEffort']) : null;

/** 每轮刷新事实，只记录和检查控制端决策；不安装、不切模型、不发送任务、不判定验收通过。 */
export async function reassess(config, { call = request, previous = null } = {}) {
  if (!config || !nonempty(config.taskId) || !nonempty(config.roundId) || !phases.includes(config.phase)) throw new Error('taskId, roundId and a valid phase are required');
  if (previous && (previous.version !== 1 || previous.taskId !== config.taskId)) throw new Error('Previous review belongs to another task or schema');
  const evidence = config.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.some(row => !nonempty(row.id) || !nonempty(row.summary)) || new Set(evidence.map(row => row.id)).size !== evidence.length) throw new Error('Evidence needs unique ids and nonempty summaries');
  const query = pick(config, ['task', 'taskType', 'requirements', 'sessionId']);
  const sessionPath = config.sessionId ? `/v1/sessions/${encodeURIComponent(config.sessionId)}` : null;
  const [health, catalog, plan, status, model] = await Promise.all([
    call('GET', '/v1/health'), call('GET', '/v1/catalog'), call('POST', '/v1/capabilities/plan', query),
    sessionPath ? call('GET', sessionPath + '/status' + (config.requestId ? `?requestId=${encodeURIComponent(config.requestId)}` : '')) : null,
    sessionPath ? call('GET', sessionPath + '/model') : null,
  ]);
  const roster = catalog.presets?.presets ?? [];
  const modelCatalog = {
    default: selection(catalog.models?.default), routableProviders: catalog.models?.routableProviders ?? [],
    groups: (catalog.models?.groups ?? []).map(group => ({ id: group.id, models: group.models.map(row => ({ id: row.id, efforts: row.reasoning?.efforts?.map(effort => effort.id) ?? [] })) })),
  };
  const observedModel = model?.pending ?? model?.next;
  const current = selection(observedModel ?? model?.requested ?? catalog.models?.default);
  const constraints = config.constraints ?? previous?.constraints ?? {};
  // 当前预设来自控制端创建记录；工具可见性独立读回，不能把默认预设当作当前会话预设。
  const declaredPreset = config.currentPreset ?? (sessionPath ? null : roster.find(row => row.isDefault)?.id ?? null);
  const lifecycle = status ? {
    requestId: status.requestId ?? null, agentStatus: status.agentStatus,
    ...pick(status.task, ['state', 'receipt', 'executionEnded', 'intervalIncludesOtherInputs', 'modelVerified']),
    reasonKind: status.task?.reason?.kind ?? null,
    modelUsage: (status.task?.modelUsage ?? []).map(row => ({ seq: row.seq, selection: selection(row.selection) })),
  } : null;
  const snapshot = {
    instanceId: health.instanceId, revision: plan.revision, sessionId: config.sessionId ?? null,
    requirements: [...plan.requirements].sort(), toolsAvailable: plan.session?.available ?? false,
    toolNames: (plan.session?.tools ?? []).map(row => row.name).sort(),
    model: current, modelSource: observedModel ? 'session-readback' : model?.requested ? 'requested-intent-only' : 'default-not-session-readback',
    declaredPreset, presetSource: config.currentPreset ? 'controller-creation-record' : sessionPath ? 'unknown' : 'catalog-default',
    catalog: modelCatalog, presets: roster.map(row => ({ id: row.id, isDefault: row.isDefault === true, broken: Boolean(row.broken) })),
  };
  const delta = previous ? Object.keys(snapshot).filter(key => !equal(snapshot[key], previous.snapshot?.[key])) : [];
  const findings = [], blockers = [], actions = [];
  const add = (code, detail) => findings.push({ code, ...detail });
  const missing = (plan.session?.requirements ?? []).filter(row => row.id !== 'vision.review' && !row.tools?.length).map(row => row.id);
  if (!sessionPath) actions.push({ action: 'create-session-and-read-capabilities' });
  else if (!snapshot.toolsAvailable) {
    add('session-tools-unavailable', {});
    actions.push({ action: 'resume-or-create-session-and-read-capabilities' });
  }
  if (missing.length) add('capability-gap', { requirements: missing });
  if (plan.requirements.includes('vision.review')) add('visual-feedback-needs-verification', { note: 'A screenshot receipt does not establish image understanding; record who reviews pixels.' });
  if (sessionPath && !declaredPreset) add('current-preset-unverified', {});
  if (sessionPath && !observedModel) {
    add('session-model-unverified', {});
    actions.push({ action: 'readback-or-explicitly-select-session-model' });
  }
  if (previous && !equal(constraints, previous.constraints ?? {})) add('constraints-changed-check-user-instruction', {});
  if (delta.length) add('runtime-changed', { fields: delta });
  if (lifecycle?.modelVerified === false) add('request-model-mismatch', {});
  if (lifecycle?.intervalIncludesOtherInputs) add('request-interval-includes-other-inputs', {});
  if (lifecycle?.reasonKind === 'error') add('execution-error-needs-diagnosis', {});
  const knownEvidence = new Set(['runtime.capabilities', 'runtime.catalog', 'runtime.model', 'runtime.lifecycle', 'runtime.delta', ...evidence.map(row => row.id)]);
  const decisions = {};
  for (const dimension of dimensions) {
    const choice = config.decisions?.[dimension];
    const allowed = dimension === 'plugins' ? ['keep', 'prepare', 'investigate'] : dimension === 'preset' ? ['keep', 'new-session', 'investigate'] : ['keep', 'change', 'investigate'];
    if (!choice || !allowed.includes(choice.action) || !nonempty(choice.reason)) { blockers.push(`decision-required:${dimension}`); continue; }
    const ids = choice.evidenceIds ?? [];
    if (!Array.isArray(ids) || ids.some(id => !knownEvidence.has(id))) throw new Error(`Unknown evidence reference for ${dimension}`);
    if (choice.action !== 'keep' && choice.action !== 'investigate' && !ids.length) blockers.push(`change-needs-evidence:${dimension}`);
    decisions[dimension] = { ...pick(choice, ['action', 'reason', 'selection', 'effort', 'id']), evidenceIds: ids };
    if (choice.action === 'investigate') blockers.push(`investigation-required:${dimension}`);
  }
  const desired = { ...current };
  if (decisions.model?.action === 'change') {
    if (!nonempty(decisions.model.selection?.provider) || !nonempty(decisions.model.selection?.model)) blockers.push('model-selection-required');
    else Object.assign(desired, pick(decisions.model.selection, ['provider', 'model']));
  }
  if (decisions.reasoning?.action === 'change') {
    if (!nonempty(decisions.reasoning.effort)) blockers.push('reasoning-effort-required');
    else desired.reasoningEffort = decisions.reasoning.effort;
  }
  const chosen = modelCatalog.groups.find(group => group.id === desired.provider)?.models.find(row => row.id === desired.model);
  if (!chosen || !modelCatalog.routableProviders.includes(desired.provider)) blockers.push('model-unavailable');
  else if (desired.reasoningEffort !== undefined && !chosen.efforts.includes(desired.reasoningEffort)) blockers.push('reasoning-effort-unavailable');
  const desiredPreset = decisions.preset?.action === 'new-session' ? decisions.preset.id : declaredPreset;
  if (decisions.preset?.action === 'new-session' && !nonempty(desiredPreset)) blockers.push('preset-id-required');
  if (desiredPreset && !roster.some(row => row.id === desiredPreset && !row.broken)) blockers.push('preset-unavailable');
  for (const [key, value] of Object.entries(constraints.modelSelection ?? {})) if (desired[key] !== value) blockers.push(`explicit-model-constraint:${key}`);
  if (constraints.preset && desiredPreset !== constraints.preset) blockers.push('explicit-preset-constraint');
  const modelChanged = current && !equal(current, desired);
  const pluginsChanged = decisions.plugins?.action === 'prepare';
  const presetChanged = decisions.preset?.action === 'new-session';
  if (pluginsChanged) actions.push({ action: 'prepare-explicit-plugin-selections' });
  if (presetChanged) actions.push({ action: 'create-new-session', preset: desiredPreset, preserveTaskBudget: true });
  if (modelChanged) actions.push({ action: sessionPath && !presetChanged ? 'set-session-model' : 'select-model-at-session-creation', selection: desired });
  if (pluginsChanged || modelChanged || presetChanged) {
    if (lifecycle && (lifecycle.agentStatus === 'running' || (lifecycle.state !== 'created' && lifecycle.executionEnded !== true))) blockers.push('wait-for-current-execution-to-settle');
    actions.push({ action: 'reassess-after-configuration', reason: 'Configuration intent is not target-session tool or model execution evidence.' });
  }
  const executionReadiness = blockers.length ? 'blocked' : pluginsChanged || modelChanged || presetChanged ? 'configuration-change-pending'
    : !sessionPath ? 'needs-session' : !snapshot.toolsAvailable || missing.length ? 'needs-capabilities'
      : !observedModel || !declaredPreset ? 'needs-configuration-readback' : 'ready-for-task-scoped-smoke-test';
  return {
    version: 1, taskId: config.taskId, roundId: config.roundId, phase: config.phase, assessedAt: new Date().toISOString(),
    previousRoundId: previous?.roundId ?? null, status: blockers.length ? 'needs-attention' : 'reviewed',
    snapshot, delta, lifecycle, findings, decisions, blockers: [...new Set(blockers)],
    constraints, evidence: evidence.map(row => pick(row, ['id', 'summary', 'source'])),
    desired: { modelSelection: desired, preset: desiredPreset }, nextActions: actions, executionReadiness,
    capabilityPlan: plan,
    automaticChanges: false, semanticAcceptance: 'not-evaluated',
    receiptScope: 'Capability tool receipts are session history; lifecycle/modelUsage are from the selected request interval, which may include later inputs.',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [input, extra] = process.argv.slice(2);
    if (!input || extra) throw new Error('Usage: node reassess.mjs round.json');
    const config = JSON.parse(await readFile(input, 'utf8'));
    const previous = config.previousReview ? JSON.parse(await readFile(config.previousReview, 'utf8')) : null;
    const result = await reassess(config, { previous });
    const output = input + '.review.json', temp = output + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, output);
    console.log(JSON.stringify({ reviewFile: output, status: result.status, executionReadiness: result.executionReadiness, delta: result.delta, findings: result.findings, blockers: result.blockers, nextActions: result.nextActions }));
    if (result.status === 'needs-attention') process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ error: error.message, status: error.status ?? null })); process.exitCode = 1; }
}
