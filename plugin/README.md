# dsh-codex-control

独立 Cordis 插件，使用 DSH Desktop 原有工作区和会话控制器提供本机 HTTP 接口。无外部运行依赖；不修改 DSH 核心。安装、限制和接口说明见项目根目录 README.md 与 docs/api.md。

Node >=22.19。在本目录运行 npm pack 生成可由桌面插件管理器安装的 tgz。默认仅监听 127.0.0.1:3189，凭证和会话所有权放在 DSH 用户数据目录，禁止将其上传。接口只操作由本插件创建的会话。
