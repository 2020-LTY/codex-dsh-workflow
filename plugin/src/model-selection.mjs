/** 适配 Desktop 0.2.1-rc.1 的 Host 本地选择能力，不调用会保存全局默认值的 selectModel。 */
export function modelAdapter(ctx) {
  const owner = ctx.sessionController.agents;
  const llm = ctx.get?.('llm');
  const supported = typeof owner?.selectForNextRequest === 'function'
    && typeof owner?.serializeImageAdmission === 'function' && typeof llm?.resolveCallConfig === 'function';
  return {
    supported,
    async resolve(selection, fail) {
      fail(supported, 'session-local model selection unsupported by this Host', 501);
      const catalog = await ctx.sessionController.modelCatalog();
      const model = catalog.groups?.find(g => g.id === selection.provider)?.models?.find(m => m.id === selection.model);
      fail(model && catalog.routableProviders?.includes(selection.provider), 'model/provider unavailable', 400);
      if (selection.reasoningEffort !== undefined) {
        fail(model.reasoning?.efforts?.some(e => e.id === selection.reasoningEffort), 'reasoningEffort unavailable for model', 400);
      }
      const resolved = pickSelection(await llm.resolveCallConfig(selection));
      fail(matchesSelection(resolved, selection), 'Host resolved a different model selection', 409);
      return resolved;
    },
    async install(id, selection, fail) {
      const agent = ctx.agents.get(id);
      fail(agent, 'live session unavailable; resume it in Desktop first', 409);
      return owner.serializeImageAdmission(agent, async () => {
        fail(agent.status !== 'running', 'agent busy; wait first', 409);
        owner.selectForNextRequest(agent, selection);
      });
    },
  };
}

/** 只返回路由和推理强度，不返回请求头中的凭证、系统提示或供应商配置。 */
export function pickSelection(value) {
  if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
  return { provider: value.provider, model: value.model, ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}) };
}
export function matchesSelection(actual, expected) {
  return actual !== null && actual.provider === expected.provider && actual.model === expected.model
    && (expected.reasoningEffort === undefined || actual.reasoningEffort === expected.reasoningEffort);
}
export function selectionView(events) {
  let lastUsed = null, pending = null;
  for (const event of events) {
    if (event.type === 'model/selection') pending = pickSelection(event.data);
    if (event.type !== 'request/header') continue;
    lastUsed = pickSelection(event.data.header?.config);
    if (pending && matchesSelection(lastUsed, pending) && lastUsed.reasoningEffort === pending.reasoningEffort) pending = null;
  }
  return { next: pending ?? lastUsed, lastUsed, pending };
}
