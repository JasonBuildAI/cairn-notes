---
title: "阶段 6：接口与契约"
description: "契约、SDK、CLI 与 MCP：一张图纸如何长出多个入口。"
---

> 本阶段回答：同一套能力，为什么有 SDK、CLI、MCP 和原始 HTTP 四种用法？五种语言的 SDK 是同一份代码吗？改一个字段，应该按什么顺序动？
> 预计 3–4 天。核心产出是一张**入口选择表**和一份**契约变更顺序清单**。

## 为什么需要这一步

前五个阶段，你一直在用 Python SDK。这会带来一个隐蔽的错觉：**SDK 就是系统本身**。

一旦换场景，错觉就会破：

- 运维要在 CI 里创建沙箱，不想装 Python 依赖 → 用 `osb`。
- 编码 Agent 要通过工具调用操作沙箱，不写代码 → 用 MCP。
- 另一个团队用 Go 写服务，发现方法名和 Python 不一样 → 怀疑文档过期。
- 你给服务端加了一个字段，Python 能读，Kotlin 报错 → 不知道先改哪一层。

这些问题的共同根源是：OpenSandbox 不是一个 SDK，而是**一份公开契约 + 多个消费者**。

```text
                 specs/（公开契约，唯一真相）
                    |
      +-------------+-------------+-------------+
      |             |             |             |
   Python SDK    JS/TS SDK     Kotlin SDK     C# / Go SDK
      |             |             |             |
      +-------------+------+------+-------------+
                         |
                    lifecycle server / execd / egress
                         ^
                         |
                  osb CLI        MCP server
```

读这张图要抓住两件事：

1. **箭头方向**：契约在上，实现在下；SDK 和 CLI 都是消费者，不是控制面。
2. **同一层可以有多份实现**：多种语言、多种入口，但行为必须对齐。

## 一个比喻：图纸、直梯、前台、对讲机

把 OpenSandbox 想成一栋大楼：

```text
specs/     = 建筑图纸（公开契约，定义门在哪里、门牌怎么编）
SDK        = 直梯（进楼最直接的方式，按楼层按钮）
CLI        = 前台（不写代码也能办事，适合脚本和人工操作）
MCP        = 对讲机（给 Agent 用的受限面板，只开放部分按钮）
原始 HTTP  = 走楼梯（什么都能到，但每一层都要自己走）
```

四种入口的取舍：

| 入口 | 适合 | 代价 |
| --- | --- | --- |
| SDK | 应用内集成、需要类型和错误语义 | 要装依赖，版本要与服务端匹配 |
| CLI | 脚本、CI、人工排障 | 进程级调用，不适合高频嵌入 |
| MCP | Agent 工具调用 | 只暴露子集，状态在本地注册表 |
| 原始 HTTP | 教学、调试、跨语言最小集成 | 所有细节自己处理 |

## 步骤 1 · 认清四份公开契约

`specs/` 下不是“参考文档”，而是**契约源**：

| 文件 | 约束谁 | 默认端口 | 你在什么时候读它 |
| --- | --- | --- | --- |
| `sandbox-lifecycle.yml` | lifecycle server | `8080` | 创建/查询/暂停/删除、端点解析、快照 |
| `execd-api.yaml` | 沙箱内 execd | `44772` | 命令、会话、文件、PTY、metrics |
| `egress-api.yaml` | egress sidecar | `18080`（客户端默认） | 出站策略、凭据绑定 |
| `diagnostic-api.yml` | 诊断接口 | 随部署 | `osb diagnostics` 的稳定日志与事件 |

三条使用原则：

1. **字段以 spec 为准，不以某个 SDK 的模型类为准。** SDK 可能滞后，也可能做了便利封装。
2. **状态码以 spec 为准。** 例如创建返回 `202`、删除返回 `204`、暂停/恢复返回 `202`；这些不是实现细节。
3. **未在 spec 中出现的行为，不要依赖。** 即使某个版本恰好支持，也不构成契约。

阶段 1 已经带你手写过创建、解析端点、删除；那三次实验的意义，就是让你在“直梯”之外走过一次“楼梯”，知道每一层台阶长什么样。

## 步骤 2 · 生成代码与手写代码的分层

每种语言的 SDK 内部大致都有三层：

```text
第 1 层：generated client
         OpenAPI -> 模型类 + 低层 HTTP 方法
         字段名、枚举、状态码与 spec 一一对应
         不提供业务便利，不隐藏细节

第 2 层：handwritten adapters
         把低层响应转换成对用户友好的模型
         处理默认值、错误映射、状态归一化
         例如把 HTTP 错误变成 SandboxException 家族

第 3 层：services / facade
         Sandbox.create、commands.run、files.read_file 这类入口
         负责编排、轮询、健康检查、资源清理
```

为什么要分三层？因为两类变化的速度不同：

```text
契约变化     -> 重新生成第 1 层
语义变化     -> 改第 2、3 层
两者混在一起 -> 每次生成都覆盖手写逻辑，或者手写逻辑挡住契约升级
```

### 一条硬规则

> **不要把“改生成代码”当成唯一修复。**

如果生成结果不对，先改 spec 或生成配置，再重新生成；如果只是使用方式不顺手，改手写适配层。直接改生成文件，下次生成就丢了。

Kotlin 的生成产物就在 `build/generated/**` 这类目录下；Python 的生成客户端在 `opensandbox/api/lifecycle`、`opensandbox/api/execd` 下。看到这些路径，默认它们是“只读”的。

### 一个具体例子：状态字符串

服务端可能返回一个新的状态值，而某个 SDK 的常量枚举还没更新。手写层应该做的是**容忍未知值**，而不是崩溃：

```python
# 概念示意：把未知状态保留为字符串，而不是强行映射
state = raw.get("state", "Unknown")
known = {"Pending", "Running", "Pausing", "Paused",
         "Resuming", "Stopping", "Terminated", "Failed"}
if state not in known:
    logger.warning("unknown sandbox state: %s", state)
```

这类“归一化”逻辑属于第 2 层，不属于生成层。阶段 3 的 `normalize()` 也是同一类东西：把不稳定的底层输出，收敛成 Agent 能消费的稳定形状。

## 步骤 3 · 五种语言：同一能力，不同习惯

1.1.1 的沙箱 SDK 覆盖：

```text
sdks/sandbox/python
sdks/sandbox/javascript
sdks/sandbox/kotlin
sdks/sandbox/csharp
sdks/sandbox/go
```

注意 JVM 这一支是 **Kotlin 包**，不要按 Java 的命名去猜。

| 语言 | 异步模型 | 典型风格 | 读文档时注意 |
| --- | --- | --- | --- |
| Python | `async/await`，另有 `opensandbox.sync` 同步包装 | 上下文管理器、异常类 | 同步 API 不是另一套实现，语义应对齐 |
| JavaScript/TypeScript | Promise | 类型定义随包发布 | 区分生成类型与手写类型 |
| Kotlin | 协程/挂起函数 | 构建产物含生成代码 | 方法名可能更贴近 HTTP 语义 |
| C# | `async/await` + `CancellationToken` | 强类型模型 | 取消语义与超时要分清 |
| Go | `context.Context` + 显式 `error` 返回 | 无异常，错误逐层返回 | 不要期待“抛异常”式错误处理 |

### 跨语言对齐的正确读法

不要拿 Python 的方法名去其他语言里搜。应该按**能力**对齐：

```text
能力：创建一个带 TTL 的沙箱
  Python:     Sandbox.create(image, timeout=...)
  JS/TS:      对应的 create + timeout 选项
  Kotlin:     对应的 builder/参数
  C#:         对应的 CreateAsync + 参数
  Go:         Create(ctx, req) (Sandbox, error)
```

判断“某语言是否支持某能力”，看三处：该语言的 docs 页、SDK 的公开导出、以及 spec 中对应字段是否存在。三者缺一，就要标注为条件支持。

### 同步包装的边界

Python 的 `opensandbox.sync` 提供 `SandboxSync` 等同步入口，适合脚本和阻塞式框架。但它有两个容易误解的点：

- 它不是“另一个服务端”，底层仍走同一套 HTTP 契约。
- 同步入口里的超时、重试、清理语义必须与异步版一致；如果发现不一致，那是 bug，不是“同步版特性”。

## 步骤 4 · Python SDK 的结构：从入口到适配器

以你最熟悉的 Python 为例，把三层落到具体路径：

```text
opensandbox/sandbox.py                 入口与编排（create / connect / pause / kill）
opensandbox/services/*.py              领域服务（commands / files / egress / ...）
opensandbox/adapters/converter/*.py    请求与响应转换
opensandbox/api/lifecycle/...          生成客户端（lifecycle）
opensandbox/api/execd/...              生成客户端（execd）
opensandbox/models/*.py                对用户暴露的模型
```

一个请求的完整路径：

```text
Sandbox.commands.run(...)
  -> 组装 RunCommandOpts
  -> ExecutionConverter 生成请求体
  -> 生成客户端发 HTTP 到 execd
  -> SSE 事件解析
  -> Execution 模型（text / exit_code / error）
  -> 你的代码
```

这条路径解释了阶段 3 的几个结论：

- 为什么 `text` 不包含 stderr：模型定义如此。
- 为什么 `exit_code` 可能是 `None`：推断逻辑只在有 `error` 或 `complete` 时给值。
- 为什么 timeout 要放在 `RunCommandOpts` 里：它是命令级参数，不是 HTTP 客户端级参数。

读 SDK 时，建议固定一个顺序：**入口方法 → service → converter → 生成模型**。不要一上来读生成代码，那里只有字段，没有意图。

## 步骤 5 · CLI：把 API 变成可组合的命令

`osb` 是官方命令行客户端，安装后先做连接配置：

```bash
osb config init
osb config set connection.domain localhost:8080
osb config set connection.protocol http
osb config set connection.api_key <your-api-key>
osb config show -o json
```

最小闭环：

```bash
osb sandbox create --image python:3.12 --timeout 30m -o json
osb sandbox get <sandbox-id> -o json
osb command run <sandbox-id> -o raw -- python -c "print(1 + 1)"
osb sandbox kill <sandbox-id> -o json
```

### 命令组

| 组 | 管什么 |
| --- | --- |
| `osb sandbox` | 生命周期：创建、查询、续期、暂停、删除 |
| `osb template` | 模板（golden image）构建 |
| `osb snapshot` | 快照管理 |
| `osb command` | 命令执行与持久会话 |
| `osb file` | 文件与目录操作 |
| `osb egress` | 运行时出站策略 |
| `osb diagnostics` | 稳定的诊断日志与事件 |
| `osb devops` | 实验性旧诊断入口，不要用于新脚本 |
| `osb config` | 本地配置 |
| `osb skills` | 给 AI 工具用的内置技能 |

### 输出格式决定它能不能进管道

`-o json` 适合程序消费，`-o raw` 适合把命令输出原样接到下一个程序。写脚本时遵守两条：

1. **总是显式指定输出格式**，不要依赖默认的人类可读格式。
2. **不要解析人类可读文本**，字段顺序和措辞都可能变。

CLI 还带了面向编码 Agent 的内置技能（`osb skills`）。它的价值不是“多了一个命令”，而是把“怎样安全地调用沙箱”沉淀成可复用的操作说明——这已经接近阶段 7 的主题。

## 步骤 6 · MCP：给 Agent 的受限面板

MCP server 把 Python SDK 的一部分能力暴露成工具。它的定位是**受控子集**，不是全量 API。

### 工具清单（1.1.1）

沙箱管理：

```text
sandbox_create        sandbox_connect      sandbox_kill
sandbox_get_info      sandbox_list         sandbox_renew
sandbox_healthcheck   sandbox_get_metrics  sandbox_get_endpoint
```

命令执行：

```text
command_run           command_interrupt
```

文件系统：

```text
file_read             file_write           file_delete
file_search           file_create_directories
file_delete_directories                    file_move
file_replace_contents
```

### 两个关键机制

**1. 本地注册表。** 所有工具都围绕 `sandbox_id` 工作，而这个 ID 由 `sandbox_create` 或 `sandbox_connect` 在本地登记。Agent 不能凭空编一个 ID 去操作——这既是便利，也是约束。

**2. 传输方式。** stdio 适合本地 IDE/客户端拉起；Streamable HTTP 适合远程或多客户端场景。选哪种，决定了谁能连、怎么鉴权、日志落在哪里。

### 为什么 MCP 不暴露全部能力

因为工具是给模型选的，不是给程序员写的。暴露太多低层参数会带来三个问题：

- 模型容易组合出危险操作（任意挂载、任意网络策略）。
- 工具描述变长，选择准确率下降。
- 权限边界变得难以审计。

所以正确的心态是：**MCP 是“安全的常用面”，SDK 是“完整面”**。需要复杂能力时，写一个受控的服务端工具，而不是把整个 SDK 塞给模型。

## 步骤 7 · 契约变更：先改哪一层

假设你要给创建请求增加一个字段 `priority`。正确顺序：

```text
1. specs/sandbox-lifecycle.yml        定义字段、类型、是否必填、默认值
2. 生成客户端                        重新生成各语言低层模型
3. server 实现                        校验、持久化、返回
4. 手写适配层                        暴露便利参数、错误映射、默认值
5. docs / examples                   更新用法与迁移说明
6. 测试                              契约测试 + 各语言 SDK 测试
```

常见错误顺序：

| 错误做法 | 后果 |
| --- | --- |
| 先改 server，后补 spec | 契约与实现漂移，其他语言无法跟进 |
| 只改 Python SDK | 跨语言行为不一致，用户以为“文档错了” |
| 直接改生成文件 | 下次生成被覆盖，问题复发 |
| 把新字段设为必填 | 破坏旧客户端，属于破坏性变更 |
| 不更新 docs | 用户只能读源码猜行为 |

### 兼容性判断

| 变更 | 性质 | 处理 |
| --- | --- | --- |
| 新增可选字段 | 向后兼容 | 可以随版本发布 |
| 新增响应字段 | 通常兼容 | 客户端要容忍未知字段 |
| 改字段含义 | 破坏性 | 需要迁移说明或新字段 |
| 改状态码 | 破坏性 | 必须走契约评审 |
| 删除字段/枚举值 | 破坏性 | 需要弃用周期 |

阶段 0 讲过“输出要给证据”，这里同理：**契约变更的证据是 spec diff + 生成产物 diff + 测试结果**，不是一句“我改好了”。

## 步骤 8 · 实验

> 说明：以下实验只需要一个可用的 lifecycle server；没有 server 时，可以只做静态阅读部分，并标注“未运行”。

### 实验 E1 · 同一件事，三种入口

用三种方式创建同一个沙箱：

```bash
# 1) CLI
osb sandbox create --image python:3.12 --timeout 5m -o json

# 2) 原始 HTTP
curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "OPEN-SANDBOX-API-KEY: dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"image":{"image":"python:3.12"},"timeout":300,"entrypoint":["tail","-f","/dev/null"]}'

# 3) Python SDK（阶段 0 的脚本）
```

对比三份请求体：SDK 和 CLI 帮你补了哪些默认值？哪些字段是服务端补的？把差异写成一张表，你就理解了“便利层”在做什么。

### 实验 E2 · 找到生成与手写的边界

在 Python SDK 里追一条链路：

```text
Sandbox.commands.run
  -> opensandbox/services/commands.py
  -> opensandbox/adapters/converter/command_execution.py
  -> opensandbox/api/execd/...
```

标出哪一层处理了 `exit_code` 推断、哪一层只是字段映射。然后回答：如果要支持一个新的 SSE 事件类型，应该改哪一层？

### 实验 E3 · 跨语言读同一个能力

打开 `docs/sdks/python.md`、`javascript.md`、`kotlin.md`、`csharp.md`、`go.md`，只找“创建沙箱”和“执行命令”两件事，列出各自的方法名和参数风格。

不要评价“哪个更好”，只记录差异。目标是建立“按能力检索”的习惯，而不是背方法名。

### 实验 E4 · CLI 进管道

```bash
SID=$(osb sandbox create --image python:3.12 --timeout 5m -o json | jq -r '.id')
osb command run "$SID" -o raw -- python -c "print(6 * 7)"
osb file write "$SID" /workspace/answer.txt -c "42" -o json
osb file cat "$SID" /workspace/answer.txt -o raw
osb sandbox kill "$SID" -o json
```

如果 `jq` 不可用，就用 Python 解析 JSON。重点是：**ID 从输出里取，不要手抄。**

### 实验 E5 · MCP 的最小闭环

启动 MCP server（stdio 或 HTTP），按 README 的最小流程走：

```text
sandbox_create -> command_run -> file_read -> sandbox_kill
```

观察两件事：`sandbox_id` 是怎么在本地登记的；哪些 SDK 能力在工具列表里找不到。第二件事就是你未来要补“受控工具”的地方。

### 实验 E6 · 契约变更推演（只读）

在 spec 里找一个可选字段，追踪它到三种语言 SDK 的模型。回答：

- 如果这个字段改成必填，哪些客户端会坏？
- 如果新增一个枚举值，哪些语言会反序列化失败？
- 生成代码重新生成后，手写层需要改哪里？

不需要真的改 spec；把影响面写清楚即可。

## 故障速查

| 现象 | 先查什么 | 常见根因 |
| --- | --- | --- |
| 401 | `OPEN-SANDBOX-API-KEY`、CLI config | 没配 key、配到了另一个 profile |
| 404 | 路径前缀、sandbox ID | 少了 `/v1`、ID 过期或拼错 |
| SDK 报字段不存在 | SDK 版本 vs server 版本 | 客户端滞后或超前于服务端 |
| 跨语言行为不同 | 各语言手写层 | 默认值/错误映射未对齐 |
| CLI 输出解析失败 | `-o` 格式 | 解析了人类可读输出 |
| MCP 工具报未知 sandbox | 本地注册表 | 没先 create/connect，或进程重启丢状态 |
| 生成代码改动丢失 | 改了 `generated/**` | 应改 spec 或生成配置 |
| 新状态导致崩溃 | 状态枚举 | 手写层未容忍未知值 |

## 常见误区

| 误区 | 纠正 |
| --- | --- |
| “SDK 就是服务端能力清单” | SDK 是客户端；能力还受 server 版本、配置、运行时限制 |
| “五种语言是同一份代码翻译” | 共享契约，各自实现；细节可能有差异 |
| “同步 SDK 是另一套实现” | 同一契约的阻塞式包装，语义应对齐 |
| “CLI 是另一个控制面” | 它只是 lifecycle API 的客户端 |
| “MCP 能做的和 SDK 一样多” | MCP 是受控子集，复杂能力要自己封装 |
| “改了生成代码就算修好” | 下次生成会覆盖；应改源头 |
| “响应多一个字段没关系，可以忽略” | 客户端必须容忍未知字段，但服务端不能随意改含义 |
| “文档没写但代码支持，就能用” | 未进 spec 的行为不构成契约 |

## 自检与参考答案

**1. 为什么说 `specs/` 是唯一真相？**

因为 server、execd、各语言 SDK、CLI 都围绕它实现。只改某一层会造成漂移；只有 spec 能同时约束所有消费者。

**2. 生成代码和手写代码各自负责什么？**

生成层负责与契约一一对应的模型和低层调用；手写层负责默认值、错误映射、状态归一化、轮询与清理等业务语义。两者混用会导致生成覆盖手写逻辑。

**3. Python 的同步 SDK 和异步 SDK 是什么关系？**

同一契约的两种调用风格。同步版是阻塞式包装，不应有独立语义；发现行为差异应当作缺陷处理。

**4. 判断某语言是否支持某能力，应该看哪三处？**

该语言文档、SDK 公开导出、spec 中对应字段。三者缺一就要标注为条件支持。

**5. CLI 的输出为什么要显式指定格式？**

因为默认格式面向人类，字段顺序和措辞可能变化。脚本应使用 `-o json` 或 `-o raw`，避免解析易变文本。

**6. MCP 为什么只暴露子集？**

工具是给模型选择的。暴露全部低层参数会增加误用风险、降低选择准确率，并让权限边界难以审计。

**7. 给创建请求加字段，正确顺序是什么？**

spec → 重新生成 → server 实现 → 手写适配层 → 文档/示例 → 测试。先改实现会造成契约漂移。

**8. 哪些契约变更属于破坏性变更？**

改字段含义、改状态码、删除字段或枚举值、把可选变必填。需要迁移说明或新字段过渡。

**9. 为什么客户端要容忍未知状态值？**

服务端可能先于 SDK 增加状态。手写层若强映射，会把正常的新状态变成崩溃。正确做法是保留原值并记录警告。

**10. 原始 HTTP 还有必要学吗？**

有必要。它是排查 SDK 行为、跨语言最小集成和理解契约的最短路径；也是判断“是 SDK 问题还是服务端问题”的分界线。

## 关键源码坐标

| 想回答的问题 | 先看 |
| --- | --- |
| 生命周期契约 | `specs/sandbox-lifecycle.yml` |
| execd 契约 | `specs/execd-api.yaml` |
| egress/凭据契约 | `specs/egress-api.yaml` |
| 诊断契约 | `specs/diagnostic-api.yml` |
| Python 入口与编排 | `sdks/sandbox/python/src/opensandbox/sandbox.py` |
| Python 手写适配 | `sdks/sandbox/python/src/opensandbox/adapters/`、`services/` |
| Python 生成客户端 | `sdks/sandbox/python/src/opensandbox/api/` |
| 各语言 SDK 文档 | `docs/sdks/*.md` |
| CLI 用法与命令组 | `cli/README.md`、`docs/cli/index.md` |
| MCP 工具与启动 | `sdks/mcp/sandbox/python/README.md` |
| SDK 开发约定 | `sdks/AGENTS.md` |

## 做完之后

你现在应该能把“用哪个入口”当成一个工程决策，而不是个人偏好；也能在改契约时，按正确顺序动每一层。

下一阶段把这些入口交给真正的主角：**Agent**。当模型自己决定创建沙箱、执行命令、读文件时，工具契约、预算、重试和上下文管理会变成新的问题。

带着这个问题进入下一章：**“把沙箱交给模型之后，谁来保证它不失控？”** 进入[阶段 7](../stage-7/)。
