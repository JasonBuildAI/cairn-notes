---
title: "阶段 0：环境与源码地图"
description: "阶段 0：环境与源码地图。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：读完 `overview.md`
> 对应总览：`overview.md`、`turn-lifecycle.md`
> 本阶段目标：拿到版本基线，建立“六层事实 + 一条主链”的源码地图。

## 1. 本阶段解决什么

先避免三个常见误读：

- 把 LoopX 当成又一个模型循环框架；
- 把 Status 或 prompt 当成事实源；
- 把 Host 返回一段 JSON 当成工作已经完成。

本阶段要建立的地图是：

```text
入口与投影
  CLI / Dashboard / Goal Mode adapter
        │
        ▼
控制面事实
  Registry / Goal State / Todo / Claim / Gate / Authority / History
        │
        ▼
决策与合同
  Status projection / Quota should-run / Turn Envelope / Transaction
        │
        ▼
Host 与领域能力
  Host adapter / Capability / Provider / readback
        │
        ▼
结算与恢复
  Validation / Writeback / Spend / Scheduler / Journal
```

## 2. 先记住一个判断

**LoopX 的核心资产是“可恢复的长期状态”，不是某次模型输出。**

所以你读源码时，优先级应当是：状态归属 > 合同与不变量 > 失败恢复 > 模型提示词。提示词很重要，但它只是当前投影的一种消费者。

## 3. 源码主线

1. `loopx/cli.py` 和 `loopx/cli_commands/` 是人与脚本入口，负责解析命令并打印公开 payload。
2. `loopx/registry.py` 维护已注册 Goal、路径和全局健康信息。
3. `loopx/control_plane/goals/` 负责 Goal 生命周期、状态解析、frontier、验收与方向基线。
4. `loopx/control_plane/todos/` 负责 Todo 合同、状态、完成事务、gate 与投影。
5. `loopx/control_plane/quota/` 负责 should-run、选路、预算、消费与 envelope。
6. `loopx/control_plane/turn_driver/` 负责 host 请求、typed result、validation、settlement、journal 和 recovery。
7. `loopx/capabilities/` 与 `loopx/extensions/` 负责领域能力、Provider 和 Host 适配。
8. `loopx/presentation/`、Dashboard 和 IM 只是读模型消费者。

## 4. 关键对象与合同

| 对象 | 事实源 | 不能拿什么替代 |
| --- | --- | --- |
| Goal | Registry + Goal State | 聊天里说“目标完成了” |
| Todo | Todo 合同与持久化状态 | Status 里的一行摘要 |
| Claim/Lease | claim 记录与期限 | 模型自称“我负责” |
| Gate | 前置事实、人工决定、验收条件 | 推荐动作的排序 |
| Quota | 配额与 should-run 决策 | 本次调用有没有报错 |
| Evidence | 可选证据与 validation receipt | Host 的自然语言总结 |
| Run History | run/turn journal 与 receipt | SSE 事件是否收到 |

## 5. 一条可观察链路

```text
命令/自动化输入
  → registry 找到 Goal
  → status/refresh 生成当前 frontier
  → quota should-run 给出准入与推荐动作
  → turn plan 固定 identity、envelope、phases
  → host 执行
  → typed result 校验字段与 turn_key
  → validation / writeback / spend / scheduler
  → journal 留下已完成前缀
  → 下一次 refresh 重算 frontier
```

## 6. 实验

### 实验 A：确认版本与目录

```powershell
cd $LOOPX_SRC
git describe --tags --always
git rev-parse HEAD
rg --files loopx\control_plane | Measure-Object
```

参考验收：tag 为 `v2.1.1`，commit 以 `87e5b4f8` 开头；能看到 `goals/`、`todos/`、`quota/`、`turn_driver/`、`scheduler/`。

### 实验 B：从入口反查实现

```powershell
rg -n "def register_turn_commands|def register_status_commands" loopx
rg -n "build_quota_should_run|build_loopx_turn_transaction_plan" loopx
```

参考观察：命令注册函数只做参数与展示；真正的决策与合同在 `control_plane`。

### 实验 C：给文件贴层标签

从 `loopx/control_plane` 任选 10 个文件，为每个文件标注“事实 / 决策 / 合同 / 执行 / 结算 / 投影”。如果标不出来，说明还没有抓住它的输入输出。

### 实验参考答案

1. 应核对到 `v2.1.1` 且 commit 前缀与仓库一致；`control_plane` 下能看到 goals、todos、quota、turn_driver、scheduler 等目录。
2. 命令注册层只解析参数和展示，should-run/Turn Plan 的决策与合同由 `control_plane` 构造。
3. 每个文件都应能按输入输出归入事实、决策、合同、执行、结算或投影；归不进去通常说明还没找到它的所有权。

## 7. 失败与恢复

| 现象 | 常见误判 | 正确入口 |
| --- | --- | --- |
| `should_run=false` | 认为系统坏了 | 看 reason、state、waiting_on、health/gate |
| 有 Host 输出但状态没变 | 认为 writeback 自动发生 | 查 validation、receipt、completed_phases |
| Status 与 DB 不一致 | 直接改 Status | 先查事实源，再 refresh 投影 |
| 重启后重复执行 | 只看“上次是否报错” | 读 journal 的已完成阶段与 effect id |
| 推荐动作缺失 | 认为该动作非法 | 重新过 authority/preflight，推荐不是白名单 |

## 8. 通关自测

1. LoopX 与 Host 的责任边界是什么？
2. 为什么 Registry、Goal State、Run History 不能合并成一份聊天记录？
3. 看到一个文件时，怎样快速判断它属于事实层还是投影层？
4. 为什么“有 Host 输出”不能证明 Turn 已提交？
5. 版本基线为什么必须和源码坐标一起记录？

### 参考答案

1. Host 提供模型、工具和一次有界执行；LoopX 负责选择、授权、合同、验证、写回、消费、调度和恢复。LoopX 不拥有模型循环，Host 也不拥有长期事实。
2. 聊天记录会压缩和换会话，无法稳定表达 Todo 身份、claim 期限、gate 前置、quota 消费和 effect 幂等键；三者合并会让恢复只能依赖自然语言推断。
3. 看它是否保存“可被后续流程独立读取并据此拒绝动作”的状态。若只是从别处计算出来给人看，通常是投影；若被写出且作为恢复依据，通常是事实。
4. Host 输出只是候选事实，还要过 turn_key、字段与证据校验，validation 通过后写回，再完成消费和调度；任何一步都可能停在半途。
5. 不同版本的字段、阶段顺序和默认策略会变化。没有版本与 commit，源码坐标就无法复核，结论容易把旧版行为当成当前事实。

## 9. 源码坐标

- `README.md`
- `pyproject.toml`
- `loopx/cli.py`
- `loopx/registry.py`
- `loopx/status.py`
- `loopx/control_plane/goals/`
- `loopx/control_plane/todos/`
- `loopx/control_plane/quota/`
- `loopx/control_plane/turn_driver/`
- `loopx/capabilities/`

## 10. 下一步

进入阶段 1：先把 Goal、Todo、Claim、Gate、Run 和投影的对象关系理顺，再看它们怎样被 quota 选择。
