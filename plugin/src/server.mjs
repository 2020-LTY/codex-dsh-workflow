import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { modelAdapter, pickSelection, matchesSelection, selectionView } from './model-selection.mjs';
import { createCapabilities } from './capabilities.mjs';
import { capabilityRules } from './capability-policy.mjs';

const pluginVersion = '0.5.0';

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(ok, message, status = 400) {
  if (!ok) throw new ApiError(status, message);
}
function text(value, label, max = 4096) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `invalid ${label}`);
  return value;
}
function fields(body, allowed) {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'JSON object required');
  requireValue(Object.keys(body).every(k => allowed.includes(k)), 'unknown request field');
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function requestKey(value) {
  text(value, 'requestId', 128);
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'requestId must be a UUID');
  return value;
}

/** 分别读取 v4 的 tool 消息和旧版 user/tool-result 消息，不混合两种字段。 */
function toolOutput(message, limit, seq) {
  let block;
  if (message.role === 'tool') block = message;
  else {
    requireValue(message.role === 'user' && message.content?.[0]?.type === 'tool-result', 'unsupported tool result message', 500);
    block = message.content[0];
  }
  const value = block.content.filter(p => p.type === 'text').map(p => p.text).join('');
  return { seq, callId: block.toolCallId, isError: block.isError === true, tail: value.slice(-limit), truncated: value.length > limit };
}

/** 仅从日志提取任务区间的文本和数值，不向调用方返回思考或完整代码。 */
export function summarize(events, requestId, running, limit) {
  const receipt = events.findIndex(e => e.type === 'user/message' && e.data.source?.rpcId === requestId);
  if (receipt < 0) return { state: 'awaiting-receipt', receipt: false, executionEnded: false };
  let start = receipt;
  while (start > 0 && events[start].type !== 'turn/start') start--;
  const turn = events[start].type === 'turn/start' ? events[start].data.turn : undefined;
  const slice = events.slice(receipt);
  const lastLifecycle = slice.findLast(e => e.type === 'turn/start' || e.type === 'turn/end');
  const ended = lastLifecycle?.type === 'turn/end';
  const messages = slice.filter(e => e.type === 'assistant/message');
  const last = messages.at(-1);
  const content = last?.data.message?.content;
  const output = Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('') : '';
  const usage = {};
  for (const e of messages) for (const [k, v] of Object.entries(e.data.usage ?? {})) {
    if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v;
  }
  const calls = slice.filter(e => e.type === 'tool/call');
  const otherInputs = slice.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user' && e.data.source.rpcId !== requestId);
  return {
    state: ended ? (running ? 'turn-ended-agent-busy' : 'ended') : 'running',
    receipt: true, executionEnded: ended && !running,
    acceptance: 'requires-independent-verification',
    intervalIncludesOtherInputs: otherInputs.length > 0,
    fromSeq: events[receipt].seq, throughSeq: slice.at(-1)?.seq,
    turn, finalTurn: lastLifecycle?.data.turn ?? null, reason: ended ? lastLifecycle.data.reason : null,
    steps: messages.length, toolCalls: calls.length,
    latestTool: calls.at(-1)?.data.name ?? null,
    usage: Object.keys(usage).length ? usage : null,
    output: output.slice(0, limit), outputTruncated: output.length > limit,
  };
}

/** 创建受认证的本机接口。ctx 必须来自实际 DSH Host，测试可提供行为替身。 */
export async function startBridge(ctx, config = {}) {
  for (const [service, methods] of Object.entries({ sessionController: ['create', 'rename', 'prompt', 'cancel', 'modelCatalog'], workspaceController: ['create'], sessionQuery: ['observeSession'], agents: ['get'] })) {
    requireValue(ctx[service] && methods.every(method => typeof ctx[service][method] === 'function'), `unsupported Host service: ${service}`, 500);
  }
  fields(config, ['port', 'stateDir', 'maxBodyBytes', 'outputChars']);
  const port = config.port ?? 3189;
  const maxBody = config.maxBodyBytes ?? 262144;
  const outputChars = config.outputChars ?? 6000;
  requireValue(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid port');
  requireValue(Number.isInteger(maxBody) && maxBody >= 1024 && maxBody <= 4194304, 'invalid maxBodyBytes');
  requireValue(Number.isInteger(outputChars) && outputChars >= 100 && outputChars <= 50000, 'invalid outputChars');
  if (config.stateDir !== undefined) text(config.stateDir, 'stateDir');
  const stateDir = resolve(config.stateDir ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'codex-control'));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = join(stateDir, 'ownership.json');
  let state = { version: 1, sessions: {}, creates: {} };
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    requireValue(state.version === 1 && state.sessions && state.creates, 'unsupported ownership ledger', 500);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  let closed = false;
  let tail = Promise.resolve();
  const pending = new Map();
  const requests = new Set();
  const stop = new AbortController();
  const models = modelAdapter(ctx);
  const capabilities = { sessionModelSelection: models.supported, modelReadback: true, selectionScope: 'session', adapter: 'desktop-0.2.1-rc.1' };
  const validateSelection = selection => {
    fields(selection, ['provider', 'model', 'reasoningEffort']);
    text(selection.provider, 'provider', 200);
    text(selection.model, 'model', 200);
    if (selection.reasoningEffort !== undefined) text(selection.reasoningEffort, 'reasoningEffort', 100);
  };
  const serialize = fn => {
    const job = tail.then(() => { requireValue(!closed, 'bridge shutting down', 503); return fn(); });
    tail = job.catch(() => {});
    return job;
  };
  const save = async () => {
    const temp = `${stateFile}.${instanceId}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, stateFile);
  };
  const owned = id => {
    text(id, 'sessionId');
    requireValue(Object.hasOwn(state.sessions, id), 'session not owned by this bridge', 403);
    return state.sessions[id];
  };
  const extensions = await createCapabilities(ctx, {
    stateDir, fail: requireValue, fields, text, requestKey, owned,
    busy: () => Object.keys(state.sessions).some(id => ctx.agents.get(id)?.status === 'running'),
  });
  Object.assign(capabilities, extensions.supported);
  const status = async (id, requestId, includeToolOutput = false) => {
    const record = owned(id);
    const observation = await ctx.sessionQuery.observeSession(id, { signal: stop.signal, projectionMode: 'none' });
    try {
      const current = requestId ?? record.latestRequest;
      if (current !== undefined) requireValue(Object.hasOwn(record.requests, current), 'unknown requestId', 404);
      const agent = ctx.agents.get(id);
      const events = [...observation.events];
      const task = current ? summarize(events, current, agent?.status === 'running', outputChars) : { state: 'created', executionEnded: false };
      const view = selectionView(events);
      const requested = current ? record.requestModels?.[current] ?? null : record.modelSelection ?? null;
      const headers = task.receipt ? events.filter(e => e.seq >= task.fromSeq && e.type === 'request/header') : [];
      task.modelUsage = headers.map(e => ({ seq: e.seq, selection: pickSelection(e.data.header?.config) }));
      task.modelExpected = requested;
      task.modelVerified = requested && headers.length ? task.modelUsage.every(h => matchesSelection(h.selection, requested)) : null;
      if (includeToolOutput && task.receipt) {
        task.recentToolOutputs = events.filter(e => e.seq >= task.fromSeq && e.type === 'tool/result').slice(-3).map(e => {
          return toolOutput(e.data.message, Math.floor(outputChars / 3), e.seq);
        });
      }
      return {
        sessionId: id, requestId: current ?? null,
        agentStatus: agent?.status ?? 'inactive', interactionMode: record.interactionMode,
        modelSelection: { requested: record.modelSelection ?? null, ...view },
        task,
        pending: [...pending.values()].filter(p => p.sessionId === id).map(p => p.view),
      };
    } finally { observation[Symbol.dispose](); }
  };

  const hold = (kind, request, next) => {
    const id = request.agent?.id;
    if (!id || !Object.hasOwn(state.sessions, id) || state.sessions[id].interactionMode !== 'api') return next();
    if (closed || request.signal?.aborted) return kind === 'approval' ? 'cancelled' : Promise.reject(new Error('interaction aborted'));
    const interactionId = randomUUID();
    return new Promise((resolveAnswer, rejectAnswer) => {
      const finish = (answer, error) => {
        pending.delete(interactionId);
        request.signal?.removeEventListener('abort', abort);
        if (error) rejectAnswer(error); else resolveAnswer(answer);
      };
      const abort = () => finish(kind === 'approval' ? 'cancelled' : undefined, kind === 'questions' ? new Error('interaction aborted') : undefined);
      const view = kind === 'approval'
        ? { interactionId, kind, toolName: request.toolName, reason: request.reason, callId: request.callId }
        : { interactionId, kind, questions: structuredClone(request.questions) };
      pending.set(interactionId, { sessionId: id, kind, request, view, finish, abort });
      request.signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const answer = (id, body) => {
    fields(body, ['interactionId', 'decision', 'answers']);
    const p = pending.get(text(body.interactionId, 'interactionId'));
    requireValue(p && p.sessionId === id, 'interaction absent or already settled', 409);
    if (p.kind === 'approval') {
      requireValue(body.answers === undefined && ['allowed-once', 'rejected'].includes(body.decision), 'invalid approval decision');
      p.finish(body.decision);
    } else {
      requireValue(body.decision === undefined && Array.isArray(body.answers) && body.answers.length === p.request.questions.length, 'invalid answers');
      const seen = new Set();
      for (const item of body.answers) {
        fields(item, ['id', 'selected', 'custom']);
        const question = p.request.questions.find(q => q.id === item.id);
        requireValue(question && !seen.has(item.id), 'unknown or duplicate question');
        seen.add(item.id);
        requireValue(Array.isArray(item.selected) && item.selected.every(v => typeof v === 'string' && question.options?.some(o => o.label === v)), 'invalid selected option');
        requireValue(new Set(item.selected).size === item.selected.length && (question.multiSelect || item.selected.length <= 1), 'invalid selection count');
        if (item.custom !== undefined) text(item.custom, 'custom', 20000);
        requireValue(item.selected.length || item.custom?.trim(), 'empty answer');
      }
      p.finish({ answers: body.answers });
    }
    return { answered: true };
  };

  async function route(method, path, body, query) {
    if (method === 'GET' && path === '/v1/health') return { protocol: 1, pluginVersion, instanceId, transport: 'same-host-controllers', capabilities: { ...capabilities, ...extensions.refresh() } };
    if (method === 'GET' && path === '/v1/catalog') {
      const presets = ctx.get?.('agentPresets');
      return { models: await ctx.sessionController.modelCatalog(), presets: presets ? await presets.remoteExportList() : null, capabilities: { ...capabilities, ...extensions.refresh() } };
    }
    if (path.startsWith('/v1/plugins') || path === '/v1/capabilities/plan') {
      const result = await extensions.route(method, path, body);
      requireValue(result !== undefined, 'route not found', 404);
      return result;
    }
    if (method === 'GET' && path === '/v1/sessions') return { sessions: Object.entries(state.sessions).map(([sessionId, r]) => ({ sessionId, title: r.title, cwd: r.cwd, interactionMode: r.interactionMode })) };
    if (method === 'POST' && path === '/v1/sessions') return serialize(async () => {
      fields(body, ['requestId', 'cwd', 'title', 'agentPreset', 'interactionMode', 'modelSelection', 'requirements']);
      const key = requestKey(body.requestId);
      const cwd = text(body.cwd, 'cwd');
      requireValue(isAbsolute(cwd) && (await stat(cwd)).isDirectory(), 'cwd must be an existing absolute directory');
      text(body.title, 'title', 200);
      if (body.agentPreset !== undefined) text(body.agentPreset, 'agentPreset', 200);
      if (body.requirements !== undefined) requireValue(Array.isArray(body.requirements) && body.requirements.every(id => Object.hasOwn(capabilityRules, id)), 'unknown requirement');
      const interactionMode = body.interactionMode ?? 'desktop';
      requireValue(['api', 'desktop'].includes(interactionMode), 'invalid interactionMode');
      const fingerprint = hash(body);
      let create = state.creates[key];
      if (create) {
        requireValue(create.hash === fingerprint, 'requestId reused with different create payload', 409);
        if (create.result) return create.result;
      }
      else {
        if (body.modelSelection !== undefined) {
          validateSelection(body.modelSelection);
          // 在创建会话前拒绝无效选择；省略时保留旧版的默认行为。
          await models.resolve(body.modelSelection, requireValue);
        }
        const sessionId = `session-${randomUUID()}`;
        create = state.creates[key] = { hash: fingerprint, sessionId };
        state.sessions[sessionId] = { cwd, title: body.title, interactionMode, requests: {}, ...(body.requirements ? { requirements: body.requirements } : {}) };
        await save();
      }
      const workspace = await ctx.workspaceController.create({ path: cwd });
      const created = await ctx.sessionController.create({ workspaceId: workspace.workspace.workspaceId, sessionId: create.sessionId, ...(body.agentPreset ? { agentPreset: body.agentPreset } : {}) });
      if (body.modelSelection !== undefined) {
        validateSelection(body.modelSelection);
        const selected = await models.resolve(body.modelSelection, requireValue);
        await models.install(create.sessionId, selected, requireValue);
        state.sessions[create.sessionId].modelSelection = selected;
        const installed = (await status(create.sessionId)).modelSelection.next;
        requireValue(installed && matchesSelection(installed, selected), 'model selection readback mismatch', 409);
      }
      await ctx.sessionController.rename({ sessionId: create.sessionId, title: body.title });
      create.result = { ...created, workspaceId: workspace.workspace.workspaceId, interactionMode, ...(body.modelSelection === undefined ? {} : { modelSelection: (await status(create.sessionId)).modelSelection }), ...(body.requirements ? { capabilityReadback: await extensions.session(create.sessionId, body.requirements) } : {}) };
      await save();
      return create.result;
    });
    const match = /^\/v1\/sessions\/([^/]+)\/(status|prompt|cancel|answer|operation|model|capabilities)$/.exec(path);
    requireValue(match, 'route not found', 404);
    const id = decodeURIComponent(match[1]);
    const record = owned(id);
    if (method === 'GET' && match[2] === 'capabilities') return extensions.session(id, record.requirements ?? []);
    if (method === 'GET' && match[2] === 'model') return (await status(id)).modelSelection;
    if (method === 'POST' && match[2] === 'model') return serialize(async () => {
      fields(body, ['requestId', 'modelSelection']);
      const key = requestKey(body.requestId);
      validateSelection(body.modelSelection);
      const fingerprint = hash(body);
      const previous = record.modelRequests?.[key];
      if (previous) {
        requireValue(previous.hash === fingerprint, 'requestId reused with different model payload', 409);
        return { ...previous.result, replayed: true, current: (await status(id)).modelSelection };
      }
      requireValue(ctx.agents.get(id)?.status !== 'running' && ![...pending.values()].some(p => p.sessionId === id), 'session busy', 409);
      if (record.latestRequest) requireValue((await status(id)).task.executionEnded, 'prior prompt lacks completed receipt', 409);
      const selected = await models.resolve(body.modelSelection, requireValue);
      await models.install(id, selected, requireValue);
      const current = (await status(id)).modelSelection;
      requireValue(current.next && matchesSelection(current.next, selected), 'model selection readback mismatch', 409);
      record.modelSelection = selected;
      const result = { selected, scope: 'session', verified: true };
      (record.modelRequests ??= {})[key] = { hash: fingerprint, result };
      await save();
      return result;
    });
    if (method === 'GET' && match[2] === 'operation') {
      const p = pending.get(query.get('interactionId'));
      requireValue(p && p.sessionId === id && p.kind === 'approval', 'approval absent or already settled', 409);
      const observation = await ctx.sessionQuery.observeSession(id, { signal: stop.signal, projectionMode: 'none' });
      try {
        const event = p.request.callId === undefined ? undefined : [...observation.events].findLast(e => e.type === 'tool/call' && e.data.callId === p.request.callId);
        return { interactionId: p.view.interactionId, toolName: p.request.toolName, reason: p.request.reason, operation: event ? { callId: event.data.callId, arguments: event.data.arguments.slice(0, outputChars), truncated: event.data.arguments.length > outputChars } : null };
      } finally { observation[Symbol.dispose](); }
    }
    if (method === 'GET' && match[2] === 'status') return status(id, query.get('requestId') ?? undefined, query.get('includeToolOutput') === 'true');
    if (method === 'POST' && match[2] === 'cancel') {
      fields(body, []);
      return ctx.sessionController.cancel({ sessionId: id });
    }
    if (method === 'POST' && match[2] === 'answer') return answer(id, body);
    if (method === 'POST' && match[2] === 'prompt') return serialize(async () => {
      fields(body, ['requestId', 'text', 'clientTimeZone']);
      const key = requestKey(body.requestId);
      text(body.text, 'text', maxBody);
      if (body.clientTimeZone !== undefined) { text(body.clientTimeZone, 'clientTimeZone', 100); new Intl.DateTimeFormat('en', { timeZone: body.clientTimeZone }); }
      const fingerprint = hash(body);
      if (Object.hasOwn(record.requests, key)) requireValue(record.requests[key] === fingerprint, 'requestId reused with different prompt', 409);
      else {
        requireValue(ctx.agents.get(id)?.status !== 'running', 'agent busy; wait or cancel first', 409);
        if (record.latestRequest) requireValue((await status(id)).task.executionEnded, 'prior prompt lacks completed receipt', 409);
        if (record.modelSelection) {
          const current = (await status(id)).modelSelection.next;
          requireValue(current && matchesSelection(current, record.modelSelection), 'session model changed; select the intended model before prompting', 409);
          (record.requestModels ??= {})[key] = record.modelSelection;
        }
        record.requests[key] = fingerprint;
        record.latestRequest = key;
        await save();
      }
      const accepted = await ctx.sessionController.prompt({ requestId: key, sessionId: id, mode: 'queue', content: [{ type: 'text', text: body.text }], ...(body.clientTimeZone ? { clientTimeZone: body.clientTimeZone } : {}) }, stop.signal);
      return { ...accepted, sessionId: id, requestId: key };
    });
    throw new ApiError(405, 'method not allowed');
  }

  const server = http.createServer((req, res) => {
    const operation = (async () => {
      const expected = Buffer.from(`Bearer ${token}`);
      const actual = Buffer.from(req.headers.authorization ?? '');
      requireValue(!req.headers.origin && req.socket.remoteAddress === '127.0.0.1' && req.headers.host === `127.0.0.1:${server.address().port}`, 'local non-browser client required', 403);
      requireValue(actual.length === expected.length && timingSafeEqual(actual, expected), 'authentication required', 401);
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = {};
      if (req.method === 'POST') {
        requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'application/json required', 415);
        let size = 0;
        const chunks = [];
        for await (const chunk of req) { size += chunk.length; requireValue(size <= maxBody, 'request too large', 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid JSON'); }
      }
      return route(req.method, url.pathname, body, url.searchParams);
    })();
    requests.add(operation);
    operation.then(value => send(200, value), error => send(error.status ?? 500, { error: error.status ? error.message : 'host operation failed', code: error.code ?? null })).finally(() => requests.delete(operation));
    function send(code, value) {
      if (res.destroyed) return;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(); }); });
  const dispose = [];
  try {
    dispose.push(ctx.on('approval/request', (request, next) => hold('approval', request, next), true));
    dispose.push(ctx.on('user-questions/request', (request, next) => hold('questions', request, next), true));
    await writeFile(join(stateDir, 'token'), token + '\n', { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(stateDir, 'endpoint.json'), JSON.stringify({ protocol: 1, origin: `http://127.0.0.1:${server.address().port}`, instanceId, tokenFile: join(stateDir, 'token') }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    for (const fn of dispose) fn();
    server.closeAllConnections(); await new Promise(ok => server.close(ok));
    throw error;
  }
  let closing;
  return {
    origin: `http://127.0.0.1:${server.address().port}`, token,
    close() {
      return closing ??= (async () => {
        closed = true;
        stop.abort();
        for (const p of [...pending.values()]) p.abort();
        for (const fn of dispose) fn();
        await extensions.close();
        server.closeAllConnections();
        await new Promise(ok => server.close(ok));
        await tail;
        await Promise.allSettled([...requests]);
        try {
          const endpoint = JSON.parse(await readFile(join(stateDir, 'endpoint.json'), 'utf8'));
          if (endpoint.instanceId === instanceId) { await unlink(join(stateDir, 'endpoint.json')); await unlink(join(stateDir, 'token')); }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      })();
    },
  };
}
