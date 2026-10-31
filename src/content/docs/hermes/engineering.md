---
title: "Hermes Agent 0.22.5 工程实战"
description: "用调试路径、源码实验、失败矩阵和扩展配方完成工程实战。"
---

> 基线：`hermes-agent-0.22.5` 发布归档。发布归档不含 `.git`，所以本文不写虚构 tag/commit；版本以归档名和 `hermes_cli/__init__.py` 的 `__release_date__ = "2026.9.24"` 为准。
> 源码根目录：`$HERMES_SRC`。
> 目标不是“会启动”，而是能用证据定位一次 turn 为什么卡住、为什么重复、为什么会串 profile，以及怎样改动才不破坏持久化和 prompt cache。

## 0. 先记住四条排障原则

1. **先分清进程**：经典 CLI、Gateway、TUI Python 后端、Desktop、cron worker 不是同一个进程。
2. **先读事实，不先猜代码**：admission、lease、transcript、receipt、event、日志，各有自己的 owner。
3. **先判断是否已提交**：同一个错误，可能是“没发生”，也可能是“发生了但没记账”；后者绝不能直接重跑。
4. **先看边界，再看函数**：输入入口、ownership、provider、tool、compression、UI，问题通常跨两个边界。

```text
客户端
  → admission（是否接单、排队、去重）
  → lease（谁有权执行）
  → context（模型看到什么）
  → provider（怎么调用）
  → tool（做了什么）
  → SessionDB（哪些事实已持久化）
  → finalization（如何结束、交付、释放）
  → event/UI（用户看到什么）
```

---

## 1. 环境与基线

### 1.1 版本和路径

先确认你读的是当前归档，而不是旧目录：

```powershell
cd $HERMES_SRC
rg -n "__release_date__|__version__" hermes_cli/__init__.py
rg -n "requires-python|version =" pyproject.toml
```

要点：

- `pyproject.toml` 的 `version = "0.0.0"` 是构建占位，不是产品版本；
- `hermes_cli/__init__.py` 的 `__release_date__` 是发布线索；
- 发布归档没有 `.git`，不要虚构 commit/tag；
- 旧 `hermes-0.22.2` 讲义只能做历史对照（本站只保留 v0.22.5）。

### 1.2 Windows 安装链

`setup-hermes.ps1` 的顺序值得记住：

```text
pm/lock.json 中固定的 uv
  → 校验 sha256
  → uv 安装 bootstrap Python
  → python -m pm.cli install
  → hash-verified 安装依赖
  → activate.ps1
  → .env 模板
  → tools/skills_sync.py 同步 bundled skills
```

几个工程含义：

- **uv 本身也有 pin**，不是“有 uv 就行”；
- **依赖由 `uv.lock` 校验**，不要绕过 PM 手工 pip 安装后再假装环境一致；
- `HERMES_HOME` 可以改变 skills/state 的位置；测试必须用临时目录；
- 不要硬编码 `~/.hermes`，代码里应走 `get_hermes_home()` / `display_hermes_home()`。

### 1.3 Python 与依赖

- `requires-python = ">=3.11,<3.15"`；
- 实际主目标是 3.14，3.11 主要服务旧 updater 桥；
- 直接依赖几乎全部 exact pin；
- 依赖有 release-age 检查，避免刚发布的供应链版本立即进入；
- `ruff.toml` 的 target-version 是 `py311`，line length 88。

不要因为本机能 import 就认为兼容性成立；要看 `pyproject.toml`、lock 和 CI/Coding 规则。

---

## 2. 读源码的最短路线

### 2.1 第一次：只追一条 turn

```text
hermes_cli/main.py:1682 cmd_chat
  → cli.py:880 HermesCLI
  → hermes_cli/cli_chat_turn_mixin.py:49 chat()
  → hermes_cli/cli_agent_setup_mixin.py:645 _init_agent()
  → GatewayAgent.run_conversation()
  → gateway_agent.py:769 connection.call("prompt.submit")
  → gateway/session_authority.py:636 submit()
  → gateway/run_turn_runner.py:998 agent.run_conversation()
  → agent/turn_facade.py:22
  → agent/conversation_loop.py:1785
```

### 2.2 第二次：只追四类事实

```text
谁接单：session_admissions
谁有房卡：session_turn_leases
谁在干活：worker_executions / worker_receipts
已经发生什么：messages / system_prompts / event stream
```

### 2.3 第三次：只看失败路径

- lease 丢失；
- tool result 持久化失败；
- compression timeout / lock / cooldown；
- provider error → retry/rotate/fallback；
- fallback 后 preflight 重建；
- cancel / abort / history broken；
- SessionDB 锁、WAL、schema mismatch。

如果一条失败路径不能落回某张表或某个 event，说明你还没找到它的 owner。

---

## 3. 工程检查：不要把“能跑”当成“没坏”

### 3.1 常用检查

```powershell
cd $HERMES_SRC
ruff check ./
```

另有：

- `justfile`：`ruff check` 加各 JS/TS workspace 的 ESLint；
- `lefthook.yml`：pre-commit lint；
- `scripts/check`：blocking lint 总入口；
- `scripts/run_tests.sh`：测试入口，不应绕过它直接裸跑 pytest。

测试时先设置隔离的 `HERMES_HOME` / `HERMES_RUNTIME_DIR`，不要写真实 `~/.hermes/`。

### 3.2 测试分层

| 层 | 证明什么 | 典型做法 |
| --- | --- | --- |
| 单元 | 纯函数/分类器/序列化 | 直接测 project/checkpoint/schema 逻辑 |
| 行为契约 | 在给定事件序列下行为不变 | fake provider/tool/DB，断言状态和事件 |
| 集成 | 模块真实 import、真实 SQLite/文件 | 临时 `HERMES_HOME`，真实 `state.db` |
| 多进程 | lease/admission/recovery | 两个 worker/进程抢同一 session |
| E2E | CLI/TUI/Gateway/平台真实链路 | 最小真实进程，不依赖手工环境 |

不要写“函数被调用过”的 change-detector；要断言用户可观察的行为和 durable 事实。

---

## 4. 调试一条 Turn：按顺序定位

### 4.1 它到底在哪个进程？

| 入口 | 先看 |
| --- | --- |
| 经典 CLI | `GatewayAgent` 是否连上 Gateway；`prompt.submit` 是否成功 |
| TUI | Node/Ink 是否连上 `tui_gateway`；RPC method 是否返回 |
| Desktop | WebSocket 是否连上；是否绑定正确的 profile |
| 消息平台 | adapter 是否把消息转成 admission；目标 session 是否正确 |
| Cron | 是否是 gateway ticker，claim/heartbeat 是否成功 |

如果 CLI 进程里没有真实 Agent，不要在那里找工具执行日志。

### 4.2 它被接单了吗？

看 `session_admissions`：

- `queued`：已排队，尚未开始；
- `started`：已有 owner 开始；
- `unknown`：边界不确定，先 reconcile；
- `terminal`：已有终态。

同时看 `UNIQUE(principal_id, target_session_id, request_id)`：同一 request 重复提交不应产生第二条工作。

### 4.3 它为什么一直等？

按顺序：

1. admission 是否 `queued`；
2. 是否有其他 turn 持有 lease；
3. lease 是否过期但 heartbeat 仍显示 backend 活着；
4. 是否卡在 session lane；
5. 是否是 provider streaming 不返回；
6. 是否是 tool timeout / approval / sudo / clarify；
7. 是否是 compression lock 或 cooldown；
8. liveness watchdog 是否已经中断但 UI 没收到事件。

不要一上来就杀进程；先确认“已发生但未通知”和“根本还没开始”的区别。

### 4.4 工具执行了，为什么模型没看到结果？

按 `run_tool_round` 的顺序看：

```text
tool-call turn 是否持久化成功？
  → 工具是否真的执行？
  → result 是否 canonical persist？
  → 是否触发 guardrail halt？
  → 是否进入 post-tool compression？
  → 是否被中断并补了 skipped result？
```

如果 `session_persistence_failed`，结果不能送回模型；如果只是 UI 没显示，要区分 transcript 和 event stream。

### 4.5 为什么上下文一直涨？

检查：

- `compression_enabled` 是否为真；
- `should_compress()` 的阈值和当前 pressure；
- 是否处于 compression failure cooldown；
- `compression_locks` 是否被别的进程持有；
- summary provider 是否失败；
- 是否是 `tail_mode` 保护了太多尾部；
- 是否是 context file 本身过大，而不是历史消息。

### 4.6 fallback 为什么没有生效？

- 错误是否被分类为可 retry/rotate/fallback；
- 凭据池是否还有非 DEAD entry；
- 429 的 cooldown 是否仍在；
- fallback 是否设置 `restart_with_rebuilt_messages`；
- 新 provider 是否支持当前工具/schema/api_mode；
- 是否在 preflight 再次压缩时超时。

### 4.7 为什么多 profile 串了？

重点看“不在 turn 内”的代码：

- boot probe；
- ticker；
- deferred callback；
- RPC method；
- thread hop；
- child spawn；
- 模块全局或 `os.environ` 的 import-time 值。

一个进程服务多 profile 时，这些位置必须显式绑定 owning profile scope；否则会静默落到 launch profile。

---

## 5. 失败矩阵

| 症状 | 第一现场 | 常见根因 | 正确处理 |
| --- | --- | --- | --- |
| turn 永远 queued | admission/lane | 没有 ticker/worker，前一个 turn 未释放 | 查 owner、lease、event |
| turn 一直 running 无输出 | provider stream/tool | provider 卡住、工具超时、审批未返回 | 查 API request id、tool status、watchdog |
| 工具报错后无 result | `run_tool_round` | result persist 失败、中断未补 skipped | 不能把内存结果发给模型 |
| 页面有最终答案但 transcript 没有 | finalize/close tail | `_close_transcript_tail` 未执行/事件与 DB 不一致 | 查 finalize、assistant row |
| 压缩反复失败 | compressor | lock、cooldown、summary provider、窗口不足 | 先释放/等待，再修 provider |
| fallback 后 400/overflow | preflight/API | 未重建 messages、窗口不同、api_mode 不同 | 重跑 preflight，不要沿用旧 wire |
| 重启后重复工具 | lease/admission | unknown 被当 queued、缺幂等/readback | 先 reconcile，禁止盲重放 |
| 多 profile 串 session | profile scope | ticker/RPC/thread 未绑定 | 显式绑定 home/profile |
| state.db locked | SQLite/WAL | 长事务、错误锁、另一个 backend | 查 heartbeat、busy timeout、备份后 repair |
| schema mismatch | migration | 旧二进制/新 DB 或反向 | 停写、备份、使用官方迁移路径 |
| prompt cache 命中下降 | system prompt | 非压缩路径重建、动态字段进入 stable | 比较 stable hash/字节 |
| 回复重复发送 | event/replay | 客户端未处理 seq/快照，或重试绕过幂等 | 查 event id/seq、request id |

---

## 6. 安全修改配方

### 6.1 新增一个工具

先决定它属于哪里：

```text
核心 built-in？
  → tools/
  → toolsets.py
  → model_tools.py
  → prompt/工具说明
  → tests

可选能力/外部集成？
  → plugin 或 MCP
  → 不要永久增加核心 tool schema
```

无论哪种，都要回答：

1. schema 是否严格，是否有未知字段/路径穿越风险？
2. 是否需要 file mutation checkpoint？
3. 结果可能多大，是否有 synopsis/预算？
4. 错误如何分类，模型能否据此恢复？
5. 是否受 platform/toolset/authorization/approval 限制？
6. 是否会被子 Agent 误用？
7. 失败时 transcript 能否保持 call/result 配对？
8. 有没有行为契约测试？

**最小路径**：在 `tools/` 实现只读操作；在 `toolsets.py` 加入对应 toolset；确认 `model_tools.get_tool_definitions()` 能看到；加成功、越界、超大、错误、未授权测试。不要把测试只写在 handler 里，还要证明装配和授权链生效。

### 6.2 新增一个 toolset

- 在 `toolsets.py` 定义 tools/includes/平台限制；
- 检查递归 `includes` 是否有环或 diamond；
- 检查 `"all"` / `"*"` 是否会把不该暴露的工具带进去；
- 检查 session-platform gated 逻辑；
- 检查 registry generation 缓存是否需要失效；
- 加“包含/排除/递归/平台”四类测试。

### 6.3 新增一个 provider

顺序：

```text
ProviderProfile
  → auth_type / env_vars / base_url / api_mode
  → request/stream adapter
  → model catalog / aliases
  → provider discovery
  → credential pool
  → candidate/fallback
  → tests
```

检查：

- `prepare_messages` 是否保持历史前缀稳定；
- `build_extra_body` 是否只加 provider 需要字段；
- tool message / prompt cache key / token quirks 是否声明；
- OAuth 失败是否会进入 DEAD，而不是无限重试；
- `api_mode` 是否有对应 adapter；
- fallback 后是否强制 preflight 重建；
- 是否把密钥/私有推理写进 public projection。

优先做成 `$HERMES_HOME/plugins/model-providers/<name>/` 的用户插件，而不是改核心；只有确实需要内置能力时才进 bundled。

### 6.4 新增 plugin

- 目录形式加载，`register(ctx)` 或 ABC subclass；
- 相对 import 必须可用；
- 注册是进程内行为，插件拥有执行任意 Python 的信任；
- 检查加载死锁、超时和加载顺序；
- 明确插件失败是 fail open、fail closed 还是禁用该能力；
- 加真实 import、注册、工具/渠道/provider 的集成测试。

### 6.5 新增 skill

- 放进 `skills/`（内置）或 `optional-skills/`（按需）；
- 写清触发条件、步骤、验证和失败处理；
- 不要把权限逻辑写进 skill 文本；
- 确认 skills index 进入 volatile tier，而不是 stable；
- 加“可发现、可读取、不会误触发”的测试。

### 6.6 新增平台 adapter

- 只负责收消息、身份映射、回复路由、媒体；
- 入站必须构造统一 admission，不另跑一套 Agent；
- 出站必须经过平台的幂等/分段/重试语义；
- 后台完成通知走 `admit_internal_event`，不绕 FIFO；
- 检查多 profile、群聊/线程、去重、审批能力和不可达降级；
- 不要在 adapter 里直接写 transcript。

### 6.7 新增 RPC method

- Python `tui_gateway/methods_<topic>.py` 定义 handler；
- 更新 wire contract，生成 TypeScript 类型；
- 处理 server→client request、超时、取消和错误；
- 明确 profile scope；
- 加协议覆盖、客户端兼容和权限测试。

### 6.8 修改 system prompt 或上下文装配

这是最高风险区。至少验证：

- stable/context/volatile 分层是否仍成立；
- 动态字段是否被放到了 stable；
- workspace snapshot 是否仍按 session 冻结；
- `content`/`api_content` 回放是否仍一致；
- 压缩前后是否只由压缩触发重建；
- 是否有 “same input → same stable bytes” 的契约测试。

### 6.9 修改 SessionDB / migration

禁止在 live writer 下直接改 schema 或手删表。安全顺序：

```text
停止/隔离 writer
  → 备份 state.db（连同 WAL/SHM 语义）
  → 检查 schema version / integrity / health
  → 使用官方 migration/repair 路径
  → 在临时 HERMES_HOME 上恢复一份样本
  → 跑旧 transcript 读取、admission/lease/receipt 测试
  → 再切回真实环境
```

WAL 的意义是并发 reader + 单 writer，不是“可以随便并发写”。不要在另一个进程写 WAL 时删除/替换数据库文件。

### 6.10 修 durable state

修复前先分类：

- **stale lease**：确认 owner 已死/心跳过期，再让官方 repair 过期；
- **compression lock**：确认持有者不在，再释放；
- **admission unknown**：readback，不要直接改成 queued/terminal；
- **worker receipt 缺失**：先查执行副作用，再决定重试；
- **conversation generation**：只能单调推进，不能回收复用；
- **messages orphan**：按 tool call UID 修复配对，不能凭空删 call。

---

## 7. 毕业练习（含参考答案）

### 练习 1：画一条跨进程 turn

要求标出：CLI/TUI 前端、Gateway admission、TurnRunner、AIAgent、lease、SessionDB、event stream。

**参考答案**：

```text
CLI/TUI 前端
  → prompt.submit / JSON-RPC
  → Gateway adapter
  → session_admissions（queued）
  → TurnRunner
  → session_turn_leases（holder + TTL）
  → AIAgent.run_conversation
  → build_turn_context / provider / tools
  → messages + tool pairs + events
  → finalize / transcript / reply
  → admission terminal + lease release
```

验收点：能指出哪一步在 CLI 进程、哪一步在 Gateway、哪一步在 Python TUI 后端；能说明“ACK/已接纳”不等于“模型已完成”。

### 练习 2：构造 lease 卡住

让一个 turn 持 lease，另一个 turn 用同一 session 提交。观察等待、超时、取消、owner 死亡后的恢复。

**参考答案**：第二个 turn 应等待 lease，而不是并发写 transcript；等待期间可被 interrupt；owner 存活但事件循环卡住时，watchdog/心跳应导致中断；owner 真死时，TTL 过期后新 owner 才能接管。验收点是旧 owner 失权后不再写终态，新 owner 不会重复已提交工具。

### 练习 3：压缩失败恢复

构造 compression lock 被占用、summary provider 失败、cooldown、压缩超时四种情况。

**参考答案**：

- lock 被占用：不应并发压缩，等待/退避；
- cooldown：不要每个 API call 都重试同一个 summary provider；
- 压缩未到达 provider：refund API call；
- 压缩超时：turn 可能需要以 context compression timeout 结束，保留 transcript，下一轮换干净 session；
- 失败后不得把“没压缩成功”伪装成正常上下文。

验收点：状态、event、日志能区分 lock/cooldown/timeout/provider error。

### 练习 4：SessionDB 锁与修复

制造 `database is locked`，然后按安全流程恢复。

**参考答案**：先确认是否有 live writer/backend heartbeat；不要直接删 `state.db`；读取 schema、integrity、WAL 状态；停写、备份、使用官方 repair/migration；在临时 `HERMES_HOME` 验证 transcript/admission/lease/receipt 可读；最后才恢复服务。验收点是修复后 call/result 仍配对，unknown admission 没被误判，compression lock/lease 没被粗暴清空。

### 练习 5：provider fallback

让主 provider 返回可恢复错误，配置一个 fallback。检查 fallback 是否回到 preflight。

**参考答案**：错误应先分类；可 rotate 时先换凭据，不可用时才 fallback；fallback 设置 `restart_with_rebuilt_messages`，重新构建 system prompt/wire messages，重新计算窗口和压缩；失败候选不得污染最终 transcript。验收点是最终 session 只推进一次，最终 provider 的上下文没有沿用旧窗口。

### 练习 6：新增只读工具

要求：读 workspace 内文件、严格 schema、大结果摘要、错误分类、不暴露给子 Agent、有测试。

**参考答案**：放在 plugin 或非核心 toolset；路径必须由 sandbox/provider 校验，拒绝 `..`、符号链接逃逸和宿主绝对路径；结果超过阈值返回 synopsis + 字节数 + 可回查引用；错误至少 `not_found/permission/too_large/transient`；授权层禁止子 Agent；测试覆盖正常、越界、超大、错误、未授权和 toolset 可见性。验收点是 prompt/schema 成本可控且没有绕过统一 policy。

### 练习 7：新增 provider plugin

要求：声明 `ProviderProfile`、认证、API mode、模型别名，能被发现并可 fallback。

**参考答案**：在用户 plugin 目录实现 profile/adapter；声明 streaming、tool message、prompt cache、token quirks；用环境变量或 OAuth 认证；在临时 `HERMES_HOME` 验证 discovery 顺序、用户覆盖 bundled、候选链和凭据池状态；加一个真实请求形状测试和一个不可用/fallback 测试。验收点是核心循环没有新增 provider 分支。

### 练习 8：多 profile 隔离

要求：一个进程同时服务两个 profile，证明 session、model、skills、cron、RPC 不串。

**参考答案**：所有非 turn 入口显式绑定 profile/home scope；测试两个 profile 的 session/admission/lease、model catalog、skills index、cron tick、RPC method；检查 `os.environ`/模块全局只保留 launch profile 时不会泄漏。验收点是两个 profile 的 state dir、generation 和 prompt 都不互相影响。

### 练习 9：证明 prompt 稳定

要求：修改一个动态 system prompt 字段，证明没有破坏 stable prefix。

**参考答案**：记录修改前后 stable/context/volatile 的字节和 hash；动态字段应只改变 volatile；stable hash 不变；做一次 provider 请求构造测试；如果有缓存命中指标，观察是否下降。若 stable 变化，改回 context/volatile 或只在压缩后重建。验收点是 `same stable inputs → same stable bytes`。

---

## 8. 三分钟白板讲解

如果只给你三分钟，按这八步讲 Hermes：

1. **入口**：CLI 代理到 Gateway；TUI/Desktop 走 Python JSON-RPC；消息平台走 adapter。
2. **准入**：输入先变成 `session_admissions`，有 queue/steer/redirect 和幂等 request id。
3. **所有权**：TurnRunner 取得 `session_turn_leases`，TTL + 刷新 + watchdog。
4. **上下文**：stable/context/volatile system prompt，`api_content` 回放，preflight 压缩。
5. **执行**：API → tool round → persist-before-execute → result 配对 → 下一轮。
6. **持久化**：messages/system_prompts/usage/receipts 各自记录不同事实。
7. **收尾**：finalize、transcript 闭合、事件投递、lease/scope 释放。
8. **恢复**：先 readback/receipt，再决定重试；已提交 effect 绝不重做。

最后用一句话收束：

> **Hermes 的可靠性，不来自模型多聪明，而来自“输入先持久、执行先拿租约、工具先记账、结束先收尾”这四道顺序。**

---

## 9. 一页代码地图

```text
hermes_cli/main.py                    cmd_chat
hermes_cli/cli_chat_turn_mixin.py     CLI chat
hermes_cli/gateway_agent.py           CLI 侧 GatewayAgent
gateway/session_authority.py          admission / authority
gateway/run_turn_runner.py            TurnRunner
agent/turn_facade.py                  Turn facade
agent/turn_facade_lease.py            lease / refresher / watchdog
agent/conversation_loop.py            turn loop
agent/turn_context.py                 context / wire messages
agent/system_prompt.py                three prompt tiers
agent/context_compressor.py           compression / rotation
agent/turn_preflight.py               preflight gate
agent/turn_tool_round.py              persist-before-execute
agent/tool_executor.py                concurrent/sequential execution
toolsets.py                           toolset resolution
model_tools.py                        tool definitions / dispatch
providers/base.py                     ProviderProfile
providers/__init__.py                 provider discovery
agent/credential_pool.py              credential states
hermes_state_common.py                schema 32
hermes_state.py                       SessionDB facade
plugins/plugin_loader.py              plugin loading
cron/scheduler.py                     durable cron
tui_gateway/                          TUI/Desktop backend
```

---

*基于 Hermes Agent 0.22.5 发布源码编写 · 2026-10-31*
