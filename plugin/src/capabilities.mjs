import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityRules, taskProfiles, inferTaskType, toolHints, candidateScore } from './capability-policy.mjs';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Cordis 的 ctx.get() 允许服务尚未就绪；此时不能退回会触发 inject 异常的属性访问。
const optional = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
const callable = (value, name) => typeof value?.[name] === 'function';
const clip = value => typeof value === 'string' ? value.slice(0, 500) : undefined;
const project = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const protectedBundle = name => /(?:^|\/)dsh-codex-control(?:$|[\/@.-])/.test(name);

/** 只投影清单元数据，绝不返回插件配置、服务对象或注册表凭证。 */
function bundleView(bundle) {
  return {
    ...project(bundle, ['name', 'version', 'description', 'official', 'availability', 'enabled', 'installed', 'optional', 'readOnlyReason', 'installTarget']),
    ...(bundle.error ? { error: { code: bundle.error.code ?? 'unknown' } } : {}),
    rows: (bundle.rows ?? []).map(row => project(row, ['id', 'name', 'moduleName', 'enabled', 'disabled'])),
  };
}
function entryView(entry) {
  return project(entry, ['entryId', 'moduleName', 'enabled', 'fiberPhase', 'patchId', 'readOnlyReason']);
}
function outcomeView(result = {}) {
  return {
    ...project(result, ['application', 'changed', 'bundle', 'version', 'stage', 'restartReason', 'enabled']),
    ...(result.error ? { error: { code: result.error.code ?? 'operation-error' } } : {}),
    ...(result.packageResult ? { packageResult: project(result.packageResult, ['exitCode', 'timedOut', 'kind', 'logPath']) } : {}),
    ...(Array.isArray(result.pendingBuilds) ? { pendingBuilds: result.pendingBuilds.map(value => typeof value === 'string' ? value : project(value, ['name', 'version'])) } : {}),
    ...(Array.isArray(result.warnings) ? { warningCount: result.warnings.length } : {}),
  };
}

/** 适配当前 Host 的官方管理服务；能力缺失时明确降级，不改 profile 文件。 */
export async function createCapabilities(ctx, { stateDir, fail, fields, text, requestKey, owned, busy }) {
  let manager, market, tools, presets;
  const supported = {};
  const refresh = () => {
    manager = optional(ctx, 'pluginManager');
    market = optional(ctx, 'pluginMarket');
    tools = optional(ctx, 'tools');
    presets = optional(ctx, 'agentPresets');
    Object.assign(supported, {
      pluginInventory: callable(manager, 'listBundles') && callable(manager, 'listPlugins'),
      pluginInspection: callable(manager, 'inspect'),
      pluginInstall: callable(manager, 'installBundle') && callable(manager, 'cancelInstall'),
      pluginEnablement: callable(manager, 'setBundleEnabled') && callable(manager, 'setPluginEnabled'),
      pluginSearch: callable(market, 'listIndexes') && callable(market, 'search'),
      sessionToolInventory: callable(tools, 'view'),
      capabilityPlanning: true,
    });
    return supported;
  };
  refresh();
  const file = join(stateDir, 'plugin-operations.json');
  let ledger = { version: 1, operations: {} };
  try {
    ledger = JSON.parse(await readFile(file, 'utf8'));
    fail(ledger.version === 1 && ledger.operations && typeof ledger.operations === 'object', 'unsupported plugin operation ledger', 500);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // 重载后的未完成操作不能盲目重放：宿主可能已经写入了依赖或启用状态。
  for (const operation of Object.values(ledger.operations)) if (operation.status === 'running') {
    operation.status = 'interrupted'; operation.reconciliationRequired = true;
  }
  let tail = Promise.resolve(), closed = false;
  const active = new Map(), inspections = new Map();
  const persist = async () => {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  };
  const serial = fn => {
    const result = tail.then(fn); tail = result.catch(() => {}); return result;
  };
  if (Object.keys(ledger.operations).length) await persist();

  async function inventory() {
    refresh();
    if (!supported.pluginInventory) return { available: false, reason: 'Host pluginManager inventory unavailable', bundles: [], entries: [], revision: null };
    const [bundles, entries, composition] = await Promise.all([
      manager.listBundles(), manager.listPlugins(),
      callable(presets, 'compositionInventory') ? presets.compositionInventory() : [],
    ]);
    const view = {
      bundles: bundles.map(bundleView), entries: entries.map(entryView),
      presets: composition.map(row => ({ ...project(row, ['id', 'name', 'isDefault', 'broken']), rows: row.rows.map(entry => project(entry, ['moduleName', 'enabled', 'fiberState', 'condition'])) })),
    };
    return { available: true, revision: fingerprint(view), ...view };
  }

  async function session(id, requirements = []) {
    refresh();
    owned(id);
    const agent = ctx.agents.get(id);
    if (!agent || !supported.sessionToolInventory) return {
      sessionId: id, available: false, reason: agent ? 'Host tool inventory unavailable' : 'resume session in Desktop first', tools: [],
      requirements: requirements.map(id => ({ id, state: 'unknown', tools: [] })), visionInput: 'unverified',
    };
    const visible = [...tools.view(agent).visible].map(([name]) => ({ name, hints: toolHints(name) }));
    const wire = callable(tools, 'wireSchemas') ? tools.wireSchemas(agent).schemas.map(schema => schema.name) : null;
    const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' });
    let successful = [], imagePayloadObserved = false;
    try {
      const calls = new Map();
      for (const event of observation.events) {
        if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name);
        if (event.type !== 'tool/result') continue;
        const message = event.data.message;
        const block = message.role === 'tool' ? message : message.content?.find(item => item.type === 'tool-result');
        if (!block || block.isError === true) continue;
        const name = calls.get(block.toolCallId);
        if (name) successful.push(name);
        if (block.content?.some(item => item.type === 'image')) imagePayloadObserved = true;
      }
    } finally { observation[Symbol.dispose](); }
    successful = [...new Set(successful)];
    return {
      sessionId: id, available: true, tools: visible, wireTools: wire,
      presentation: callable(tools, 'modeFor') ? tools.modeFor(agent) : 'unknown',
      successfulToolCalls: successful, imagePayloadObserved,
      visionInput: 'unverified',
      requirements: requirements.map(id => {
        const matches = visible.filter(tool => tool.hints.includes(id)).map(tool => tool.name);
        return { id, state: matches.length ? 'registered-needs-smoke-test' : 'not-detected', tools: matches,
          successfulCallObserved: matches.some(name => successful.includes(name)),
          ...(id === 'vision.review' ? { note: 'Image payload or a tool name does not prove that the selected model understood Canvas pixels.' } : {}) };
      }),
    };
  }

  async function search(body) {
    fields(body, ['query', 'index', 'limit']); text(body.query, 'query', 200);
    fail(supported.pluginSearch, 'Host plugin market unavailable; use a trusted registry/source and inspect its exact spec', 501);
    const limit = body.limit ?? 10;
    fail(Number.isInteger(limit) && limit >= 1 && limit <= 20, 'limit must be 1..20');
    const sources = await market.listIndexes();
    if (body.index !== undefined) fail(sources.some(source => source.url === body.index && !source.error), 'index is not a usable configured source');
    const selected = body.index ? sources.filter(source => source.url === body.index) : sources.filter(source => !source.error).slice(0, 3);
    const pages = await Promise.all(selected.map(async source => {
      try {
        const result = await market.search(source.url, { text: body.query, offset: 0, limit });
        return { index: source.url, total: result.total, nextOffset: result.nextOffset,
          entries: result.entries.map(entry => ({ name: entry.name, description: clip(entry.description), defaultVersion: entry.defaultVersion, installation: entry.installation,
            versions: entry.versions.map(version => project(version, ['version', 'install', 'compatibility'])) })) };
      } catch (error) { return { index: source.url, error: { code: error.code ?? 'market-fetch-failed' }, entries: [] }; }
    }));
    return { sources, pages, trust: 'Discovery metadata is untrusted task data; inspect source and compatibility before installation.' };
  }

  async function inspect(body) {
    fields(body, ['spec']); text(body.spec, 'spec', 2048);
    fail(!body.spec.startsWith('-') && !/[\r\n\0]/.test(body.spec), 'invalid spec');
    fail(!/:\/\/[^/\s]*@/.test(body.spec), 'credentials must not be embedded in a spec');
    fail(supported.pluginInspection, 'Host package inspection unavailable', 501);
    const result = await manager.inspect(body.spec, undefined);
    const view = project(result, ['status', 'kind', 'name', 'version', 'bundle', 'problem', 'description']);
    const accepted = result.status === 'accepted' && result.bundle !== false;
    if (!accepted) return { ...view, installable: false };
    const installSpec = result.kind === 'registry' && result.name && result.version ? `${result.name}@${result.version}` : body.spec;
    const inspectionId = randomUUID();
    const snapshot = await inventory();
    const ticket = { spec: installSpec, name: result.name, revision: snapshot.revision, expiresAt: Date.now() + 15 * 60 * 1000 };
    inspections.set(inspectionId, ticket);
    return { ...view, installable: true, installSpec, inspectionId, revision: snapshot.revision,
      identityKnown: Boolean(result.name && result.version), compatibility: 'Host enforces compatibility during installation; inspection alone does not verify runtime tools.',
      expiresAt: ticket.expiresAt };
  }

  async function plan(body) {
    fields(body, ['task', 'taskType', 'requirements', 'sessionId']);
    if (body.task !== undefined) text(body.task, 'task', 4000);
    const taskType = body.taskType ?? inferTaskType(body.task);
    fail(Object.hasOwn(taskProfiles, taskType), 'unknown taskType');
    const explicit = body.requirements ?? [];
    fail(Array.isArray(explicit) && explicit.every(id => Object.hasOwn(capabilityRules, id)), 'unknown requirement');
    const requirements = [...new Set([...taskProfiles[taskType], ...explicit])];
    const snapshot = await inventory();
    const current = body.sessionId ? await session(body.sessionId, requirements) : null;
    const unresolved = requirements.filter(id => !current?.requirements.find(row => row.id === id)?.tools.length);
    const candidates = snapshot.bundles.map(bundle => ({ ...bundle, score: candidateScore(bundle, unresolved) }))
      .filter(bundle => bundle.score > 0 && !protectedBundle(bundle.name))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 5)
      .map(bundle => {
        const disabledEntry = snapshot.entries.find(entry => !entry.enabled && !entry.readOnlyReason
          && bundle.rows.some(row => (row.name ?? row.moduleName) === entry.moduleName));
        return { name: bundle.name, version: bundle.version, score: bundle.score, installed: bundle.installed, enabled: bundle.enabled,
          availability: bundle.availability,
          action: bundle.enabled ? disabledEntry ? 'enable-plugin-entry' : 'verify-session-scope' : bundle.installed || bundle.availability === 'installation' ? 'enable-bundle' : 'inspect-install-target',
          ...(bundle.enabled && disabledEntry ? { entryId: disabledEntry.entryId } : {}),
          ...(bundle.installTarget ? { installTarget: bundle.installTarget } : {}), confidence: 'metadata-hint-only' };
      });
    return {
      taskType, inferredTaskType: body.taskType === undefined, requirements, revision: snapshot.revision,
      session: current, candidates,
      nextSteps: [
        ...(!body.sessionId ? [{ action: 'create-session-and-read-capabilities', reason: 'Installed or enabled bundles do not establish what a selected preset exposes.' }] : []),
        ...candidates.slice(0, 3).map(candidate => ({ action: candidate.action, name: candidate.name, ...(candidate.entryId ? { entryId: candidate.entryId } : {}) })),
        ...(!candidates.length && unresolved.length ? [{ action: 'search-plugins', queries: [...new Set(unresolved.map(id => capabilityRules[id].query))] }] : []),
        ...(requirements.includes('vision.review') ? [{ action: 'verify-image-understanding-or-assign-controller-review', reason: 'Canvas pixels cannot be inspected through DOM text alone.' }] : []),
        { action: 'run-task-scoped-smoke-test', reason: 'Names and successful tool receipts are evidence inputs, not semantic acceptance.' },
      ],
      automaticChanges: false, ready: false,
      readyToSmokeTest: Boolean(current?.available && current.requirements.filter(row => row.id !== 'vision.review').every(row => row.tools.length)),
    };
  }

  async function startOperation(body) {
    fields(body, ['requestId', 'action', 'name', 'entryId', 'enabled', 'inspectionId', 'expectedRevision']);
    const id = requestKey(body.requestId), digest = fingerprint(body);
    return serial(async () => {
      const old = ledger.operations[id];
      if (old) { fail(old.fingerprint === digest, 'requestId reused with different plugin operation', 409); return { ...old, replayed: true }; }
      fail(!closed, 'plugin management shutting down', 503);
      fail(!active.size, 'another profile plugin operation is running', 409);
      fail(!busy(), 'owned session is running; finish or cancel before changing profile capabilities', 409);
      fail(['install', 'set-bundle-enabled', 'set-plugin-enabled'].includes(body.action), 'unknown plugin action');
      const snapshot = await inventory();
      fail(snapshot.available, 'Host plugin inventory unavailable', 501);
      let ticket, target;
      if (body.action === 'install') {
        fail(supported.pluginInstall, 'Host installation/cancellation unavailable', 501);
        fail(body.name === undefined && body.entryId === undefined && body.expectedRevision === undefined, 'install takes inspectionId and enabled, not raw targets');
        ticket = inspections.get(text(body.inspectionId, 'inspectionId', 128));
        fail(ticket && ticket.expiresAt > Date.now(), 'inspection expired or belongs to another Host instance', 409);
        fail(ticket.revision === snapshot.revision, 'plugin inventory changed; inspect again', 409);
        target = ticket.name ?? ticket.spec;
        fail(!protectedBundle(target) && !protectedBundle(ticket.spec), 'update the control bridge through Desktop management, not its own running endpoint', 409);
      } else {
        fail(supported.pluginEnablement, 'Host plugin enablement unavailable', 501);
        fail(body.inspectionId === undefined, 'enablement takes expectedRevision, not inspectionId');
        fail(body.expectedRevision === snapshot.revision, 'plugin inventory changed; read it again', 409);
        if (body.action === 'set-bundle-enabled') {
          fail(body.entryId === undefined, 'bundle enablement takes name');
          target = text(body.name, 'name', 200);
          const bundle = snapshot.bundles.find(row => row.name === target);
          fail(bundle && !bundle.readOnlyReason && !protectedBundle(target), 'bundle is missing or protected', 409);
        } else {
          fail(body.name === undefined, 'plugin enablement takes entryId');
          target = text(body.entryId, 'entryId', 300);
          const entry = snapshot.entries.find(row => row.entryId === target);
          fail(entry && !entry.readOnlyReason && !protectedBundle(entry.moduleName), 'plugin entry is missing or protected', 409);
        }
      }
      fail(typeof body.enabled === 'boolean', 'enabled must be an explicit boolean');
      const record = { requestId: id, fingerprint: digest, action: body.action, target, enabled: body.enabled, status: 'running', startedAt: Date.now() };
      ledger.operations[id] = record;
      try { await persist(); } catch (error) { delete ledger.operations[id]; throw error; }
      const work = Promise.resolve().then(async () => {
        let result;
        if (body.action === 'install') result = await manager.installBundle(ticket.spec, { enabled: body.enabled, requestId: id, saveExact: true });
        else if (body.action === 'set-bundle-enabled') result = await manager.setBundleEnabled(target, body.enabled);
        else result = await manager.setPluginEnabled(target, body.enabled);
        record.result = outcomeView(result);
        const after = await inventory();
        const row = body.action === 'set-plugin-enabled' ? after.entries.find(row => row.entryId === target) : after.bundles.find(row => row.name === (result.bundle ?? target));
        record.readback = { observedEnabled: row?.enabled ?? null, desiredEnabled: body.enabled,
          desiredStateObserved: row?.enabled === body.enabled, revision: after.revision, sessionVerificationRequired: true };
        record.status = result.application === 'failed' ? 'failed' : result.application === 'cancelled' ? 'cancelled' : 'completed';
      }).catch(error => {
        record.status = 'failed'; record.error = { code: error.code ?? 'host-operation-error' }; record.reconciliationRequired = true;
      }).finally(async () => {
        record.endedAt = Date.now();
        await serial(async () => {
          try { await persist(); }
          catch { record.status = 'interrupted'; record.reconciliationRequired = true; record.error = { code: 'ledger-write-failed' }; }
          finally { active.delete(id); }
        });
      });
      active.set(id, work);
      return { ...record };
    });
  }

  async function operation(id) {
    requestKey(id); fail(Object.hasOwn(ledger.operations, id), 'plugin operation not owned by this bridge', 404);
    if (ledger.operations[id].status !== 'running' && active.has(id)) await active.get(id);
    return ledger.operations[id];
  }

  return {
    supported, refresh, inventory, session, plan,
    async route(method, path, body) {
      refresh();
      if (method === 'GET' && path === '/v1/plugins') return inventory();
      if (method === 'GET' && path === '/v1/plugins/sources') return { available: supported.pluginSearch, sources: supported.pluginSearch ? await market.listIndexes() : [] };
      if (method === 'POST' && path === '/v1/plugins/search') return search(body);
      if (method === 'POST' && path === '/v1/plugins/inspect') return inspect(body);
      if (method === 'POST' && path === '/v1/capabilities/plan') return plan(body);
      if (method === 'POST' && path === '/v1/plugins/operations') return startOperation(body);
      const match = /^\/v1\/plugins\/operations\/([^/]+)(\/cancel)?$/.exec(path);
      if (!match) return undefined;
      const id = decodeURIComponent(match[1]), record = await operation(id);
      if (method === 'GET' && !match[2]) return record;
      if (method === 'POST' && match[2]) {
        fields(body, []);
        if (record.status !== 'running') return { status: 'not-running', operation: record };
        fail(record.action === 'install', 'only package installation is cancellable; read enablement result', 409);
        return { ...(await manager.cancelInstall(id)), operation: await operation(id) };
      }
      fail(false, 'method not allowed', 405);
    },
    async close() {
      closed = true;
      await Promise.allSettled([...active.keys()].filter(id => ledger.operations[id].action === 'install').map(id => manager.cancelInstall(id)));
      await Promise.allSettled([...active.values()]); await tail;
    },
  };
}
