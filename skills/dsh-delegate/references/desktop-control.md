# 桌面接口委派

使用已运行的 DSH Desktop Host 内的 dsh-codex-control 插件。先安装发行版插件并完整退出桌面及托盘后台、重新启动；安装方法见项目 README。不能以独立 headless 进程或历史导入代替桌面实时工作。

本技能自带 `scripts/client.mjs`，所有命令中的脚本路径从当前技能目录解析成绝对路径。脚本从 `DSH_HOME`（默认用户目录下 `.dsh`）的 `codex-control/endpoint.json` 读取本机连接信息与凭证；自定义 stateDir 时设置 `DSH_CODEX_CONTROL_DIR`。不要打印、复制或提交这些文件。一个 stateDir 只供一个 Host 使用。

## 顺序

1. `node <技能目录>/scripts/client.mjs GET /v1/health`，再读 `/v1/catalog`。只选择实际存在的 preset；接口沿用 DSH 已有模型，不设置模型或安装插件。缺能力时按 runtime.md 核实并补充配置，再新建会话。
2. 创建已有的任务目录，保存 UTF-8 JSON：`{requestId: 新UUID, cwd: 已有绝对目录, title: 可辨认任务名, interactionMode: "api"}`。用 `POST /v1/sessions <请求文件绝对路径>` 创建，记录返回的 sessionId/workspaceId。可选 agentPreset 是 catalog 中的预设 ID。创建立即走桌面正常控制器，不自动切换当前聊天。
3. 保存另一个请求：`{requestId: 另一个新UUID, text: 完整规范任务单}`；可选 clientTimeZone。用 `POST /v1/sessions/<sessionId>/prompt <文件>` 发送。
4. 读 `GET /v1/sessions/<sessionId>/status?requestId=<本次UUID>`。默认仅短状态，需要时才加 `&includeToolOutput=true`（最近三个工具结果的有限尾部）。有回执、执行区间关闭且 agent 空闲才是 executionEnded；这不等于验收通过。reason 保留失败/中断原因。intervalIncludesOtherInputs 表示混入其他消息；历史 requestId 区间可含后续工作，不能当作独立任务证明。
5. API 模式 pending 提问可通过 `POST .../answer` 提交 `{interactionId, answers:[{id, selected:[选项标签]}]}`，或使用 custom 字符串。必须覆盖全部问题并遵守多选设置。授权须先读 `GET .../operation?interactionId=<ID>`，按原用户授权判断完整工具参数，再提交 `{interactionId,decision:"allowed-once"}` 或 `rejected`。参数缺失/截断时不要仅凭工具名允许。没有全部允许。
6. 到达控制端期限，用 `POST .../cancel` 和 `{}` 取消，再核实状态、子进程与部分产物。取消不是回滚，也不删除等待队列或历史。

创建/发送可用完全相同 UUID 与内容重试；内容变化必须换 UUID。同一会话只允许一个未结束接口任务。不要盲目重放副作用。ownership.json 保留拥有的会话及请求指纹；删除它会丢失接口对旧会话的操作权。

## 桌面交互区别

interactionMode 默认 desktop：人通过原桌面提问/授权窗口回答。api：控制端接管本插件创建会话的提问/授权，原弹窗不会同时出现，但模型消息和工具历史仍使用正常会话。两种模式不要宣称交互界面完全相同。交付时提供桌面标题、真实 ID 和实际验证的可见性。

## 兼容与计费

验证基线为 DSH Desktop 0.2.0-rc.2；升级后检查 health、一个微小真实任务、取消和所需交互。插件启动会检查 Host 方法，新版本可能需要适配。真实权限请求尚未做端到端验证，仅有行为替身测试。status 数值 usage 只覆盖读取区间的 assistant 事件，不能当成完整账单或凭此声称省钱百分比。
