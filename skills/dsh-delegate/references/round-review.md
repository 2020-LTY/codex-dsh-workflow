# 每轮重新评估执行配置

首次委派，以及之后每次实质性的实现、调试、检查、独立验收开始前读取。本轮结果改变判断时更新评估，再决定下一步。“一轮”指控制端的一次工作安排，不是每次状态轮询、每个工具调用或模型内部步骤；等待同一任务不重复制作评估表。

## 必须作出的判断

每轮都检查四项，并用当轮事实给出沿用、调查或调整的理由。没有变化也要重新判断，不能复制上一轮“可用/已通过”作为新结论。

| 项目 | 主要依据 | 可能的决定 |
|---|---|---|
| 插件与能力 | 该轮实际需要的工具、当前会话可见性、调用失败、权限/连接状态 | 沿用、核实缺口、准备明确选定的插件 |
| 模型 | 问题复杂度、当前路线、有效反馈是否充分、重复失败、成本和剩余预算 | 沿用、调查原因、选择目录中支持的模型 |
| 思考强度 | 需要推理的程度、延迟、错误性质、模型支持档位 | 沿用、调整支持档位 |
| agent 预设 | 工具作用域、当前上下文是否适合本轮、有效预设清单 | 沿用、用选定预设创建新会话 |

先定位主要失败原因：能力缺失、环境/权限、反馈不足、任务理解、实现错误或模型处理能力。原因不明时记录假设和下一项能区分原因的检查。缺截图/日志时先补反馈；不能把提高模型或思考强度当成通用修复。用户指定的供应商、模型、强度或预设继续生效；用户改要求时记录依据并更新约束。

“重新评估”不要求每轮改变配置。插件准备使用[能力管理](capability-management.md)；模型调整使用会话模型接口；预设切换创建新会话，不能把更改全局默认预设当成切换当前会话。保留任务编号、已通过证据和剩余预算，新会话、新插件或更强模型都不重置纠正次数/期限。

## 可重复使用的助手

`scripts/reassess.mjs` 使用控制插件 0.4.2 已有接口，每次刷新 health、catalog、任务规划和目标会话的状态/模型读回。它不调用模型，也不安装、启停插件、切换模型或发送任务；它检查并保存 Codex 的评估，不替 Codex 判断产品语义。

```text
node <技能目录>/scripts/reassess.mjs <本轮配置绝对路径>.json
```

配置示例（会话、路径、模型/档位等均用实际值；以下省略可选切换）：

```json
{
  "taskId": "animation-01",
  "roundId": "debug-02",
  "phase": "debug",
  "taskType": "frontend",
  "task": "修复蝴蝶穿窗时的裁切并检查连续性",
  "sessionId": "<真实会话ID>",
  "requestId": "<要检查的真实请求UUID>",
  "currentPreset": "<创建回执中记录的预设ID>",
  "previousReview": "<上一轮 .review.json 的绝对路径>",
  "evidence": [{"id": "A1", "summary": "23秒时右翼被窗框错误裁切", "source": "<本次截图的绝对路径>"}],
  "decisions": {
    "plugins": {"action": "keep", "reason": "本轮所需浏览器工具已在目标会话读回，继续核对画面"},
    "model": {"action": "keep", "reason": "当前证据指向遮挡实现，先提供具体截图"},
    "reasoning": {"action": "keep", "reason": "局部修复范围清楚，未见增加推理强度的依据"},
    "preset": {"action": "keep", "reason": "当前预设的工具范围仍适合该轮修复"}
  }
}
```

`phase` 支持 initial、implementation、debug、check、acceptance。`taskId` 跨轮保留，`roundId` 每轮更换；`requestId` 指向要复查的请求，避免把另一轮的输出作为证据。只有首次或尚无会话时省略 sessionId/currentPreset/requestId；已有会话但预设记录缺失时标记未知，不拿 catalog 默认值冒充。

先不填 decisions 运行一次可收集事实，返回 needs-attention/退出码 2 是缺少评估的明确提示。Codex 阅读报告，再填写四项理由并重新运行；不要为了消除提示填无依据的占位判断。短任务仍做四项判断，但用简短理由即可。

输出保存在输入文件旁的 `.review.json`，包括运行快照、相较上一轮的变化、四项决策、当前请求生命周期和未决项。previousReview 是控制端本地记录，不传给 DSH。模型输出/思考不进入助手摘要；截图/检查文件只作引用，助手不会声称已读取或验证其内容。

调整项写法：

- plugins：action 为 prepare，并在 reason 中说明缺口；插件明确选择另交 prepare.mjs，每轮使用独立准备配置/检查点，不删除旧检查点绕过不确定操作。
- model：action 为 change，selection 为 `{provider,model}`。
- reasoning：action 为 change，effort 为目录支持的档位。
- preset：action 为 new-session，id 为有效预设 ID。
- 任一项原因未明：action 为 investigate，说明下一步要查什么。

调整必须提供 evidenceIds，引用该轮 evidence 中的 ID，或 runtime.capabilities、runtime.catalog、runtime.model、runtime.lifecycle、runtime.delta。理由与证据是否充分仍由 Codex 判断；引用存在不等于论证成立。

用户显式约束可放入 `constraints: {modelSelection:{provider,model,reasoningEffort},preset}`，只填确实被用户指定的字段。省略时继承上一轮约束；改变约束会提示检查用户新指令。不要把自主选择的配置误写成用户永远不许更改的约束。

## 执行和验收闭环

1. 刷新事实 → 判断主要问题与四项配置 → 保存本轮决定。
2. 有未决项时先调查；需要调整时，确认当前工作结束，按原授权使用现有管理接口。`nextActions` 是待处理建议，不能跳过 blockers 当作已授权、已执行的命令。
3. 调整后重新评估目标会话，核对工具与模型读回；需要新会话时带上必要上下文和任务剩余预算。把已完成调整的决策改为 keep，记录新的运行事实。
4. 执行/检查，按本次请求头验证实际模型；检查失败再次进入评估。验收通过按[verification.md](verification.md)判断，不能用助手 status=reviewed 替代。

助手的快照不是跨接口原子事务；正式变更仍使用现有 revision/幂等保护，Host 或会话状态变化后刷新。能力接口的成功调用可能来自整个会话历史，只能当线索；本轮仍需本次输入和最终产物的证据。截图返回、模型配置读回、reviewed 均不证明任务通过。`executionReadiness` 另报尚缺会话、能力、配置读回或待调整；即使四项决定已记录，也不能据此跳过未满足的执行条件。
