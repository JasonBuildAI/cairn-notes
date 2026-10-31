---
title: "阶段 9：毕业设计"
description: "阶段 9：毕业设计。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 0～8
> 对应总览：全卷
> 本阶段目标：完成一个横跨工具面、持久化、宿主查看与故障恢复的小型改造，并能用证据验收。

## 1. 项目题：可恢复的项目笔记

实现一个只对当前 session/workspace 生效的 `project_note` 工具，并增加只读的 `session audit` 查看能力。

功能：

~~~text
project_note(action="append", text="...")
  → 生成 note receipt（note_id、hash、session_id）
  → 写 append-only notes 文件
  → 返回 tool result

project_note(action="list")
  → 只返回当前 session/workspace 的 notes

session audit
  → 关联 SessionDB 中的 admission / lease / tool call / tool result
  → 与 notes 文件回执对账
  → 输出可解释状态，不修改任何账本
~~~

这个题目看似简单，但它同时覆盖阶段 1～8：

- admission 与 lease：谁能执行、是否已执行；
- toolset 与 schema：模型能看见什么、参数边界；
- persist-before-execute：先有 call，才有副作用；
- context：工具结果怎样回到模型；
- provider：失败/换模型后结果仍可审计；
- SessionDB：call/result 与 note receipt 的关联；
- 扩展：CLI/TUI 的只读审计命令；
- 工程：崩溃点、幂等、路径安全和测试。

## 2. 先记住一个判断

**笔记文件是外部副作用，SessionDB 是调用事实，audit 只是对齐两者；三者不能互相伪造。**

不要：

- 用 `session audit` 直接修改 unknown 成成功；
- 只把笔记写进 tool result 而不落外部文件；
- 只看笔记文件就认为调用已持久化；
- 重试时只凭文本内容去重，而不使用稳定 call id。

## 3. 设计边界

### 3.1 工具面

- 工具名：`project_note`；
- actions：`append`、`list`；
- append 必填 `text`，限制长度、字符/路径安全；
- list 不接受任意 session id，只能读取当前 turn 绑定 session；
- 工具只加入明确授权的 toolset；
- `delegate`/cron 是否可见由 toolset 决定，不能默认全平台开放。

### 3.2 文件布局

建议使用 profile 隔离路径：

~~~text
$HERMES_HOME/session-notes/<session_id>.jsonl
~~~

每行是一条 append-only JSON 记录：

~~~text
call_id
note_id
session_id
workspace_key
text_hash
text
created_at
~~~

约束：

- 不返回宿主绝对路径给模型，只返回 note_id/hash 和逻辑位置；
- session id 必须经过安全校验，不能拼出 `../`；
- 写入使用 per-session 文件锁 + flush/fsync；
- 同一 `call_id` 重复执行返回同一 receipt；
- 同一 `call_id` 携带不同 text 时必须报冲突，不能覆盖。

### 3.3 审计面

新增只读 `session audit` 能力，可以最先做成 CLI 命令，再按需要接 TUI RPC。输出：

~~~text
session_id / canonical parent-child
admission status / request id
lease holder / expires_at（仅诊断）
tool call id / name / args hash
tool result 是否存在
note receipt 是否存在且 hash 一致
最终 assistant row / delivery receipt（若有）
~~~

审计命令不调用模型，不抢 turn lease，不修 DB。它只读并解释。

## 4. 三个必须守住的不变量

1. **先 call 后副作用**：SessionDB 没有 canonical call 时，工具不能产生笔记。
2. **幂等由 call id 决定**：同一调用重试得到同一 receipt；不同调用不能因文本相同而误合并。
3. **审计只对账不改账**：看到 call 缺 result、note 缺 receipt 或 hash 不一致，只能报告状态并走明确恢复。

## 5. 源码接入点

| 改动 | 主要位置 | 需要复用 |
| --- | --- | --- |
| tool handler/schema | `tools/` | 参数校验、错误格式 |
| 工具可见性 | `toolsets.py`、`model_tools.py` | platform、authorization、schema |
| 调用持久化 | `agent/turn_tool_round.py` | persist-before-execute |
| 执行与结果 | `agent/tool_executor.py` | timeout、pairing、commit |
| session 绑定 | `agent/turn_context.py` | canonical session id |
| 账本查询 | `hermes_state.py::SessionDB` | messages、admission、lease |
| CLI/RPC 入口 | `hermes_cli/`、`tui_gateway/` | 只读命令、profile scope |
| 测试 | `tests/tools/`、`tests/gateway/`、`tests/tui_gateway/` | 失败、恢复、协议 |

不要为了这个题目新造一套 session 查询器；优先复用 `SessionDB` 现有公开方法。

## 6. 实施顺序

### 第 1 步：纯函数与文件格式

- 定义 note record schema；
- 实现 call_id 去重、碰撞检测、文本 hash；
- 写路径校验与 append-only 读取。

### 第 2 步：工具合同

- 实现 `append` / `list`；
- 严格 schema，拒绝未知字段；
- 错误分类：未授权、参数非法、冲突、IO 失败、损坏文件。

### 第 3 步：接入 toolset

- 在允许的 toolset 中暴露；
- 验证 `get_tool_definitions()` 能看到；
- 验证平台限制和子 Agent 可见性。

### 第 4 步：持久化联动

- 用真实 `run_tool_round` 验证 call 先落库；
- 在 call flush 失败时确认 handler 不会被调用；
- 在 result commit 失败时确认 turn 终止。

### 第 5 步：审计命令

- 读取 admission、lease、tool messages、note receipts；
- 输出 `consistent / call_without_result / result_without_note / note_without_result / collision / unknown`；
- 不提供自动修复旁路。

### 第 6 步：恢复测试

- 在 append 前崩溃；
- 在 append 后、result 前崩溃；
- 在 result 后、final 前崩溃；
- duplicate call/不同 text；
- lease 丢失；
- compression 旋转后 canonical session 变化。

## 7. 验收标准

### 7.1 功能验收

- 同一 call id 重放 N 次，notes 文件只有一条记录；
- 不同 call id 可写相同文本，得到不同 note_id；
- 同一 call id 不同文本报冲突；
- 两个 session 互不可见；
- list 不会读取其他 profile 的 notes。

### 7.2 安全验收

- `../`、绝对路径、控制字符、超大文本被拒绝；
- 不在日志/错误中暴露凭据或完整宿主路径；
- 未授权平台/子 Agent 看不到工具；
- 审计命令不抢 lease、不写 transcript。

### 7.3 恢复验收

- call 未持久化 → handler 零调用；
- 笔记已写、result 未持久化 → 重放返回既有 receipt，再把 result 提交；
- 文件末行损坏 → 报告并拒绝静默重写；
- admission `unknown` → 只读审计给出证据，不发明成功；
- session 旋转 → 用 canonical session 找到正确 notes 与账本。

### 7.4 工程验收

- 单元、集成、恢复、协议测试齐全；
- `ruff` 干净；
- 临时 `HERMES_HOME` 中跑通；
- 能给出一次端到端 trace；
- 文档说明失败语义和幂等键。

## 8. 实验

### 实验 A：重放幂等

同一 `call_id` 连续执行 10 次。

### 实验 B：append 后崩溃

在笔记写入成功后、tool result 持久化前终止进程，再从 canonical call 恢复。

### 实验 C：审计不一致

手工制造 `call_without_result`，确认 `session audit` 明确报告，而不是自动修好。

### 实验 D：provider fallback

在调用 `project_note` 后让下一次 provider 请求 fallback，确认历史中 call/result 与 notes receipt 仍一致。

### 实验参考答案

1. **实验 A**：notes 文件只有一条记录；10 次返回相同 note_id/hash。若 text 变了，应报冲突。
2. **实验 B**：重放通过 call id 命中已有笔记并返回同一 receipt，然后提交 tool result；不能追加第二条。
3. **实验 C**：audit 输出 `call_without_result`，并列出 call id、session、时间与相关 notes 状态。修复动作必须另走明确恢复流程。
4. **实验 D**：fallback 只改变后续 provider/请求上下文，不改变已持久化的工具历史和 notes 回执；audit 仍能对齐。

## 9. 通关自测

1. 为什么幂等键必须用 call id，而不能只用文本 hash？
2. 笔记文件与 SessionDB 谁是事实源？
3. call 已持久化、note 已写、result 未持久化时，恢复应做什么？
4. `session audit` 为什么必须只读？
5. 为什么不能让 list 接受任意 session id？
6. 压缩旋转后，audit 怎样找到同一会话链？
7. 这个题目为什么不能只给工具 handler 加测试？
8. 如果 note 文件末行损坏，为什么不能自动截断后继续？

### 参考答案

1. 文本相同不代表同一意图；用户可能故意写两次相同内容。call id 才是“这次模型调用”的稳定身份，能安全去重和碰撞检测。
2. 两者各拥有一类事实：SessionDB 拥有调用/结果/会话状态，notes 文件拥有外部副作用回执；audit 对齐两者。单一一方都不能证明全链路。
3. 用同一 call id 读取已有 receipt，避免重复追加；把已有 receipt 作为 tool result 提交。若无法确认文件的完整性，则报告并 fail closed。
4. 因为审计要能安全用于故障现场；自动“修好”会掩盖未知、重复副作用或双写，必须以独立恢复流程做变更。
5. 这会破坏 session 隔离，可能泄露其他会话内容；只能使用本轮绑定且已解析的 canonical session。
6. 通过 parent/child 关系与 resume 解析找到 canonical child，同时保留父会话来源；notes 记录中保存实际绑定 session/workspace key。
7. 因为真正风险在 handler 之外：工具是否可见、call 是否先落库、执行器是否配对、result 是否 canonical、lease 丢失与压缩旋转是否安全。
8. 末行损坏可能只是半个已写记录，也可能意味着更早的内容不一致；自动截断会永久掩盖证据。应隔离/报告，再走明确修复。

## 10. 源码坐标

- `toolsets.py`
- `model_tools.py::get_tool_definitions`
- `agent/turn_tool_round.py::run_tool_round`
- `agent/tool_executor.py::_commit_tool_result`
- `agent/turn_context.py::_bind_turn_identity`
- `hermes_state.py::SessionDB`
- `gateway/session_authority.py::SessionAuthority`
- `gateway/run_turn_runner.py::TurnRunner`
- `tui_gateway/prompt_turn.py`
- `tests/tools/`
- `tests/gateway/`

## 11. 毕业答辩

不看文档，完成下面五分钟讲解：

1. 一条 append 请求从入口到笔记文件经过哪些层？
2. 哪一刻产生外部副作用？此前必须已有什么持久事实？
3. 在五个崩溃点分别怎样恢复？
4. 哪些状态可由 audit 自动判定，哪些必须人工核对？
5. 如果要求支持 cron/子 Agent，你会怎样限制可见性和所有权？
6. 如果要求更换 provider，哪些地方绝不能被 fallback 影响？

能回答这六题，并拿出测试与 trace，才算完成本卷。
