---
title: "03 · 工程实战：怎样读懂、调试和修改 LoopX"
description: "通过调试、实验、失败矩阵和恢复演练验证控制面改动。"
---

> 基线：LoopX `v2.1.1`。本章把前面的模型变成可操作的工作方法。

## 1. 先建立“证据优先”的调试习惯

LoopX 的很多问题看起来像模型行为问题，实际是控制面状态问题。遇到异常时，不要先改 prompt，而要先定位：

```text
命令没注册？             → entrypoint / cli.py
找不到 Goal/项目？       → registry / runtime root / state_file
should-run 选错？        → quota / todo projection / gate / claim
Turn 没启动？            → route / admission / host adapter
执行结果被拒？           → result kind / validation / receipt binding
写回或恢复失败？         → journal / settlement / authority
页面数据不对？           → projection / history / cache
```

### 1.1 先读 JSON，不先猜代码

仓库 `docs/development/project-code-tour.zh-CN.md` 推荐的排错入口是：

```bash
loopx status --format json
loopx quota should-run --goal-id <goal-id> --agent-id <agent-id> --format json
loopx history --format json
loopx commands --format json
```

如果版本/参数有差异，先用 `loopx commands --format json` 查命令面，不要凭记忆写参数。

读 `should-run` 时至少记录：

- `effective_action`
- `selected_todo.todo_id`
- `scheduler_hint`
- `interaction_contract`
- `requires_user_action`
- `next_cli_actions`
- reason / blocker / gate 字段

然后只追这条决策实际读取的模块，不要从仓库根目录盲读。

### 1.2 遇到 duplicate / stale effect，先看 identity

优先检查：

```text
goal_id
agent_id
todo_id
turn_instance_id
turn_key
effect_id
completed_phases
failed_phase
receipt identity
```

这些字段决定“这是同一个 Turn，还是新 Turn”。如果 identity 对不上，再聪明的重试也可能写出重复副作用。

---

## 2. 本地环境

`pyproject.toml` 要求 Python 3.11+，TypeScript 控制面要求 Node.js 22.22.3+。贡献指南使用 `uv`：

```bash
uv sync --extra test
npm ci
```

首次跑 Python 架构测试前，需要先 `npm ci`，因为它们会解析 TypeScript 控制面。命令面可用：

```bash
uv run --extra test python -m pytest -q <test files>
npm run -s typecheck:control-plane
npm run -s test:control-plane
```

静态检查：

```bash
uv run --extra test python -m ruff check tests loopx/canary loopx/control_plane loopx/domain_packs loopx/presentation
uv run --extra test python -m mypy
```

第一次不要跑全量。LoopX 仓库很大，正确顺序是：

1. 改动点对应的单测；
2. 相邻 contract / recovery 测试；
3. architecture boundary 测试；
4. Typecheck；
5. 最后全量。

---

## 3. 实验 A：跟一次 should-run 决策

### 目标

理解为什么系统选择了一个动作，而不是只看最终 JSON。

### 步骤

1. 选一个测试 fixture 或你拥有的本地 Goal；不要在真实生产 Goal 上做写实验。
2. 运行 `quota should-run --format json`。
3. 把输出分成四块：

```text
state facts: goal / todo / gate / quota
decision: effective_action / route / selected_todo
boundary: interaction_contract / allowed/blocked scope
continuation: scheduler_hint / next_cli_actions / terminal
```

4. 用 `rg -n "<字段名>" loopx/control_plane` 反查组装点。
5. 画出从 status → quota → should-run packet 的字段流。

### 验证问题

- 如果 `should_run=false`，它是在等待、门禁、限流、暂停还是健康阻断？
- 如果 `selected_todo` 为空，为什么不能直接报“没有工作”？
- `next_cli_actions` 是唯一的合法动作集合吗？

---

### 实验 A 参考答案

- `should_run=false` 不能只看布尔值，要读 `effective_action`、route/reason、quota state、gate、attention 和 health。它可能在：等待 monitor/外部条件、operator gate、throttle/预算窗口、人为 pause、健康阻断，或需要 repair/replan。
- `selected_todo` 为空不等于“没有工作”。可能所有工作被 gate/claim/scope 挡住，可能当前只允许安全只读动作，也可能需要在多个 Goal/优先级间重新规划。必须看 blocked scope 与 attention 原因。
- `next_cli_actions` 不是唯一合法集合，只是 steering。合法性由 typed authority、transition contract、preflight 和 receipt binding 决定；推荐动作也必须重新校验。

## 4. 实验 B：跟一次 Turn 的七阶段

### 目标

把 `completed_phases` 与真实 effect 对齐。

### 步骤

1. 在测试里构造一个 fake host/validator/writeback/spend，不要用真实外部写。
2. 调用 `turn plan` 或直接调用 `build_loopx_turn_plan()`，确认 plan 不产生 effect。
3. 调用 `run_loopx_turn_once()`，分别模拟：
   - host success + validation success；
   - validation failure；
   - writeback failure；
   - spend failure；
   - terminal closeout failure。
4. 每次用 `turn inspect-journal --goal-id ... --agent-id ... --turn-key ...` 读取 journal。
5. 在纸上标出哪些 phases 是 committed，哪些 effect 有 readback，但尚未 checkpoint。

### 实验 B 参考观察

下面五条就是本题的参考结论：

- Host 返回时 phases 最多到 `typed_result`；
- validation 之后才有 material writeback 资格；
- writeback checkpoint 之后才能 spend；
- `terminal_closeout_failed` 发生在前五阶段完成之后；
- 恢复不得重复已提交 effect。

### 推荐测试文件

从这些方向找相邻测试：

```text
tests/test_loopx_turn_executor.py
tests/control_plane_ts/*turn*.test.ts
tests/architecture/test_control_plane_import_boundaries.py
```

不要只断言“函数返回 200”，要断言 journal 的 phase、receipt、effect flags 和 recovery 行为。

---

## 5. 实验 C：从 Capability 看领域边界

挑一个实际 Capability，例如 issue fix 或 PR review，跟一遍：

```text
CLI handler
  → capability contract
  → provider observe/effect
  → normalized evidence
  → typed transition proposal
  → Kernel validation / writeback
```

每一步问：

- 哪一步只返回 proposal，不写 durable state？
- 哪一步必须 readback？
- 哪一步可以重试，哪一步必须幂等？
- 哪一步会改变 Todo/Turn/quota？
- 这个 Capability 是否偷偷 import 了 presentation 或 Kernel 私有内部？

如果业务能力直接改 Goal 文件，这是边界错误；如果 provider 自己把 Todo 标成 done，也是边界错误。

---

### 实验 C 参考答案

一个典型 Capability 链应分成：

| 步骤 | 产物 | 是否可写 canonical state | 恢复重点 |
| --- | --- | --- | --- |
| CLI/command | 参数与目标 identity | 否 | 幂等请求、参数校验 |
| Capability contract | 成功条件、允许 transition、error taxonomy | 否 | 合同版本与 lineage |
| Provider observe/effect | 外部 observation/effect receipt | 否（只能提交 typed proposal） | readback、幂等键 |
| normalized evidence | 有来源、时间、范围的事实 | 否 | 新鲜度与可验证性 |
| typed transition proposal | 希望发生的变化 | 否 | 绑定 Goal/Todo/Turn |
| Kernel validation/writeback | accepted state 与 durable receipt | 是 | CAS、lease、journal、readback |

因此：proposal 之前都不能直接改 Goal/Todo；任何外部 effect 都必须有 readback 或幂等身份；重试只能重做“未确认”的步骤。Capability 若直接 import presentation 或写 Kernel 私有状态，是边界错误；Provider 若自行把 Todo 标成 done，也是把 observation 偷换成了 transition。

## 6. 失败矩阵：看到结果该做什么

| 结果/症状 | 首先检查 | 正确处理 | 错误做法 |
| --- | --- | --- | --- |
| `contract_error` | TurnEnvelope schema/signature/lineage | 修合同或重新生成 envelope | 强行改 route |
| `blocked` | gate/claim/scope/capability | 等或补充前置事实 | 把 blocked 当 host_failure |
| `wait` | monitor/resume condition | 安排下一次观察 | 热轮询、重复花配额 |
| `host_failure` | host executable/session/admission | 修 Host 或按策略重试 | 直接改状态说成功 |
| `validation_failed` | validator、evidence 新鲜度 | 重新取证/修复结果 | 跳过 validation 写回 |
| `writeback_failed` | authority/lock/schema | 修复写回，保留 host 结果 | 重跑 Host 产生重复外部副作用 |
| `quota_spend_failed` | spend receipt/配额账本 | 读回执，补未提交步骤 | 重复 spend |
| `terminal_closeout_failed` | closeout receipt | 只补 closeout | 重做 writeback/spend |
| 两轮无进度 | stall/self-repair 条件 | 检查 projection/claim/gate/budget | 换个 prompt 继续烧配额 |
| 页面过期 | runtime projection/history | 重新派生或修 projection | 把 UI 当事实源 |

---

## 7. 修改 LoopX 时的四条边界

### 7.1 先判断改的是哪一层

| 你想改什么 | 应该改哪里 | 不该改哪里 |
| --- | --- | --- |
| 某个业务的验收规则 | Capability | Kernel 通用状态机 |
| 外部系统调用 | Provider | Todo 生命周期 |
| 新 Host | goal-mode / adapter | 复制一套 quota/scheduler |
| 展示排序 | presentation/projection | canonical state |
| Turn 阶段/幂等 | Kernel contract + tests | 仅改 CLI 文案 |
| 权限/范围 | typed authority/transition | prompt 里加一句“不要” |

### 7.2 任何新 effect 都要回答五个问题

1. 稳定 identity 是什么？
2. 重复请求如何识别？
3. 已发生但未 checkpoint 时如何 readback？
4. 失败后哪一个 checkpoint 决定是否重试？
5. 它是否改变 quota/claim/gate/terminal 语义？

回答不出来，就不要把 effect 加进执行路径。

### 7.3 不要用自由文本承载机器事实

- 结果分类用 enum；
- 权限用 typed contract；
- 推荐动作用 advisory 字段；
- evidence 用稳定引用；
- closeout 用明确 receipt。

自然语言可以解释“为什么”，但不能成为“是否允许”或“是否完成”的唯一依据。

### 7.4 修改合同必须同时改证据

涉及以下内容时，必须补测试和兼容说明：

- schema version；
- transaction phase；
- result kind；
- receipt binding；
- quota state；
- Todo status；
- scheduler ack；
- public/private projection。

只改实现不改合同，会出现“测试都过、旧 journal 无法恢复”的问题。

---

## 8. 设计评审清单

提交一个 LoopX 改动前逐条问：

- [ ] 这个变化的事实源是哪个 canonical state？
- [ ] 它是否只是一份 projection？如果是，是否只读？
- [ ] 是否新增了隐式权限或把建议当白名单？
- [ ] 是否新增了不可逆 effect？identity 和幂等在哪里？
- [ ] 崩溃点落在哪个阶段？journal 能证明什么？
- [ ] 恢复时是否会重复 writeback/spend/closeout？
- [ ] `should_run=false` 的每一种原因是否仍可区分？
- [ ] 是否触碰 public/private 边界？
- [ ] 是否有 focused test 覆盖 happy path 和一个恢复路径？
- [ ] 是否保持了 CLI fallback？
- [ ] 是否让 control plane 依赖了 CLI/capability/presentation？
- [ ] 是否需要 RFC 或 migration note？

---

## 9. 毕业设计：做一个 mini control plane

不要重写 LoopX。做一个最小实现，验证你是否真的理解它。

### 最低功能

- [ ] Registry 与一个 Goal；
- [ ] Todo 的四种状态；
- [ ] claim/lease 与一个明确的 workspace scope；
- [ ] quota 状态机，至少覆盖 eligible / waiting / paused；
- [ ] should-run 输出 selected todo + reason + continuation；
- [ ] Turn 计划与七阶段事务；
- [ ] 一个 host、一个 capability、一个 provider；
- [ ] durable writeback、quota spend、scheduler ack；
- [ ] journal 与崩溃恢复；
- [ ] 一份只读 status projection；
- [ ] 至少五个恢复测试：writeback 未确认、spend 未确认、closeout 失败、duplicate request、stale identity。

### 必须能解释

- 为什么模型上下文不是长期状态；
- 为什么 observation 不等于 transition；
- 为什么写回在 spend 前；
- 为什么已提交 effect 不能重做；
- 为什么 projection 不能拥有写权限；
- 为什么 claim 不是永久 leader；
- 为什么推荐动作不等于权限。

做到这里，你已经不是在“背 LoopX API”，而是掌握了一套能迁移到任何长程 Agent 系统的控制面设计方法。

---

### 毕业设计“必须能解释”参考答案

1. **模型上下文不是长期状态**：它是一次投影/工作记忆，可能过期、被截断、被注入；canonical state 在 Registry/authority/journal 中，必须可重建。
2. **observation 不是 transition**：看到 PR 页面 merged 只是输入；还要 Provider 归一化、Capability 按验收验证、Kernel 接受并 writeback。
3. **写回在 spend 前**：先有 durable 交付，才有资格扣预算；否则会出现“花了钱但没有可证明结果”的不确定状态。
4. **已提交 effect 不能重做**：外部动作可能不可逆；重做会重复副作用/扣费。恢复必须先读 receipt/readback，只补未提交阶段。
5. **projection 不能有写权限**：否则 UI/看板会成为第二事实源，排序、缓存或人工拖动就能偷偷改变权限与生命周期。
6. **claim 不是永久 leader**：它只是有期限、有 scope 的责任；过期/失效后必须让位，否则崩溃或网络分区会永久占住工作。
7. **推荐动作不等于权限**：`next_cli_actions` 只帮助选择路径；真正的授权在 typed authority/transition contract，仍然要过 preflight、receipt binding、validation 和 writeback。

## 10. 最后一张图

```text
                  ┌──────────────┐
                  │  Goal State  │
                  └──────┬───────┘
                         │
         ┌───────────────▼────────────────┐
         │ Registry + Authority + History │
         └───────────────┬────────────────┘
                         │ projection
                         ▼
                  Status / Attention
                         │
                         ▼
                 Quota decision
                         │
                         ▼
              Turn plan (no effects)
                         │
                         ▼
          Host → Capability → Provider
                         │
                         ▼
       validation → writeback → spend
                         │
                         ▼
             scheduler apply / ack
                         │
                         └──────────────► 下一轮
```

如果你能在白板上从 Goal 画到下一轮，并在每个箭头旁写出“事实源、权限、失败恢复”，这门课就可以结束。

---

*基于 LoopX v2.1.1（`87e5b4f8`）源码编写 · 2026-10-31*
