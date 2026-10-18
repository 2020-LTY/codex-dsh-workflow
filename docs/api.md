# 本机接口 v1

客户端：`node plugin/scripts/client.mjs METHOD /v1/path [UTF-8请求文件]`。客户端读取凭证并发送 bearer header，不打印凭证；不跟随重定向。所有接口认证，拒绝浏览器 Origin，无 CORS，只接受 loopback Host。默认监听 127.0.0.1:3189。

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | /v1/health | Host 实例、插件版本及 capabilities |
| GET | /v1/catalog | 实际模型目录、可用预设 |
| GET | /v1/plugins | 当前 profile 的包、启用状态、运行条目、预设组合与 revision；不返回配置 |
| GET | /v1/plugins/sources | Host 已配置的插件市场来源 |
| POST | /v1/plugins/search | query、可选 index/limit；只查询已配置来源 |
| POST | /v1/plugins/inspect | spec；返回精确版本、inspectionId 与快照 revision |
| POST | /v1/capabilities/plan | taskType/task、可选 requirements/sessionId；只规划，不修改配置 |
| POST | /v1/plugins/operations | requestId、action、显式 enabled；其余字段按下文操作类型 |
| GET | /v1/plugins/operations/:requestId | 安装/启用操作状态、Host结果与配置读回 |
| POST | /v1/plugins/operations/:requestId/cancel | 空对象；只取消本接口拥有的安装 |
| GET | /v1/sessions | 插件拥有的会话 |
| POST | /v1/sessions | requestId(UUID)、cwd(已有绝对目录)、title；可选 agentPreset、interactionMode(desktop/api)、modelSelection、requirements |
| GET | /v1/sessions/:id/capabilities | 会话有效工具、PTC外层工具、成功调用和图片回执线索；不调用工具 |
| GET / POST | /v1/sessions/:id/model | 读回选择；设置用 requestId(UUID)、modelSelection |
| POST | /v1/sessions/:id/prompt | requestId(UUID)、text；可选 clientTimeZone |
| GET | /v1/sessions/:id/status | 可选 requestId、includeToolOutput=true |
| GET | /v1/sessions/:id/operation | interactionId；读取授权对应的有限工具参数 |
| POST | /v1/sessions/:id/answer | interactionId；授权 decision 或问题 answers |
| POST | /v1/sessions/:id/cancel | 空对象 {} |

授权 decision 为 allowed-once 或 rejected。问题 answers 为 `{id,selected:[选项标签]}` 的数组，也可使用 custom 字符串。须遵守全部问题、单选/多选限制；对已结束交互回答会拒绝。

status 只返回短文本、生命周期和数值用量；executionEnded 需本次请求日志回执、后续区间关闭且 agent 空闲，仍须独立验收。includeToolOutput 仅返回最近三个工具结果有限尾部，不返回 reasoning。历史请求可覆盖后续工作；intervalIncludesOtherInputs 标记其他人输入。

创建和发送重试必须保持 UUID 与内容相同，修改内容换新 UUID。每个会话同时一个未结束接口任务。取消不回滚已写文件，也不删除队列或历史。

插件 config：port 默认3189（测试可0）、stateDir 默认 DSH_HOME/codex-control 或用户 .dsh/codex-control、maxBodyBytes 默认262144、outputChars 默认6000。只在产品支持的插件配置入口设置，不直接改正在运行的安装文件。一个 stateDir 只供一个 Host 使用。

endpoint.json、独立 bearer 凭证及 ownership.json 均留在用户数据目录。每次加载换凭证，卸载移除本实例连接信息。删除 ownership 会失去旧会话操作权。Windows 文件 ACL 继承所在目录；本机可读凭证的进程可调用接口。此接口并非模型文件访问沙箱，任务边界依赖实际 DSH 工具权限。

## 模型与推理强度（插件 0.3.0）

发包前读取 health/catalog：`capabilities.sessionModelSelection` 为 true 才可设置。用户明确指定的 provider/model/reasoningEffort 优先；否则按任务自主选择目录中的可用组合，并在任务单/控制端 execution.json 记录选择理由。常规、低风险工作优先较快模型和 low/high；复杂推理或质量关键工作才考虑较强模型和 high/max。off 仅适合无需推理的简单任务；不固定型号，不将 Pro 等同于推理强度，不因用户上次手动选 Pro 就默认沿用。供应商路线保留用户选择，不擅自换账号或计费渠道；无法确定用户路线时使用 catalog 的 default.provider，而不是随意选另一个 provider。

创建请求可增加 `modelSelection: {provider: "目录中的供应商ID", model: "目录中的模型ID", reasoningEffort: "目录支持的档位"}`，必须使用真实 ID。省略整个 modelSelection 保持 DSH 原来的默认行为；自主选择时显式传入三项。创建返回的 modelSelection.next 只是已配置值，不等于模型已执行。

`GET /v1/sessions/<id>/model` 返回 requested、next、pending、lastUsed。空闲且上次请求已结束时，可通过 `POST /v1/sessions/<id>/model` 发送 `{requestId: 新UUID, modelSelection: {...}}`；重试保持 UUID 和内容，旧请求重放不会把会话切回旧模型。仅能操作插件拥有的会话。无法恢复的冷会话需要先在桌面恢复；不为此改写历史。

发送后从 status.task.modelUsage 核对本次真实 request/header 的 provider/model/reasoningEffort；modelVerified 为 true 表示该请求区间已有请求头且全部匹配 modelExpected，null 表示尚无执行证据或未显式指定，false 必须报告差异。请求头不证明任务通过或模型成功返回；仍检查 reason 和独立验收结果。status.modelSelection.lastUsed 是整个会话最近一次请求，不能拿它冒充历史任务的用模证据。长区间含后续输入时按 intervalIncludesOtherInputs 标记证据范围。

设置限定目标会话，不保存全局默认值。DSH 0.2.1-rc.1 的 Host 本地适配器调用其现有选择助手；接口变化会报告不支持，不能调用会保存全局默认值的 selectModel 来静默降级。未知模型、不可路由供应商和不支持的强度均报错。能力缺失时说明限制；用户要求特定模型时不得沿用默认模型继续。interactionMode 只控制提问/授权归属，与推理强度无关。

## 每轮复评助手（0.5.0）

`node plugin/scripts/reassess.mjs <round.json>` 调用已有 GET health/catalog、POST capabilities/plan，以及有目标会话时的 GET status/model，不增加服务端执行入口。兼容后端 0.4.2+，因此更新技能与助手后立即可用，不必为该流程重启桌面。

输入 taskId、roundId、phase，任务/会话信息、当轮 evidence，以及 plugins/model/reasoning/preset 四项 decisions。可用 previousReview 引用上一轮本地报告，constraints 记录用户明确指定的选择。完整结构见[每轮复评](../skills/dsh-delegate/references/round-review.md)。缺少决定、缺调整证据、所选模型/强度/预设不在目录、违背显式约束或当前工作尚未结束，报告 needs-attention；CLI 退出码 2。成功评估写 .review.json；reviewed 不表示已执行建议、已授权变更或任务通过。

## 任务能力准备（0.4.0）

适配 DSH 0.2.1-rc.1 的 `pluginManager`、`pluginMarket`、`tools.view(agent)`；health 对每项能力单独报告布尔值。缺服务时保留旧会话/模型功能，管理接口返回明确的不可用状态，不改 Host 源码、不绕回直接改 profile 文件。

`taskType` 支持 code、frontend、browser、desktop、research、custom；也能从 task 文本推断。requirements 为受支持的能力ID，详见[能力准备](../skills/dsh-delegate/references/capability-management.md)。规划优先现有工具和已安装包，候选仅是元数据线索。没有目标会话时不宣称工具已就绪；`readyToSmokeTest` 表示已发现所需非视觉工具，`ready:false` 表示任务语义仍需实际验收。

安装分成 inspect 和异步 operation：

```json
{"requestId":"<UUID>","action":"install","inspectionId":"<inspect返回的ID>","enabled":true}
```

注册表版本在 inspect 后固定；票据有效15分钟且只属于当前 Host 实例。清单改变需重新 inspect。启用/禁用整包使用 `action:set-bundle-enabled,name,enabled,expectedRevision`；单行使用 `action:set-plugin-enabled,entryId,enabled,expectedRevision`。revision 来自最新清单。原子保存请求指纹，相同UUID/内容不会重复执行；不同内容冲突返回409。

操作立即返回 running，随后查询同一编号。最终状态 completed/failed/cancelled/interrupted 与 Host 的 application:applied/restart-required/failed 分开。readback 仅证明持久化启用状态；工具作用域和实际运行还需在目标会话验证。重启后未完成的操作标记需要核对，不自动重放。安装取消转交 Host 的 cancelInstall，卸载桥接时等待其拥有的安装收束。

已有接口会话运行时拒绝修改 profile 能力；不支持通过此接口卸载插件、修改全局默认、批准构建脚本或兼容性豁免。不能经自己的运行中端点更新控制插件自身。Host 已加载包的版本升级限制继续由官方管理器负责；不要通过删除依赖来绕过拒绝。

便捷入口 `node plugin/scripts/prepare.mjs <task.json>` 默认只规划；`--apply` 执行任务JSON里明确选择的 plugins/bundles/entries，并在输入旁保存不含凭证的恢复检查点。重复运行先查询原操作，超时请求取消，结果未知时停止而非盲重试。详细输入与流程见技能参考。

`/sessions/:id/capabilities` 只返回名称、能力线索、wireTools、成功回执名称以及是否出现 image 块，不返回参数/图片/思考。成功回执不证明语义正确。视觉输入固定标为 unverified：截图返回、截图工具存在，均不足以证明模型理解像素；Canvas任务须用真实图像判断或明确交给控制端视觉验收。
