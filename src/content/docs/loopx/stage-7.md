---
title: "阶段 7：CLI、Dashboard 与扩展"
description: "阶段 7：CLI、Dashboard 与扩展。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 6，理解事实与投影
> 对应总览：`02-核心机制.md` 的界面与扩展部分
> 本阶段目标：看清同一控制面怎样服务人、脚本、Host 与外部渠道，而不复制业务内核。

## 1. 本阶段解决什么

LoopX 有 CLI、Dashboard、Lark/IM、Goal Mode、不同 Agent Host。它们看起来是多个产品，实际上都应该遵守同一条边界：

- 事实由 registry/state/journal 提供；
- 读模型由 status/presentation 生成；
- 动作由 typed command/authority 处理；
- Host adapter 只负责对接具体模型运行时；
- 渠道只负责 ingress/egress，不重写目标事实。

如果每个界面都自己保存一份“当前任务”，系统会立刻失去单一事实源。

## 2. 先记住一个判断

**界面是消费者，不是控制面本身；Host adapter 是翻译层，不是规则层。**

CLI 输出可以帮人和 Agent 决策，但输出格式变化不能改变 should-run、validation 或 settlement 的语义。

## 3. 源码主线

1. `cli.py` 组装命令族：status、turn、quota、todo、goal、presentation、dash、扩展能力等，并统一 JSON/markdown 输出。
2. `status_server.py` 提供只读/控制 API 投影，Dashboard 从 `collect_status()` 与 presentation 层取数。
3. `presentation/` 负责 markdown/HTML/API 视图，`renderers/status_markdown.py`、`turn_envelope_markdown.py` 等只渲染已有事实。
4. `pi_goal_mode/`、`zcode_goal_mode/`、`dsh_goal_mode/`、`opencode_goal_mode/` 把 LoopX 合同翻译成不同 Host 的调用方式。
5. `turn_driver/host_process.ts`、`host_bridge_transport.py`、`host_interaction.ts` 负责进程、stdio、交互与超时边界。
6. `extensions/lark/` 等渠道处理事件、身份、回执和用户通知，但仍回到同一状态与 Turn 入口。

## 4. 关键对象与合同

| 入口 | 输入 | 输出 | 不应拥有 |
| --- | --- | --- | --- |
| CLI | argv、workspace/runtime 配置 | 人类或机器可读投影 | 独立状态数据库 |
| status server | 查询/控制请求 | status、attention、action 投影 | 直接伪造完成 |
| Dashboard | 读模型 | 可视化 | 另一套 Todo 事实 |
| Goal Mode adapter | Host request | Host result/事件 | 自己的 validation 规则 |
| extension/channel | 外部事件 | normalized ingress | 绕过 gate/quota |
| Host process | 合同与上下文 | typed candidate | 直接写 canonical state |

### Goal Mode 为什么不是另一个内核

不同 Host 的模型、工具协议和会话机制不同，所以需要 adapter 翻译请求和结果。但 Turn identity、envelope、validation、writeback、spend 仍由 LoopX 内核拥有。adapter 不能因为某个 Host 更方便就跳过阶段。

### 为什么 CLI 要保留 JSON

人读 markdown 适合定位，脚本和 Agent 需要稳定字段。`next_cli_actions`、quota reason、envelope、receipt 都能以结构化方式消费；但推荐动作只是 steering，执行时仍要过 authority。

## 5. 一条可观察链路

```text
CLI / Dashboard / IM event
  → normalized command or ingress
  → registry + status projection
  → should-run / typed action authority
  → Turn plan
  → Goal Mode Host adapter
  → host process / bridge
  → typed result 回到内核结算
  → status refresh
```

注意最后一段：结果必须回到内核，而不是由 adapter 自己更新 Dashboard 数据源。

## 6. 实验

### 实验 A：追踪一个 status 字段

从 Dashboard 看到 `should_run`，沿 `collect_status()` → should-run payload 找到源字段。参考验收：能指出字段来自 quota/route，而不是 presentation 自己计算。

### 实验 B：比较两个 Goal Mode

阅读 `pi_goal_mode` 与 `dsh_goal_mode` 的 host adapter。参考验收：两者宿主协议不同，但都接收同一 turn identity/envelope，并把结果交回相同验证与结算。

### 实验 C：从渠道注入事件

用扩展测试构造一条外部事件。参考验收：事件先变成可审计 ingress，再过 gate/authority；不能直接写 Todo 完成或跳过 quota。

### 实验参考答案

1. `should_run` 的来源应是 quota/route 等 canonical 决策与状态，presentation 只展示，不自行计算事实。
2. `pi_goal_mode` 与 `dsh_goal_mode` 的宿主协议可以不同，但必须共享 turn identity/envelope，并回到同一 validate/writeback/spend 语义。
3. 外部事件必须先成为可审计 ingress，再经过 gate/authority；不能直接写 Todo 完成、跳过 quota 或伪造 next action。

## 7. 失败与恢复

| 失败 | 常见根因 | 恢复 |
| --- | --- | --- |
| Dashboard 与 CLI 不一致 | 投影缓存/版本不同 | 以 canonical state 重算 |
| Host adapter 吞掉字段 | 翻译层丢失合同 | 修 adapter，补契约测试 |
| 渠道重复投递 | 缺幂等 ingress | 用事件 id/回执去重 |
| 推荐动作不可执行 | 投影过期或 authority 变化 | 重新 should-run/authority |
| Host 进程超时 | 工具/模型长期阻塞 | 保留 journal，按恢复策略续 |
| UI 直接改完成 | 绕过 writeback | 移除写入口，回到 typed command |

## 8. 通关自测

1. CLI、Dashboard、Goal Mode 三者分别消费什么、拥有什么？
2. 为什么 Goal Mode adapter 不能自己判定 completion？
3. 推荐动作为什么不能作为权限白名单？
4. 外部渠道的重复消息应怎样处理？
5. Host 进程崩溃后，adapter 为什么不能私自重跑？
6. 怎样验证一个界面没有偷偷维护第二套状态？

### 参考答案

1. CLI 消费命令与事实投影，产出人类/机器可读结果；Dashboard 消费 status/presentation 读模型；Goal Mode 消费 turn contract 并翻译 Host 协议。它们都不能拥有 canonical Goal/Todo/配额事实或结算权。
2. completion 需要证据验证、lifecycle writeback、spend 和 closeout。adapter 只看到 Host 候选结果，不能证明这些阶段已提交；自行判定会绕过内核并制造假完成。
3. 推荐动作只是 steering，可能因版本、筛选或权限裁剪而过期。合法动作仍要重新过 typed authority、preflight、receipt binding 和结算；禁止动作应返回明确错误。
4. 使用稳定事件 id/ingress receipt 去重，并区分“已接纳”和“已处理”。重复投递只能回放已有状态，不能再次执行副作用。
5. adapter 不知道 Host effect 是否已发生，也不知道 journal 提交到哪一阶段。私自重跑可能重复工具副作用；必须回到内核读取 journal/receipt 后按前缀恢复。
6. 修改界面显示后刷新 canonical 状态，看是否回到事实；再追踪写操作是否都经过 typed command、authority、journal 和 receipt。若界面有自己的持久化桶，就是第二套状态。

## 9. 源码坐标

- `loopx/cli.py`
- `loopx/status.py`
- `loopx/status_server.py`
- `loopx/presentation/`
- `loopx/presentation/renderers/status_markdown.py`
- `loopx/pi_goal_mode/`
- `loopx/zcode_goal_mode/`
- `loopx/dsh_goal_mode/turn_host_adapter.py`
- `loopx/control_plane/turn_driver/host_process.ts`
- `loopx/extensions/lark/`

## 10. 下一步

进入阶段 8：这些边界靠什么工程手段保证？测试、journal、原子写和恢复审计如何防止系统在崩溃与并发中失真？
