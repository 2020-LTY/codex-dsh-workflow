# 桌面接口委派

使用已运行的 DSH Desktop Host 内的 dsh-codex-control 插件。先安装发行版插件并完整退出桌面及托盘后台、重新启动；安装方法见项目 README。不能以独立 headless 进程或历史导入代替桌面实时工作。

本技能自带 `scripts/client.mjs`，所有命令中的脚本路径从当前技能目录解析成绝对路径。脚本从 `DSH_HOME`（默认用户目录下 `.dsh`）的 `codex-control/endpoint.json` 读取本机连接信息与凭证；自定义 stateDir 时设置 `DSH_CODEX_CONTROL_DIR`。不要打印、复制或提交这些文件。一个 stateDir 只供一个 Host 使用。

## 顺序

1. `node <技能目录>/scripts/client.mjs GET /v1/health`，再读 `/v1/catalog`。只选择实际存在的 preset；模型与推理强度按下方流程显式选择；不要未经能力检查安装插件。需要可选能力时按 capability-management.md 规划、复用或补齐，再新建会话验证。
2. 创建已有的任务目录，保存 UTF-8 JSON：`{requestId: 新UUID, cwd: 已有绝对目录, title: 可辨认任务名, interactionMode: "api"}`。用 `POST /v1/sessions <请求文件绝对路径>` 创建，记录返回的 sessionId/workspaceId。可选 agentPreset 是 catalog 中的预设 ID。创建立即走桌面正常控制器，不自动切换当前聊天。
3. 保存另一个请求：`{requestId: 另一个新UUID, text: 完整规范任务单}`；可选 clientTimeZone。用 `POST /v1/sessions/<sessionId>/prompt <文件>` 发送。
4. 读 `GET /v1/sessions/<sessionId>/status?requestId=<本次UUID>`。默认仅短状态，需要时才加 `&includeToolOutput=true`（最近三个工具结果的有限尾部）。有回执、执行区间关闭且 agent 空闲才是 executionEnded；这不等于验收通过。reason 保留失败/中断原因。intervalIncludesOtherInputs 表示混入其他消息；历史 requestId 区间可含后续工作，不能当作独立任务证明。
5. API 模式 pending 提问可通过 `POST .../answer` 提交 `{interactionId, answers:[{id, selected:[选项标签]}]}`，或使用 custom 字符串。必须覆盖全部问题并遵守多选设置。授权须先读 `GET .../operation?interactionId=<ID>`，按原用户授权判断完整工具参数，再提交 `{interactionId,decision:"allowed-once"}` 或 `rejected`。参数缺失/截断时不要仅凭工具名允许。没有全部允许。
6. 到达控制端期限，用 `POST .../cancel` 和 `{}` 取消，再核实状态、子进程与部分产物。取消不是回滚，也不删除等待队列或历史。

创建/发送可用完全相同 UUID 与内容重试；内容变化必须换 UUID。同一会话只允许一个未结束接口任务。不要盲目重放副作用。ownership.json 保留拥有的会话及请求指纹；删除它会丢失接口对旧会话的操作权。

## 插件与会话能力（插件 0.4.0）

health 单独声明 pluginInventory/pluginInspection/pluginInstall/pluginEnablement/pluginSearch/sessionToolInventory/capabilityPlanning。0.3.0 不具备这些接口，不能向旧 Host 发送安装请求后假定成功。按 [capability-management.md](capability-management.md) 使用清单、任务规划、inspect、异步操作和可恢复的 prepare.mjs。安装和启用只调用当前 Host 官方管理器，不改 home patch 或运行中的安装文件。控制插件自身更新走产品支持的独立管理入口。

创建可传 requirements，返回 capabilityReadback；GET /v1/sessions/:id/capabilities 读取当前有效工具、PTC 外层工具和调用线索。插件包状态、预设作用域、模型可用工具、实际自测是不同事实。配置变化后优先新建会话，不强行修改已开始会话的预设。visionInput:unverified 不应被截图成功或模型名称覆盖。

## 模型与推理强度（插件 0.3.0）

发包前读取 health/catalog：`capabilities.sessionModelSelection` 为 true 才可设置。用户明确指定的 provider/model/reasoningEffort 优先；否则按任务自主选择目录中的可用组合，并在任务单/控制端 execution.json 记录选择理由。常规、低风险工作优先较快模型和 low/high；复杂推理或质量关键工作才考虑较强模型和 high/max。off 仅适合无需推理的简单任务；不固定型号，不将 Pro 等同于推理强度，不因用户上次手动选 Pro 就默认沿用。供应商路线保留用户选择，不擅自换账号或计费渠道；无法确定用户路线时使用 catalog 的 default.provider，而不是随意选另一个 provider。

创建请求可增加 `modelSelection: {provider: "目录中的供应商ID", model: "目录中的模型ID", reasoningEffort: "目录支持的档位"}`，必须使用真实 ID。省略整个 modelSelection 保持 DSH 原来的默认行为；自主选择时显式传入三项。创建返回的 modelSelection.next 只是已配置值，不等于模型已执行。

`GET /v1/sessions/<id>/model` 返回 requested、next、pending、lastUsed。空闲且上次请求已结束时，可通过 `POST /v1/sessions/<id>/model` 发送 `{requestId: 新UUID, modelSelection: {...}}`；重试保持 UUID 和内容，旧请求重放不会把会话切回旧模型。仅能操作插件拥有的会话。无法恢复的冷会话需要先在桌面恢复；不为此改写历史。

发送后从 status.task.modelUsage 核对本次真实 request/header 的 provider/model/reasoningEffort；modelVerified 为 true 表示该请求区间已有请求头且全部匹配 modelExpected，null 表示尚无执行证据或未显式指定，false 必须报告差异。请求头不证明任务通过或模型成功返回；仍检查 reason 和独立验收结果。status.modelSelection.lastUsed 是整个会话最近一次请求，不能拿它冒充历史任务的用模证据。长区间含后续输入时按 intervalIncludesOtherInputs 标记证据范围。

设置限定目标会话，不保存全局默认值。DSH 0.2.1-rc.1 的 Host 本地适配器调用其现有选择助手；接口变化会报告不支持，不能调用会保存全局默认值的 selectModel 来静默降级。未知模型、不可路由供应商和不支持的强度均报错。能力缺失时说明限制；用户要求特定模型时不得沿用默认模型继续。interactionMode 只控制提问/授权归属，与推理强度无关。

## 每轮配置评估助手

`scripts/reassess.mjs` 通过已有 health/catalog/plan/status/model 接口，在首次执行及后续实现、debug、检查、验收轮次刷新事实、记录四项决策、比较运行变化。兼容控制插件 0.4.2+，无需新增服务端接口；读 [round-review.md](round-review.md)。助手本身不修改配置、不调用模型、不判定验收通过。

## 桌面交互区别

interactionMode 默认 desktop：人通过原桌面提问/授权窗口回答。api：控制端接管本插件创建会话的提问/授权，原弹窗不会同时出现，但模型消息和工具历史仍使用正常会话。两种模式不要宣称交互界面完全相同。交付时提供桌面标题、真实 ID 和实际验证的可见性。

## 兼容与计费

旧接口基线为 DSH Desktop 0.2.0-rc.2；模型选择已在 Desktop 0.2.1-rc.1 + 控制插件 0.3.0 完成 Flash low、Pro off 的真实请求验证，全局默认未改变，旧会话所有权保留。其余档位未逐档调用模型。升级后检查 health、一个微小真实任务、取消和所需交互。插件启动会检查 Host 方法，新版本可能需要适配。真实权限请求尚未做端到端验证，仅有行为替身测试。status 数值 usage 只覆盖读取区间的 assistant 事件，不能当成完整账单或凭此声称省钱百分比。
