---
title: "OpenClaw 2026.10.9 源码课 · 03 工程实战"
description: "用调试路径、源码实验、失败矩阵和扩展练习完成工程实战。"
---

> 基线：`openclaw-2026.10.9`。路径相对 `$OPENCLAW_SRC`。
> 这一篇把前两篇的机制落到“怎么跑、怎么查、怎么改、怎么证明没改坏”。

## 一句话理解

OpenClaw 的工程难点不是“代码多”，而是**长生命周期 + 多入口 + 可恢复执行**同时存在。所以它的工程体系重点不是覆盖率数字，而是：

- 状态合同是否唯一；
- 并发/接管是否可证明；
- 协议帧是否覆盖；
- 数据库 schema 是否可迁移；
- 跨平台路径/进程是否可靠；
- 改动是否守住了架构边界。

## 1. 基线确认

先确认你读的是正确版本：

```powershell
cd $OPENCLAW_SRC
node -e "const p=require('./package.json');console.log(p.version,p.packageManager,p.engines.node)"
```

应看到：

```text
2026.10.9 pnpm@12.15.0+sha512... >=24.22.1 <25 || >=26.12.1
```

其他基线事实：

- bin：`openclaw` → `openclaw.mjs`；
- Gateway 默认端口：`18789`；
- Gateway state schema：`20`（`src/state/openclaw-state-db-contract.ts:23`）；
- Agent DB schema：`25`（`src/state/openclaw-agent-db-contract.ts:9`）。

注意：这是发布归档，不含 `.git`。不要伪造 commit/tag；引用版本时用 `2026.10.9`。

## 2. 建立本地运行环境

### 2.1 安装依赖

```powershell
cd $OPENCLAW_SRC
pnpm install
```

如果只想读源码，也建议至少安装到能跑类型检查/单测的程度，否则很多路径别名和生成文件看不全。

### 2.2 构建

```powershell
pnpm build
```

构建入口：`scripts/build-all.mts`。

### 2.3 启动 Gateway

具体 CLI 子命令以 `openclaw --help` 为准；源码层面的启动入口是：

- `src/gateway/server.ts:24 startGatewayServer()`
- `src/gateway/server-start.ts startGatewayServerCore()`

启动时会：

1. 初始化 SQLite runtime；
2. 校验/准备 state/agent DB schema；
3. 获取 gateway lock；
4. 打开 HTTP/WS 监听。

### 2.4 三种观察面

| 面 | 看什么 |
| --- | --- |
| Gateway 日志 | 请求受理、鉴权、dispatch、错误 |
| 事件流 | `agent_start`、`turn_start`、工具事件、`agent_end` |
| 持久状态 | session 行、transcript、terminal outcome、schema 版本 |

不要只盯日志。OpenClaw 的很多问题只能在“事件 + 持久状态”一起看时才能定位。

## 3. 调试一条消息：从 ID 开始

### 3.1 先锁定 `runId`

`chat.send` 的 `clientRunId` 通常直接成为 `runId`。

先确认：

- 客户端是否复用了同一个 `clientRunId`；
- 服务端是否返回 `in_flight`；
- 是否命中了 `chat:${clientRunId}` 的 dedupe。

相关源码：

- `src/gateway/server-methods/chat-send-admission.ts:75`
- `:442` 写 dedupe
- `:458` / `:489` 返回 `in_flight`

### 3.2 再锁定 session

看：

- `sessionKey`：路由身份；
- `sessionId`：持久记录身份；
- `activeWriterRunId`：当前写者。

如果出现“两个 run 都认为自己该写”，先查 writer claim：

```powershell
rg -n "claimAgentSessionWriter|activeWriterRunId|superseded" src/agents
```

### 3.3 再看模型与 harness

日志/事件里找：

- 选中的 provider/model；
- auth profile；
- fallback step；
- harness id（`openclaw` / `codex` / CLI backend）。

源码：

- `src/agents/embedded-agent-runner/model.ts:84`
- `src/agents/model-fallback-candidates.ts:155`
- `src/agents/embedded-agent-runner/run/failover-policy.ts:115`
- `src/agents/harness/selection.ts:77`

### 3.4 再看循环

如果模型已经返回，但任务没结束：

- 是否有 tool call 没执行？
- 是否在等审批？
- 是否有 pending/follow-up？
- 是否 `prepareNextTurn().stop` 没触发？

源码：

- `packages/agent-core/src/agent-loop.ts:215-457`
- `src/agents/agent-tools.before-tool-call.policy.ts`

### 3.5 最后看结算

如果 agent 结束但用户没看到回复：

- terminal outcome 是否记录？
- reply dispatcher 是否 settle？
- 渠道发送是否失败？

源码：

- `src/auto-reply/reply/agent-runner-execution-outcome.ts:96`
- `src/auto-reply/dispatch.ts:273`

## 4. 源码实验

这些实验都能在本地做，建议每个都记录“预期 / 实际 / 结论”。

### 4.1 并发同一 session

目标：观察 writer fence。

做法：

1. 用同一个 sessionKey 发两次 `chat.send`，使用不同 `clientRunId`；
2. 观察第二次是否接管；
3. 查 `activeWriterRunId` 与 `superseded`。

预期：

- 同一 session lane 串行；
- 新 writer claim 成功；
- 旧 run 以 `superseded` 终止；
- transcript 不出现交错。

### 4.2 重复同一个 clientRunId

做法：同一 `clientRunId` 连续发两次。

预期：

- 第二次不产生新 run；
- 返回 `in_flight` 或已有结果；
- 只有一份 transcript。

### 4.3 触发 steering

做法：

1. 让 agent 执行一个耗时工具；
2. 工具未结束时发送 steering；
3. 观察它在哪个检查点生效。

预期：

- 已启动工具继续完成；
- 未启动工具被 skipped/synthetic error；
- 下一轮 prompt 含 steering；
- tool call/result 仍成对。

### 4.4 构造 provider 失败

做法：配置一个不可用的 fallback 链，或让主模型返回错误。

观察：

- `rotate_profile` 还是 `fallback_model`；
- 失败候选是否留下半截 transcript；
- 最终 session 是否只推进一次。

源码：

- `src/agents/embedded-agent-runner/run-entry.ts:161`
- `src/agents/embedded-agent-runner/run/failover-policy.ts:115`

### 4.5 工具审批四种模式

做法：给一个需要审批的 plugin tool 分别配置：

- `request`
- `defer`
- `report`
- `deny`

观察：

- 是否阻塞；
- 谁收到审批请求；
- 非交互 surface 是否直接 deny；
- 拒绝后模型看到什么文本。

源码：

- `src/agents/agent-tools.before-tool-call.approval.ts:470`

### 4.6 compaction vs pruning

做法：

1. 制造长 transcript；
2. 触发 compaction，记录摘要与保留尾部；
3. 再等 tool result 超过 TTL，观察 pruning。

预期：

- compaction 改写 transcript；
- pruning 只改下一次 prompt 投影；
- 重启后 pruning 投影可以从原文重建。

源码：

- `packages/agent-core/src/harness/compaction/compaction.ts`
- `src/agents/embedded-agent-runner/tool-result-truncation.ts:172`

### 4.7 MCP server 不可达

做法：

1. 配置一个 stdio MCP server；
2. 先成功列出工具；
3. 停掉 server；
4. 再发一轮。

预期：

- 工具目录仍可能保留；
- 执行报 unavailable；
- 恢复按 30s → 10min 退避；
- 成功连接或显式 reload 清除退避。

参考：`docs/tools/mcp.md`。

### 4.8 子 agent 生命周期

做法：

1. 让主 agent spawn 一个 subagent；
2. 观察 child session key；
3. 结束父 run；
4. 检查 child session 是否仍存在。

预期：

- child 是独立 session/run；
- 默认无 session/message 管理工具；
- 有 depth policy；
- 支持 announce 与恢复。

源码：`src/agents/subagents/`。

## 5. 工程关卡

### 5.1 主检查

```powershell
pnpm check
```

入口：`scripts/check.mts`。

它聚合了大量 preflight 和检查，包括（以脚本实际内容为准）：

- conflict markers；
- script erasability；
- line-cap / max-lines ratchet；
- SQLite worker ratchet；
- assertion safety；
- test timeout race；
- mock export ratchet；
- changelog attribution；
- database-first legacy guard；
- doctor deprecation registry；
- wildcard re-export guards；
- media download helper；
- runtime sidecar loader；
- tool display；
- native catalog；
- opengrep metadata；
- duplicate scan coverage；
- npm lock/package patch。

### 5.2 架构检查

```powershell
pnpm check:architecture
```

包含：

- import cycles；
- madge cycles；
- deprecated API usage；
- wrapper shadowing；
- deprecated JSDoc；
- Kysely 检查；
- database-first legacy stores。

这类检查防的不是“语法错误”，而是**架构退化**：比如绕过数据库所有权、重新引入旧 store、形成循环依赖。

### 5.3 协议覆盖

```powershell
pnpm check:protocol-coverage
```

入口：`scripts/check-protocol-event-coverage.mjs`。

它确保新增/修改的 Gateway 事件在协议层有覆盖，不会出现“服务端发了、客户端 schema 不知道”的情况。

### 5.4 文档/配置 schema

```powershell
pnpm check:docs
pnpm check:base-config-schema
```

文档检查包括 MDX、链接、i18n glossary、配置示例等。

### 5.5 类型与测试

```powershell
pnpm check:test-types
pnpm test:unit:fast
pnpm test:changed
```

`test:changed` 以 `origin/main` 为基线，适合本地迭代；CI 会跑更完整的项目矩阵。

### 5.6 Windows

```powershell
pnpm test:windows:ci
```

OpenClaw 对 Windows 路径、进程、schtasks、文件锁有专门测试。不要假设“Linux 过了就行”。

### 5.7 构建

```powershell
pnpm build
pnpm build:strict-smoke
```

构建不只是打包；它还验证 CLI 启动、plugin SDK、runtime postbuild 等。

## 6. 失败矩阵

| 症状 | 首先检查 | 常见根因 |
| --- | --- | --- |
| 请求重复执行 | `clientRunId` / dedupe | 客户端每次生成新 id |
| 旧 run 还在写 | `activeWriterRunId` | writer fence 未生效/被绕过 |
| 新 run 一直排队 | session lane | 前一个 run 未释放 lane |
| 模型不切换 | 候选链/认证 | fallback 未配置或 profile 全部失效 |
| 工具调用悬空 | `completeUnstartedToolCall` | steering/abort 路径未生成 result |
| 审批永远不返回 | surface 能力 | 非交互渠道无法请求审批 |
| 上下文突然缩短 | compaction | 摘要 cut point 过早 |
| 工具结果“消失” | pruning | 只改了投影，不是磁盘丢失 |
| Gateway 启动失败 | lock/schema | 另一个实例持有 lock 或迁移失败 |
| 事件乱序/缺失 | `seq` | 客户端未处理 gap |
| UI 重连后状态错 | `stateVersion` | 快照与增量未对齐 |
| Windows 特有失败 | 路径/进程测试 | 大小写、锁、schtasks、spawn 差异 |

## 7. 修改练习

### 练习 A：新增一个只读工具

目标：理解工具装配与上下文成本。

要求：

1. 在 core tools 之外新增一个只读工具；
2. 让它经过 tool profile；
3. 给它写 schema；
4. 确认它出现在 system prompt 和请求 schema 中；
5. 说明它增加了多少上下文成本。

### 练习 B：新增一个 channel capability

目标：理解入口归一。

要求：

1. 用 `api.registerChannel()` 注册一个最小 channel；
2. 把入站消息翻译成统一上下文；
3. 复用 `dispatchInboundMessage()`；
4. 不修改 Gateway 的核心路由分支。

### 练习 C：给 writer 接管加诊断

目标：理解所有权。

要求：

1. 在 writer claim 成功/失败处增加结构化日志；
2. 记录旧 `activeWriterRunId`、新 runId、sessionKey；
3. 不改变行为，只增加可观测性；
4. 写一个测试覆盖“旧 writer 被 supersede”。

### 练习 D：验证 pruning 不改 transcript

目标：理解投影与历史。

要求：

1. 构造一个过期 tool result；
2. 触发 cache-TTL pruning；
3. 对比 prompt 投影与磁盘 transcript；
4. 重启后验证投影可重建。

### 练习 E：MCP 失败恢复

目标：理解外部能力生命周期。

要求：

1. 让 MCP server 启动失败；
2. 观察退避；
3. 恢复 server；
4. 确认工具目录与执行能力恢复；
5. 说明“目录保留”为什么不等于“执行放行”。

### 修改练习参考答案与验收点

**练习 A（只读工具）**

参考做法：把它放在 plugin/tool profile 边缘，而不是 core tools；声明严格输入 schema 和只读权限；在装配后确认它受 profile/authorization 控制；估算它进入 system prompt 文本与请求 JSON schema 的额外 token/字符成本；用测试覆盖成功、拒绝、参数非法、输出过大和未启用 profile。验收点是核心 prompt 不因可选能力永久膨胀，工具仍走统一 policy/approval。

**练习 B（channel capability）**

参考做法：用 `api.registerChannel()` 注册平台，适配器只负责把入站消息翻译成统一 `MsgContext`（身份、sessionKey、回复目标、附件），然后复用 `dispatchInboundMessage()`。不要改 Gateway 核心路由、Agent Loop、Session 所有权或工具策略。验收点是同一 session 语义、幂等、审批和回复投递都与其他渠道一致。

**练习 C（writer 接管诊断）**

参考做法：在 claim 成功/失败处记录结构化字段：`sessionKey`、旧 `activeWriterRunId`、新 `runId`、CAS 结果、generation/sessionId、失败原因；只加日志不改行为。测试要覆盖旧 writer 被 supersede 后收到 `superseded`，且不能再写 transcript。验收点是从日志能还原“谁在何时获得所有权”。

**练习 D（pruning 不改 transcript）**

参考做法：构造一个超过 TTL 的 tool result，触发 cache-TTL pruning；保存本次请求的 prompt 投影，同时读取磁盘 transcript 原文；重启 runtime 再构造请求，确认投影仍能从原文重建。验收点是 transcript 字节不变，只有投影出现 placeholder，工具结果并未从存储中删除。

**练习 E（MCP 失败恢复）**

参考做法：让 server 启动失败，观察目录元数据是否保留、执行是否 unavailable、退避是否从约 30 秒增长到 10 分钟；恢复 server 后验证目录与执行同时恢复。验收点是“目录保留”只表示可发现性，不表示执行放行；每次调用仍要过 policy/approval 和活连接检查。

## 8. 毕业自测

不看文档回答：

1. `pnpm check` 和 `pnpm check:architecture` 分别在防什么？
2. 为什么协议事件需要单独的 coverage 检查？
3. 为什么 Windows 测试不能由 Linux CI 代替？
4. 一个改动同时涉及 Gateway 方法、session schema、UI，应该按什么顺序验证？
5. writer fence 的失败模式有哪些？各自怎样观测？
6. compaction 与 pruning 的测试应该分别断言什么？
7. 插件改动为什么不能只跑单元测试？
8. 如果让你新增一个模型 provider，需要经过哪些层？
9. 如果让你新增一个渠道，哪些代码不应该改？
10. 你怎样证明“这次修改没有破坏 prompt 前缀稳定性”？

---

### 毕业自测参考答案

1. `pnpm check` 是广义 preflight/质量闸门，防冲突标记、行数上限、断言/测试竞态、遗留 mock、锁文件等回归；`pnpm check:architecture` 防架构退化，如 import 循环、旧 API、旧 store、数据库所有权被绕过。
2. 因为服务端能发事件不等于客户端协议知道如何解析。协议覆盖检查保证新增/修改事件同时有 schema、客户端处理和测试，避免“线上发了、UI 静默丢弃”。
3. Windows 有独立的大小写路径语义、文件锁、进程/spawn、schtasks 和 shell 差异；Linux CI 无法证明这些平台行为，不能替代 Windows 专用测试。
4. 推荐顺序：先改合同/schema 与数据库迁移（database-first），再改 Gateway method 和协议覆盖，然后改 session/run 状态与 writer 行为，最后接 UI/客户端，跑协议、集成、Windows 与构建检查。每一步都先证明旧数据/旧客户端兼容。
5. writer fence 失败模式：CAS 冲突、旧 writer 未被 supersede、sessionId 已变化、generation 过期、恢复后重复 claim、崩溃留下 stale owner。观测 `activeWriterRunId`、CAS 结果、`superseded` 事件、lane 排队和 generation/session 版本。
6. compaction 测试断言 transcript 结构改变、摘要/cut point、近期消息保留、失败时保留尾部；pruning 测试断言 prompt 投影被替换、transcript 不变、TTL/压力阈值正确、重启可重建。
7. 插件会改变注册、认证、provider/channel/tool/hook 和进程内信任边界；单元测试不覆盖插件加载、schema、协议桥接、安全审批和真实启动，因此必须加集成与协议测试。
8. 新增 provider 要经过：provider capability/catalog 元数据 → 认证与凭据 → API adapter/协议 → 模型解析与 alias → 候选链/failover → 请求/响应 schema → 集成测试。不能只在核心循环里加 if/else。
9. 新增渠道不应改 Gateway 核心路由、Agent Loop、Session/Writer 所有权、工具 policy/approval。只应新增 channel capability、入站翻译、sessionKey 映射和 ReplyDispatcher 适配。
10. 证明前缀稳定：记录修改前后的 stable prefix 字节和 `stablePrefixCacheKey`，做 diff/哈希断言；把动态字段放到 cache boundary 之后；再跑 provider 请求构造测试和缓存命中观测。只要稳定段哈希不变，才算没有破坏 prefix reuse。


*OpenClaw 2026.10.9 · 工程实战*
