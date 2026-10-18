import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { request } from './client.mjs';

/** 默认只规划；--apply 只执行任务文件明确选择的插件，不根据市场文案自动安装。 */
export async function prepare(config, { apply = false, stateFile, call = request, timeoutMs = 120000 } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('task JSON object required');
  const health = await call('GET', '/v1/health');
  if (!health.capabilities?.capabilityPlanning) throw new Error('Upgrade/reload dsh-codex-control 0.4.2+ before preparing capabilities.');
  const query = Object.fromEntries(['task', 'taskType', 'requirements', 'sessionId'].filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  const initial = await call('POST', '/v1/capabilities/plan', query);
  if (!apply) return { mode: 'plan', plan: initial };
  if (!stateFile) throw new Error('--apply requires a checkpoint state path');
  const selections = [...(config.plugins ?? []).map(plugin => ({ action: 'install', spec: plugin.spec, enabled: plugin.enabled ?? true })),
    ...(config.bundles ?? []).map(bundle => ({ action: 'set-bundle-enabled', name: bundle.name, enabled: bundle.enabled })),
    ...(config.entries ?? []).map(entry => ({ action: 'set-plugin-enabled', entryId: entry.entryId, enabled: entry.enabled }))];
  if (selections.length > 10) throw new Error('At most 10 explicit plugin selections per preparation');
  if (selections.some(selection => typeof selection.enabled !== 'boolean'
    || (selection.action === 'install' ? typeof selection.spec !== 'string' : typeof (selection.name ?? selection.entryId) !== 'string'))) throw new Error('invalid explicit plugin selection');
  const key = createHash('sha256').update(JSON.stringify({ query, selections })).digest('hex');
  let state = { version: 1, key, operations: [] };
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.version !== 1 || state.key !== key || !Array.isArray(state.operations)) throw new Error('Checkpoint belongs to another preparation; choose a different state path.');
  const save = async () => {
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); await rename(temp, stateFile);
  };
  const outcomes = [];
  for (const [index, selection] of selections.entries()) {
    const saved = state.operations[index] ?? { requestId: randomUUID() };
    let operation;
    try { operation = await call('GET', `/v1/plugins/operations/${saved.requestId}`); }
    catch (error) { if (error.status !== 404) throw error; }
    if (!operation) {
      if (selection.action === 'install') {
        // 先复用已安装项；同一任务重跑不会为启用而再次安装包。
        const inventory = await call('GET', '/v1/plugins');
        const exactName = selection.spec.match(/^(@[^/]+\/[^@]+|[^@/:]+)(?:@[^/]+)?$/)?.[1];
        const installed = inventory.bundles.find(bundle => bundle.name === exactName && bundle.installed);
        const requestedVersion = exactName ? selection.spec.slice(exactName.length + 1) : undefined;
        if (installed && (!requestedVersion || requestedVersion === installed.version)) {
          saved.packet = { requestId: saved.requestId, action: 'set-bundle-enabled', name: installed.name, enabled: selection.enabled, expectedRevision: inventory.revision };
        } else {
          const inspection = await call('POST', '/v1/plugins/inspect', { spec: selection.spec });
          if (!inspection.installable) throw new Error(`Plugin inspection refused: ${inspection.problem ?? 'unknown'}`);
          saved.packet = { requestId: saved.requestId, action: 'install', inspectionId: inspection.inspectionId, enabled: selection.enabled };
        }
      } else {
        const inventory = await call('GET', '/v1/plugins');
        saved.packet = { requestId: saved.requestId, ...selection, expectedRevision: inventory.revision };
      }
      state.operations[index] = saved; await save();
      operation = await call('POST', '/v1/plugins/operations', saved.packet);
    }
    const deadline = Date.now() + timeoutMs;
    while (operation.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      operation = await call('GET', `/v1/plugins/operations/${saved.requestId}`);
    }
    if (operation.status === 'running') {
      if (operation.action === 'install') await call('POST', `/v1/plugins/operations/${saved.requestId}/cancel`, {});
      operation = await call('GET', `/v1/plugins/operations/${saved.requestId}`);
    }
    saved.outcome = operation; await save(); outcomes.push(operation);
    if (operation.status !== 'completed' || operation.result?.application === 'restart-required' || operation.readback?.desiredStateObserved !== true) {
      return { mode: 'apply', status: 'needs-attention', operations: outcomes, next: 'Read the operation result; reconcile, reload, or create a fresh session. Do not blindly repeat an installation.' };
    }
  }
  const current = await call('GET', '/v1/plugins');
  const readback = outcomes.map(operation => {
    const target = operation.result?.bundle ?? operation.target;
    const row = operation.action === 'set-plugin-enabled' ? current.entries.find(entry => entry.entryId === target) : current.bundles.find(bundle => bundle.name === target);
    return { target, enabled: row?.enabled ?? null, matches: row?.enabled === operation.enabled
      && (!operation.result?.version || operation.result.version === row?.version) };
  });
  if (readback.some(row => !row.matches)) return { mode: 'apply', status: 'needs-attention', operations: outcomes, configurationReadback: readback,
    next: 'Configuration changed since the recorded operation; inspect the current state and create a new preparation rather than replaying old mutations.' };
  return { mode: 'apply', status: 'configured-needs-session-smoke-test', operations: outcomes, configurationReadback: readback, plan: await call('POST', '/v1/capabilities/plan', query) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, ...args] = process.argv.slice(2);
  try {
    if (!input || args.some(arg => arg !== '--apply')) throw new Error('Usage: node prepare.mjs task.json [--apply]');
    const config = JSON.parse(await readFile(input, 'utf8'));
    const result = await prepare(config, { apply: args.includes('--apply'), stateFile: input + '.state.json' });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'needs-attention') process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ error: error.message, status: error.status ?? null })); process.exitCode = 1; }
}
