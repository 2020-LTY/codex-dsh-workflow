import { startBridge } from './server.mjs';

export const name = 'codex-control';
export const inject = ['sessionController', 'workspaceController', 'agents', 'sessionQuery'];

/** 在桌面 Host 中挂载接口；插件卸载时关闭监听并结算接口交互。 */
export async function apply(ctx, config = {}) {
  await ctx.effect(async () => {
    const bridge = await startBridge(ctx, config);
    return () => bridge.close();
  });
}
