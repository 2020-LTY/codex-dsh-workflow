# Codex → DSH 桌面工作流

让 Codex 负责制定任务、选择能力和验收，由 DeepSeek Harness 执行。会话从创建开始出现在 DSH 桌面；发送任务、读状态、回答提问与取消均走本机接口，不需要光标自动化。

本项目包含 `dsh-delegate` 全局技能、`dsh-codex-control` 独立插件、接口客户端、安装及打包脚本。技能用明确范围、验收标准和返工预算约束任务；验收优先运行结果，避免把全部代码、思考和历史传回 Codex。实际成本取决于任务与两边用量，不承诺节省比例。

## 安装

需要已安装的 DSH Desktop、已在 DSH 配置好的模型，以及 Node.js >=22.19。兼容验证基线为 Desktop 0.2.0-rc.2。插件是桌面 Host 扩展，不能当作独立服务或 Docker 容器运行。

1. 从本仓库 Releases 下载完整工作流 ZIP，解压；或克隆本仓库。
2. 在项目目录执行 `node scripts/install-skill.mjs`。默认安装到用户的 `.codex/skills/dsh-delegate`，支持 CODEX_HOME。已有技能时会拒绝覆盖；确认替换用 `--replace`，脚本会先备份旧版本。
3. Releases 提供 `dsh-codex-control-0.2.0.tgz`。自行构建可执行 `npm run pack`，安装包在 dist。
4. 在 DSH 桌面插件管理页面安装该 tgz 的绝对路径。首次安装需使用产品界面；本项目未提供外部安装接口。完整退出桌面及托盘后台后重新打开。
5. 执行 `node plugin/scripts/client.mjs GET /v1/health`；再执行 `node plugin/scripts/client.mjs GET /v1/catalog`。成功后让 Codex 使用 `$dsh-delegate` 完成一个小任务。

安装全局技能后，如当前 Codex 会话尚未发现它，重新打开会话。所有示例命令都在项目根目录运行；任务请求路径和 cwd 必须替换为实际绝对路径。

## 通过接口开始

创建已有工作目录，并将以下对象保存为 UTF-8 create.json。用新 UUID 替换示例标记（Node 可用 `node -e "console.log(require('crypto').randomUUID())"`）。

```json
{"requestId":"<新UUID>","cwd":"<已有工作目录的绝对路径>","title":"Codex：我的小项目","interactionMode":"api"}
```

```sh
node plugin/scripts/client.mjs POST /v1/sessions create.json
```

返回 sessionId 后，另存 prompt.json：

```json
{"requestId":"<另一个新UUID>","text":"完整任务单：目标、允许路径、约束、验收、预算和停止条件。"}
```

```sh
node plugin/scripts/client.mjs POST /v1/sessions/<sessionId>/prompt prompt.json
node plugin/scripts/client.mjs GET /v1/sessions/<sessionId>/status
```

接口会话出现在桌面列表，但不会自动切换正在看的聊天。api 模式由控制端回答提问/授权，原桌面弹窗不会同时出现；选 desktop 模式则保留人类桌面回答。权限判断仍按用户原任务授权进行。

详见 [API 与配置](docs/api.md)、[兼容和验收记录](docs/compatibility.md)及[技能任务单](skills/dsh-delegate/references/task-contract.md)。

## 开发与发布

无 npm 外部依赖，无需 npm install。执行 `npm test`、`npm run check`、`npm run pack`。CI 在 Windows/Linux 和 Node 22/24 执行接口行为测试、隐私规则检查及打包。打包采用明确目录清单，并生成 SHA256SUMS；dist 不纳入 Git。

连接信息默认在 `~/.dsh/codex-control`；自定义 DSH_HOME 时跟随变化。客户端可通过 DSH_CODEX_CONTROL_DIR 指向自定义 stateDir。不要上传凭证、ownership.json、endpoint.json、真实会话、个人模型配置或任务日志。一个 stateDir 仅供一个 Host；同机可读凭证的程序也能控制接口拥有的会话。

源码采用 MIT 许可证。DSH、Codex 和 Node.js 为外部前提，未随本项目打包；本项目并非其官方产品。
