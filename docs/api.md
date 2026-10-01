# 本机接口 v1

客户端：`node plugin/scripts/client.mjs METHOD /v1/path [UTF-8请求文件]`。客户端读取凭证并发送 bearer header，不打印凭证；不跟随重定向。所有接口认证，拒绝浏览器 Origin，无 CORS，只接受 loopback Host。默认监听 127.0.0.1:3189。

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | /v1/health | Host 实例及协议状态 |
| GET | /v1/catalog | 实际模型目录、可用预设 |
| GET | /v1/sessions | 插件拥有的会话 |
| POST | /v1/sessions | requestId(UUID)、cwd(已有绝对目录)、title；可选 agentPreset、interactionMode(desktop/api) |
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
