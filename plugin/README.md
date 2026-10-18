# dsh-codex-control

0.5.0：新增 `scripts/reassess.mjs`，在每个实质轮次刷新真实接口、保存插件/模型/思考强度/预设四项评估，比较配置漂移并检查显式约束。助手不自动执行配置；可直接配合已加载的 0.4.2 后端使用。

0.4.2：通过 Host 现有 pluginManager/pluginMarket 提供任务能力规划、插件发现/检查、可取消且幂等的异步安装、包/插件行启用，以及 session-scoped 工具读回。`scripts/prepare.mjs` 提供明确选择的恢复式配置入口；不扩张权限、不自动豁免兼容性，不把安装成功当成视觉验收成功。

独立 Cordis 插件，使用 DSH Desktop 原有工作区和会话控制器提供本机 HTTP 接口。无外部运行依赖；不修改 DSH 核心。安装、限制和接口说明见项目根目录 README.md 与 docs/api.md。

Node >=22.19。在本目录运行 npm pack 生成可由桌面插件管理器安装的 tgz。默认仅监听 127.0.0.1:3189，凭证和会话所有权放在 DSH 用户数据目录，禁止将其上传。接口只操作由本插件创建的会话。

0.3.0：创建支持可选 modelSelection(provider/model/reasoningEffort)，空闲会话可通过 /model 修改；health/catalog 公布能力。状态区分选择意图与真实 request/header。会话选择适配 Desktop 0.2.1-rc.1 的 Host 本地助手，不使用会保存全局默认值的 selectModel；后续 Host 变更需重新验证，缺能力返回 501。省略字段兼容旧调用。
