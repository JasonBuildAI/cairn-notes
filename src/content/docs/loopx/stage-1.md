---
title: "阶段 1：对象模型与控制面"
description: "阶段 1：对象模型与控制面。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 0，知道六层地图
> 对应总览：`overview.md`、`core-mechanisms.md`
> 本阶段目标：厘清 Goal、Todo、Claim、Gate、Run 与 projection 的所有权。

## 1. 本阶段解决什么

长程系统最容易出现的错误不是“模型不聪明”，而是对象被混用：

- 把 Goal 当成一条长期聊天；
- 把 Todo 当成模型随手写的 checklist；
- 把 claim 当成“模型说自己负责”；
- 把 gate 当成排序建议；
- 把 run history 当成调试日志；
- 把 status 当成事实源。

本阶段把每个对象放回它的位置。

## 2. 先记住一个判断

**Goal 是“为什么持续做”，Todo 是“下一次可验收的动作”，Run/Turn 是“一次有边界的执行”，Status 是“现在该看哪里”。**

四者不能互相替代：
- Goal 完成不等于某张 Todo 完成；
- Todo 勾选不等于证据通过；
- Turn 成功不等于 Goal 完成；
- Status 显示“运行中”不等于进程真的拥有 lease。

## 3. 源码主线

1. `loopx/registry.py`：注册 Goal、解析路径、暴露全局健康与 canonical runtime root。
2. `loopx/control_plane/goals/state_resolution.py`：把 Goal 的生命周期、方向、验收与当前 frontier 解析成可决策状态。
3. `loopx/control_plane/goals/goal_frontier/`：计算可运行/被阻塞/等待中的前沿，生成 replan 与 successor 规则。
4. `loopx/control_plane/todos/contract.py`：定义 Todo 的身份、状态、scope、依赖与字段规范化。
5. `loopx/control_plane/todos/completion_transaction.py`：完成不是“改 status”，而是带校验的完成事务。
6. `loopx/control_plane/todos/user_gate.py`：人工门禁、等待条件和恢复。
7. `loopx/control_plane/runtime/run_history.py`：记录执行历史，供审计、连续性判断和恢复。
8. `loopx/status.py`：把上述事实编译成公开状态与 attention 投影。

## 4. 关键对象与合同

| 对象 | 回答的问题 | 所有权 | 典型失败 |
| --- | --- | --- | --- |
| Goal | 为什么持续做，边界是什么 | Registry + Goal State | 目标漂移、重复激活 |
| Direction | 哪个方向仍有效 | direction/authority 合同 | 旧方向被未授权覆盖 |
| Todo | 下一步做什么，何时算完成 | Todo store + completion contract | 自报完成、依赖绕过 |
| Claim/Lease | 谁在什么 scope 内负责 | claim 记录与期限 | 两个 Agent 同时做同一张 |
| Gate | 什么前置条件必须先满足 | user/capability/workspace gate | 把 wait 当成 deny |
| Run/Turn | 这次执行做到哪一步 | journal + receipts | 只凭 stdout 判断成功 |
| Evidence | 哪些观察能支持结论 | evidence store + validation | 把猜测写成事实 |
| Projection | 现在该看什么 | status/frontier 计算 | 用投影反写事实 |

### Claim 与 Gate 的区别

Claim 回答“谁来做”；Gate 回答“现在能不能做”。有 claim 不代表通过 gate，通过 gate 也不代表这张 Todo 已被正确领取。

### Evidence 与 Validation 的区别

Evidence 是观察到的事实；Validation 是按领域合同判断这些事实是否足以支持某个 transition。Evidence 多，不等于 validation 一定通过。

## 5. 一条可观察链路

```text
Goal state
  → 计算 frontier
  → 过滤 done/blocked/waiting/dependency
  → 找到 selected Todo
  → 检查 claim 与 gate
  → 生成 should-run 候选
  → Turn 完成后写回 Todo/Goal/evidence
  → 重算 frontier
```

观察点：一次 Turn 后，先看 Todo 事实和 evidence 是否变化，再看 Status 是否变化。顺序反过来，容易把缓存刷新误认为业务完成。

## 6. 实验

### 实验 A：画对象关系图

从 `goal_frontier` 与 `todos/contract.py` 的字段出发，画一张图：Goal → Todo → claim → gate → run → evidence → completion。每个箭头写“谁写入、谁读取”。

### 实验 B：制造一个 blocked 但非 failed 的场景

构造一张依赖未满足的 Todo。参考验收：它出现在 frontier 的 blocked/waiting 视图中，但不应被错误地标成 failed，也不应消耗配额。

### 实验 C：区分投影与事实

连续读取两次 status，中间不改变任何事实。参考观察：Status 可以重新计算，但 Goal/Todo/claim 的 canonical 字段不应被 status 读取动作改写。

### 实验参考答案

1. Goal 提供长期目标，Todo 提供可执行单元，claim/lease 授予执行权，gate 判断当前是否允许，run 产生证据，completion 只由合法写回推动。
2. 依赖未满足应是 blocked/waiting，不是 failed，也不应消耗 quota；它等待的是前置事实变化，而不是执行错误。
3. Status 是读取时派生的投影；连续读取不能改写 Goal/Todo/claim 的 canonical 字段。

## 7. 失败与恢复

| 失败 | 根因 | 恢复 |
| --- | --- | --- |
| 两张 Todo 指向同一工作 | 身份/去重规则 | 用稳定 todo_id 和 scope 修复，不靠文本去重 |
| Claim 过期仍继续写 | 只看内存标志 | 重新读 lease 期限与 owner，失败就停写 |
| Gate 被绕过 | 把推荐动作当权限 | 在 typed action 入口重新检查 gate |
| 完成后 frontier 不变 | 写回了投影而非事实 | 查 Todo/Goal/evidence canonical 写入 |
| 重启后重复做同一张 | 没读 run history/receipt | 先读 journal 与 completion receipt |

## 8. 通关自测

1. Goal、Todo、Turn 三层各自回答什么问题？
2. Claim 和 Gate 为什么不能合并？
3. Todo 被勾选完成，为什么仍可能不能结束 Goal？
4. Status 与 canonical state 不一致时，应先查什么？
5. 为什么 run history 不是普通调试日志？

### 参考答案

1. Goal 回答“为什么持续做、边界是什么”；Todo 回答“下一次可验收的动作是什么”；Turn 回答“这一次执行做到哪一步、哪些 effect 已提交”。
2. Claim 管所有权与时间窗口，Gate 管动作前置条件。claim 不能证明前置事实已满足；gate 也不能解决两个 Agent 同时领取同一张 Todo 的竞争。
3. 勾选只是状态意图，Goal 结束还要满足 outcome/acceptance、后继安排、证据和终局条件；Todo 完成也可能只是进入下一张 frontier。
4. 先查 canonical Goal/Todo/claim/evidence 与 journal，再 refresh 投影。不要为了“看起来一致”直接修 Status。
5. 它保存 Turn、effect、receipt 和恢复前缀，能证明哪些副作用已经发生；普通日志通常不保证结构、顺序和幂等身份。

## 9. 源码坐标

- `loopx/registry.py`
- `loopx/status.py`
- `loopx/state_refresh.py`
- `loopx/control_plane/goals/state_resolution.py`
- `loopx/control_plane/goals/goal_frontier/`
- `loopx/control_plane/goals/acceptance.py`
- `loopx/control_plane/todos/contract.py`
- `loopx/control_plane/todos/completion_transaction.py`
- `loopx/control_plane/todos/user_gate.py`
- `loopx/control_plane/runtime/run_history.py`

## 10. 下一步

进入阶段 2：对象都在，但系统凭什么决定“现在运行”？这要从 `quota should-run` 的 false 分支开始读。
