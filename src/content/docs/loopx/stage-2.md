---
title: "阶段 2：Should-Run 与 Quota"
description: "阶段 2：ShouldRun 与 Quota。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 1，理解 Goal、Todo、Claim、Gate 与投影
> 对应总览：`turn-lifecycle.md` 的准入部分
> 本阶段目标：把 `should_run=false` 拆成不同原因，并说明 `true` 为什么仍不是任意动作授权。

## 1. 本阶段解决什么

长程 Agent 最常见的错误不是“不会做”，而是“在不该做的时候做了”。LoopX 在进入 Turn 前先算一份 quota should-run 决策，回答四件事：

- 现在有没有可处理的工作；
- 若没有，是在等谁、等什么；
- 若允许运行，运行哪个 Goal/Todo 路线；
- 这份允许是否只针对恢复、观察或特定 action，而不是所有动作。

`should_run` 是准入层的结论，不是模型自己的判断，也不是任务完成证明。

## 2. 先记住一个判断

**`should_run=false` 不是一种状态；`should_run=true` 也不是一张空白支票。**

前者至少有健康、人工门禁、focus wait、外部等待、节流和硬暂停六类来源；后者仍要经过 capability、interaction contract、workspace/action authority 和本轮 envelope 的约束。

## 3. 源码主线

1. `quota/states.py` 定义状态优先级：`blocked_health`、`operator_gate`、`focus_wait`、`eligible`、`waiting`、`throttled`、`paused`。
2. `build_quota_should_run()` 汇总 Goal、Todo、claim、gate、quota 与 scheduler 事实，生成候选路线。
3. `live_decision.py` 增加实时输入：外部唤醒、monitor、交互合同、自动化存活与正常投递权限。
4. `should_run_packet.py` 把内部判断装配成 Host 可消费的 JSON，并挂上 capability gate 和 envelope。
5. `turn_envelope_budget.ts` 检查 8,192 字节基础预算，产生 `turn_envelope_budget_exceeded` 诊断。

## 4. 关键对象与合同

| 对象 | 回答的问题 | 误用方式 |
| --- | --- | --- |
| `quota.state` | 当前最主要的准入状态是什么 | 把所有 false 都当“没工作” |
| `should_run` | 是否可进入一次 Turn 候选 | 当作所有工具的永久许可 |
| `route` | 本轮走正常交付、恢复、观察还是等待 | 绕过 Goal/Todo scope |
| `capability_gate` | 某项能力是否缺失、未启用或未就绪 | 让 Host 猜一个替代动作 |
| `normal_delivery_allowed` | 能否按正常产品路径交付 | 把恢复路径当普通完成 |
| `interaction_contract` | 人机交互、审批与通知的边界 | 直接改写成自然语言建议 |
| `automation_liveness` | 自动轮次是否仍然活着、是否该唤醒 | 用旧 heartbeat 继续跑 |
| `turn_envelope` | Host 本轮可见且有界的合同包 | 无上限塞入全部历史 |

### `false` 的正确分类

| 类别 | 典型含义 | 下一动作 |
| --- | --- | --- |
| 健康阻断 | registry/state/合同损坏 | 先修事实，不运行 Host |
| 人工门禁 | `user_gate` 等待 owner 决策 | 通知人，保存等待条件 |
| focus wait | 当前没有推进焦点或需避开人工处理段 | 重新选焦点或等待 |
| 外部等待 | monitor、外部事件、依赖尚未就绪 | 保存 resume condition |
| 节流 | 刚刚运行过，或 cadence 未到 | 计算下一次合法窗口 |
| 硬暂停 | Goal stopped 或 compute quota 为零 | 需 owner 改变策略 |

### `true` 仍然受限

`normal_delivery_allowed=false` 时，系统可能允许恢复或观察，但不允许把结果当成正常交付。`capability_gate` 说明能力前置不满足；`interaction_contract` 说明是否需要确认、是否允许发送；`automation_liveness` 说明自动轮次是否还有合法生命周期。真正的 action 仍要通过 typed authority。

## 5. 一条可观察链路

```text
Goal state + Todo frontier + claim/lease + gates + quota
  → candidate route
  → live monitor / wake / interaction inputs
  → capability gate
  → normal_delivery_allowed
  → should_run payload
  → turn envelope（<= 8,192 基础字节）
  → Turn plan
```

调试时不要只打印 `should_run`。至少同时打印 `quota.state`、blocking reason、`normal_delivery_allowed`、`capability_gate`、`interaction_contract.kind` 与 envelope budget。

## 6. 实验

### 实验 A：制造三类 false

用测试 fixture 分别构造：`paused`、`operator_gate`、`waiting`。参考验收：三者都返回 `should_run=false`，但 `resume` 原因和合法下一动作不同；不能统一写成“稍后重试”。

### 实验 B：区分准入与权限

保留 `should_run=true`，同时注入一个未 ready 的 Provider。参考验收：出现 `capability_gate`，Host 不应自行换成不存在的能力，也不能把失败写成正常完成。

### 实验 C：触发 envelope 预算

在测试里扩大可重算上下文，直到超过 8,192 字节。参考验收：报告 `turn_envelope_budget_exceeded`（warning/超限诊断），identity、receipt 和结算字段仍必须保持完整。

### 实验参考答案

1. 三者都 false，但恢复条件不同：paused 等待解除暂停，operator_gate 等待人工门禁，waiting 等待外部/前置条件；不能统一重试。
2. 应出现 capability gate 并阻止 Host 运行，不能伪装成 ready Provider，也不能把未执行写成完成。
3. envelope 超限应产生明确 warning/diagnostic，并保留 identity、receipt 和结算字段；不能靠删除关键字段压小。

## 7. 失败与恢复

| 现象 | 先查什么 | 恢复原则 |
| --- | --- | --- |
| 一直 false 但没有等待原因 | `quota.state`、Todo frontier、health | 补明确 reason，不盲重试 |
| true 后 Host 做了越权动作 | action authority、scope、interaction contract | 在动作入口拒绝，不靠提示词 |
| capability 缺失仍运行 | `capability_gate`、Provider 生命周期 | 修能力或改成合法等待 |
| envelope 超限 | 投影字段和可重算内容 | 压缩说明，不删除 identity/结算合同 |
| monitor 唤醒后仍等待 | `automation_liveness`、resume condition | 重新计算事实，不复用旧判断 |
| 恢复轮被当正常交付 | `normal_delivery_allowed` | 走恢复语义，禁止伪装 completion |

## 8. 通关自测

1. `should_run=false` 为什么不能统一按“没工作”处理？
2. `should_run=true` 之后还有哪些硬边界？
3. `capability_gate` 与 `normal_delivery_allowed` 分别限制什么？
4. 为什么等待要保存 resume condition，而不是只写“以后再看”？
5. envelope 超预算时，为什么不能无差别删除字段？
6. 自动唤醒为什么还要看 `automation_liveness`？

### 参考答案

1. false 的原因决定恢复路径：健康问题要修事实，人工门禁要等人决策，focus wait 要重选焦点，外部等待要等事件，节流要等窗口，硬暂停要 owner 改变策略。把它们合并会制造无意义的重试或错误唤醒。
2. 还要通过 Goal/Todo scope、claim/lease、user gate、workspace guard、typed action authority、capability readiness、interaction/approval 和 envelope 合同。`should_run` 只表示可进入候选，不表示每个工具和副作用都获准。
3. `capability_gate` 限制领域能力是否声明、安装、启用、就绪以及是否缺少 owner；`normal_delivery_allowed` 限制本轮能否按正常交付路径产出结果，恢复或观察路径不能冒充普通完成。
4. resume condition 是可重算、可审计的事实条件，下一轮能据此判断是否仍应等待。模糊的“以后再看”没有 owner、事件或时间依据，容易无限空转或过早运行。
5. 字段可能承载 turn identity、receipt、gate、scope 和恢复条件。正确做法是压缩可重算的解释性投影，保留合同字段，并让超限成为可见诊断。
6. 旧 heartbeat 可能已经停止、被暂停、失去 scheduler 所有权或错过唤醒窗口。`automation_liveness` 把“有定时器”与“当前自动轮次仍合法”分开，避免复活过期执行。

## 9. 源码坐标

- `loopx/control_plane/quota/states.py`
- `loopx/control_plane/quota/should_run.py`
- `loopx/control_plane/quota/should_run_prepare.py`
- `loopx/control_plane/quota/should_run_packet.py`
- `loopx/control_plane/quota/live_decision.py`
- `loopx/control_plane/quota/turn_envelope.py`
- `loopx/control_plane/quota/turn_envelope_budget.ts`
- `loopx/control_plane/todos/user_gate.py`

## 10. 下一步

进入阶段 3：准入已经通过，接下来必须把“这一轮到底是谁、看到什么、按什么顺序提交”固化成 Turn 合同。
