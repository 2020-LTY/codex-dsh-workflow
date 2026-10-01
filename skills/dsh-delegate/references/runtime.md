# DSH 运行与能力适配

首次使用、切换安装或改变能力时读取。以下行为以 DSH Desktop 0.2.0-rc.2 及对应源码为验证基线，作为发现入口。API 尚未稳定，实际安装的帮助、配置和文档优先；任务不要求位于该源码目录。

## 最小发现

1. 找当前可用 `dsh`、既有控制器或 SDK。确认 executable 来源、版本、任务 cwd 与 `DSH_HOME`（通常默认 `~/.dsh`）。源码运行记录分支/提交及相关未提交改动，不输出凭证。
2. 获取 launcher `--help`、`--version` 和选定应用的帮助。源码入口是在 DSH 仓库运行 `pnpm dsh ...`，安装好的 `dsh` 从实际任务目录调用。headless 默认 session 与 sandbox 取进程 cwd，任务文本写另一个路径不会改变它们；跨项目执行须使用实际 cwd 的可用安装，或经已验证的 SDK cwd/processCwd 与相关配置明确选择工作区，不凭空添加 cwd flag。
3. 必要时将 profile 的 `--dump-config` 保存本地，只检索需要的行/provider/工具，配置可能含凭证。dump 不启动应用、不证明插件激活，首次使用还可能初始化 profile 文件。以现有客户端握手/只读目录接口核实可离线证明的启动与工具配置；没有这类接口时标记尚未运行确认，并在首个有界任务里做最小工具调用，不另造接口或先花一轮模型调用。
4. 确实缺能力才补配置。启动失败先查具体错误和构建产物，不自动全仓库构建/全套测试/安装另一运行时。源码可能需要 Typert 等已构建产物，有可用安装优先复用。

上游源码中的参考入口：`apps/cli/README.md`、`apps/cli/reference/README.md`；运行/预设文档在 `packages/bundle/headless/README.md`、`packages/acp/acp/README.md`、`packages/sdk/client/README.md`、`packages/preset/agent-presets/README.md`。单字段查询搜索 `docs/config-catalog.md` 的对应 package 小节，不加载全目录。

## 调用方式

| 需要 | 优先选择 | 证据与限制 |
|---|---|---|
| 独立工作包，文件产物和短报告足够 | `dsh --profile headless` | 每次新会话，stdout 只有最终回答，stderr 有 reasoning，无中间工具结果/交互跟进。要求命令输出写证据目录。 |
| 连续修复、已有 TS/Python 客户端、需 DSH 原始事件 | SDK，经 `dsh --profile sdk` | 可复用 session，run 返回 sessionId/finalResponse/events/notifications；保存并筛选，不回灌全事件。当前无 mid-turn cancel，停止通常需关闭其运行时。 |
| 已有 ACP 控制器、需语义更新与取消 | `dsh --profile acp` | initialize 后按广告能力 new/resume、prompt、update、cancel/close；不等于 DSH 全部 UI/终端/询问接口。 |

所有支持的 Node 应用经 `dsh` profile 启动，不绕 launcher 启 package bin、demo 或自造公共 argv。SDK/ACP stdout 是协议通道，日志独立保存。没有现成客户端时，不为一次小任务实现原始 RPC 客户端。

无交互 headless 没有人类审批通道，SDK 当前也不提供完整交互审批。发包前核实所需操作已在实际权限范围内，或选有明确 permission 回调的客户端；客户端只允许原任务已授权的操作。遇审批要求时交回控制端，不能为免阻塞把策略改成 blanket allow 或 danger-full-access。

headless 退出 0 只表示最终 turn/end 为 completed，不表示通过验收。stderr 可能大量 reasoning，默认保存不读取；首个 reasoning token 前静默是已知行为，不据此判卡死，用控制端期限和真实状态判断。

启动用结构化 argv，先 launcher 参数再任务文本。`--patch` 等在文本之前。headless 当前只有任务位置参数，不添加不存在的 `--preset`、`--json`、`--resume`、`--task-file`、`--max-tokens`、`--home`。长任务消息要求读取已写的 UTF-8 文件，不假设 stdin 是任务输入。

PowerShell 用原生进程 API/数组参数传文本，不拼接 cmd /c、Invoke-Expression 或将任务当 shell 代码。中文文件明确 UTF-8，应用 cwd 为实际目标项目，DSH home 与源码位置单独处理。

## profile、preset 与插件

profile 是应用/部署组合，preset 是会话工具和提示。默认 headless/base 直接组合工具，不自动使用 Web agent-presets；使用预设前确认目标 profile 挂载 roster 及依赖。不能看到 Web 预设就认为 headless 能选择。

| 当前 preset | 选择依据 |
|---|---|
| `standard` | 通用编码基线，具备文件、shell、检索、skills 等；具体能力以实际组合为准。 |
| `minimal` | 固定提示，仅平台 shell，无自动项目指令/其他提示段/compaction。只用于明确 shell 命令或脚本的小包，必须显式提供项目规则及读取步骤，不为省 token 盲选。 |
| `ptc` | 工具用 TypeScript 组合，适合大量重复工具往返且模型能稳定使用；复杂度和返工可能抵消节省，当前默认无 workflow。 |
| `cordis` | preset 创作、运行时检查与插件实验；普通任务无需为“更强”启用。 |

roster 的 `default` 可被用户 `agent-presets.default` 覆盖，改配置需读回实际选择。预设通常含 preset.yml/agent.cordis.yml，用户目录为 `<dshHome>/.agent-presets`；优先复制现有完整目录做专用预设，不覆盖内置同名项。已产生消息或工具调用的 session 不能切 preset，改变能力后新建 session 并传短摘要。

preset 主要挂载 agent 工具/提示，sandbox、持久化、provider 及 host 服务由应用组合负责。插件需完整 Service Definition/Provider/Consumer 及依赖，仅装包不保证模型工具可见。当前外部 bundle 用 `dsh plugin --profile <name> add <package-or-git-spec>`：声明 bundle 的包加入 profile 层，普通包仍需 patch wiring。先核实版本支持方式。

能力按任务选择：编辑用 FS/平台 shell，研究用真实 search/fetch provider 和可追溯来源，页面交互需实际浏览器/MCP（web_fetch 不替代浏览器），数据处理优先现成 Python/Node，长流程需持久化及状态检查。不默认添加 memory/workflow/subagent/自修改工具。

## 配置约束

- 短期优先 `--patch` overlay；长期组合可建单独 custom profile，从 `--from-default-profile headless` 等模板初始化。仅目标目录不存在时用创建参数，初始化后重试去掉。不要先插件管理意外建 base-only profile，再试图套模板。
- patch 的 config 整体替换，不逐字段合并；保留所需字段与 `!!js` 表达式。新 row 用当前版本插入语法，不猜 row id；dump 与启动检查各证明对应事实。
- profile 后还有 home patch，最后 argv overlays 优先；不改 home patch 为一个任务加能力，不跨 profile 推断插件状态。当前 desktop 是 Electron 保留名称，CLI 不管理/启动。
- 配置表达式与 MCP server 是可信代码。提示词允许列表不是真正访问控制；base workspace-write 仍允许部分读取/网络，sdk-minimal 当前固定 danger-full-access，名称 minimal 不代表更安全或便宜。
- timeout-policy 是协作取消，部分 shell/FS 无其时限，不是整个任务硬期限。控制端拥有期限、取消/关闭与进程清理。
- 模型/reasoning 从实际 provider catalog 选择，不固定过期型号。核实实际输出 cap 与 reasoning 设置，不能把部署默认视为适合小任务的预算；需要调整时用该接口支持的字段，不添加虚构 CLI 参数。SDK maxTokens 是每请求输出 cap，compaction 等另有用量；遥测不完整时说明计量范围。

## 会话可见性

headless 会话可以落盘到与 Desktop 相同的 home，但独立进程的 session/created 等事件不会直接成为桌面 Host 的事件。客户端初始列表和后续本进程事件不等于外部文件发现；项目成员登记也独立于 session 文件。核实实际运行版本，不能从“同一个 .dsh”推断实时展示。

委派前记录用户希望查看会话的表面及其实际 home。委派后取得真正的 session id、标题、workspace 和存储位置；优先客户端返回值。headless 不打印 session id 时，可用支持的只读列表比对运行前后元数据，按 cwd、创建时间和本次任务关联；多个候选时不能猜选。不得为确定 id 打印全部 session 内容。

有现成受支持的桌面/Host 控制入口时，优先让该 Host 创建并驱动会话，或用其明确支持的刷新/读取接口核实可见性。SDK/ACP 若仍是另起进程，也没有自动解决实时展示。没有该入口时记录“独立进程，桌面尚未确认可见”，向用户给出真实标题/id及刷新后可能位于未分组的定位方式；不宣称已在桌面显示，不静默重启正在运行的桌面。

不得直接编辑 workspace.json、删除初始化标记、移动/改写历史 session、让 CLI 管理 reserved desktop profile，或为追求可见性重复执行原任务。需要实时跟踪但产品没有支持入口时，把它明确列为产品能力缺口；skill 无法替代跨进程会话发现与刷新。

## 用量读取

headless 的 stdout 无 usage 不表示 session 无用量。优先现成 SDK/ACP 的数值通知，或版本匹配的 session 读取接口；只提取 assistant/message 的 usage 等所需字段并求和，不将原始流、思考或工具内容加入 Codex 上下文。不改写 session generation，不把旧格式解码器用到未知版本。

区分非缓存输入、缓存命中、输出及 reasoning 的具体字段语义，不能重复相加 reasoning 或缓存 token。根 agent、子代理、标题生成与 compaction 分开注明计量范围；没有数据的额外调用不记为零。成本需对应当时实际报价，整个委派的节省还需 Codex 用量或比较基线，不能用 DeepSeek token 数独自证明省钱。
