---
title: "阶段 5：模型接入"
description: "用模型适配层隔离供应商差异，并理解流式输出与路由。"
---

> **本阶段的位置**：阶段 2 的循环已经会“请求模型、接收回复、执行工具”，阶段 3 已经说明请求里带什么上下文。现在回答：模型请求到底发给了谁，为什么换一家厂商不用重写循环？
> **源码目录**：`$PI_SRC`。核心材料：`packages/ai/`、`packages/coding-agent/docs/providers.md`、`models.md`、`custom-provider.md`、`virtual-models.md`、`packages/coding-agent/src/core/model-runtime.ts`。
> **一句话主线**：循环只认识一套统一接口；`packages/ai` 把不同厂商的认证、协议、模型信息和流式事件，翻译成同一套内部语言。

## 一、这一阶段到底在解决什么

如果把 Agent 想成一辆车，那么：

- 循环是发动机的控制逻辑；
- 工具是车轮和机械臂；
- 上下文是燃料和行驶记录；
- **模型是发动机本身**。

问题在于，现实中的“发动机”有几十种，而且每家接口都不一样：

- 有的用 API Key，有的用 OAuth，有的用云平台临时凭据；
- 有的返回 `choices[].delta.content`，有的返回 `content_block_delta`，有的返回 `candidates[].content.parts`；
- 有的把工具调用参数放在 JSON 字符串里分片返回，有的用独立事件返回；
- 每家的上下文窗口、最大输出、是否支持图片、价格和思考等级都不同。

如果循环自己解析这些差异，那么每接入一家厂商，就要改循环、改界面、改压缩逻辑、改错误处理。代码很快就会变成一堆 `if provider === ...`。

所以模型接入层要解决的是：

> **把“不同厂商怎样说话”挡在引擎外面，让循环只看到统一的模型、统一的请求和统一的事件。**

学完本章，你应该能分清厂商、协议、模型、凭据和适配器，并知道新增一个模型时，应该改配置、改目录，还是写一个新的适配器。

---

## 二、五个词必须分开

### 2.1 Provider、API、Model、Credential、Adapter

先看一张表：

| 词 | 人话解释 | 例子 |
| --- | --- | --- |
| Provider（供应商） | 你从哪家公司或服务获得模型 | OpenAI、Anthropic、Google、DeepSeek、OpenRouter、本地 llama.cpp |
| API（协议） | 双方约定的“说话格式” | OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI |
| Model（模型） | 真正负责生成内容的那个模型 | `gpt-...`、`claude-...`、`gemini-...`、某个本地模型 |
| Credential（凭据） | 证明你有权使用服务的钥匙 | API Key、OAuth token、云平台凭据 |
| Adapter（适配器） | 把某套协议翻译成 Pi 内部事件的代码 | `openai-completions.ts`、`anthropic-messages.ts` |

最容易混的是前两个。

### 2.2 Provider 不等于 API

同一个供应商可以使用不同协议，不同供应商也可以使用同一种协议。

```text
Provider：DeepSeek
API：openai-completions
             ▲
             └── 它说的是 OpenAI 那一套“方言”

Provider：OpenAI
API：openai-responses
             ▲
             └── 同一家公司也可以有另一种协议
```

所以“接入 DeepSeek”并不一定意味着“从零写一个 DeepSeek 协议”。如果它支持 OpenAI 兼容接口，Pi 可以复用现成的 `openai-completions` 适配器。

这就是模型接入层能收敛的原因：**真正需要适配的是协议差异，不是公司名字。**

### 2.3 一个模型条目包括什么

Pi 内部的 `Model` 不只是一个字符串。一个完整模型至少需要：

| 字段 | 为什么需要 |
| --- | --- |
| `provider` | 这个模型由谁提供 |
| `id` / `name` | 模型标识和显示名 |
| `api` | 应该用哪种协议适配器 |
| `baseUrl` | 请求发到哪个地址 |
| `input` | 支持文本、图片还是两者 |
| `contextWindow` | 上下文最多能放多少 token，影响压缩 |
| `maxTokens` | 一次最多生成多少 token |
| `reasoning` | 是否支持思考模式 |
| `thinkingLevelMap` | Pi 的思考等级如何映射到该模型 |
| `cost` | 输入、输出、缓存读写各多少钱 |
| `headers` / `compat` | 端点需要的特殊请求头或兼容选项 |

这些信息不是“展示用的元数据”。它们直接参与：

- 压缩阈值；
- 图片能不能发；
- 思考等级选择；
- 成本统计；
- 模型筛选；
- 请求参数构造。

所以一个“模型能不能用”，不只是看它能不能返回文字，还要看这些能力描述是否可信。

---

## 三、一次模型请求在代码里怎样走

把阶段 2 的循环放大，会看到这样一条链路：

```text
Agent 循环
  │  统一上下文：messages + tools + options
  ▼
StreamFn / Models.streamSimple()
  │  选择 provider，解析凭据，找到 API 实现
  ▼
Provider 适配器
  │  把内部消息转换成厂商请求
  ▼
HTTP / SSE / WebSocket
  │  厂商返回自己的流式数据
  ▼
API 适配器解析
  │  翻译成统一的 AssistantMessageEvent
  ▼
Agent 循环继续判断：
  纯文本？工具调用？错误？被截断？
```

这里有三层“事件”，不要混：

| 层次 | 例子 | 谁产生 |
| --- | --- | --- |
| 厂商原始流 | SSE 数据块、JSON 增量、WebSocket 消息 | 模型服务 |
| 模型层统一事件 | `text_delta`、`toolcall_delta`、`done`、`error` | `packages/ai` 的适配器 |
| Agent 会话事件 | `message_update`、`tool_execution_start`、`agent_settled` | 循环与会话层 |

阶段 1 看到的 JSON 事件属于第三层。它的底层来源可能是完全不同的厂商协议，但到了界面和程序手里，形状已经统一了。

---

## 四、`packages/ai` 的五个抽屉

不需要背每个文件，先知道五类职责：

### 4.1 契约：统一的数据形状

`src/types.ts` 定义了：

- 有哪些 API 类型；
- `Model` 长什么样；
- 统一消息格式；
- `AssistantMessageEvent` 有哪些事件；
- 错误和停止原因如何表示。

这是整个接入层的“合同”。循环依赖合同，不依赖某家厂商的实现。

### 4.2 模型集合：注册、查找和分发

`src/models.ts` 负责：

- 创建模型集合；
- 注册 provider；
- 根据 `provider + id` 找模型；
- 解析凭据；
- 把流式请求分发给对应的 API 实现；
- 计算成本和思考等级。

可以把它理解成“电话总机”：循环只说“我要找这个模型”，总机负责找到正确线路。

### 4.3 认证：钥匙从哪里来

`src/auth/` 负责 API Key、OAuth、凭据存储和刷新。它不关心模型输出长什么样，只负责让请求带上正确的身份证明。

### 4.4 API 实现：每种协议的翻译器

`src/api/` 下每个文件通常对应一种协议，例如：

- `openai-completions.ts`
- `openai-responses.ts`
- `anthropic-messages.ts`
- `google-generative-ai.ts`
- `bedrock-converse-stream.ts`

这些文件负责“内部消息 → 厂商请求 → 厂商流 → 内部事件”的转换。

### 4.5 Provider 工厂和模型目录：把身份、凭据、协议、模型装在一起

`src/providers/` 下的一家厂商通常做四件事：

```ts
createProvider({
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  models: Object.values(DEEPSEEK_MODELS),
  api: openAICompletionsApi(),
})
```

翻译成人话：

> 这是 DeepSeek；地址在这里；钥匙从环境变量来；模型清单是这些；请求按 OpenAI Completions 协议发送。

注意最后一句：**接入新厂商时，真正需要写的往往只是这份“装配单”，而不是重新实现协议。**

---

## 五、认证：先找钥匙，再发请求

### 5.1 凭据来源的优先顺序

Pi 的典型解析顺序是：

```text
本次运行的 --api-key 覆盖
        ↓
已存储的 auth.json 凭据（API Key 或 OAuth）
        ↓
models.json 中配置的 apiKey
        ↓
环境变量或云平台环境凭据
```

但这里有一个关键细节：

> **只要某个 provider 已经存在“存储凭据”，存储凭据就拥有这个 provider。** 它刷新失败时，不会悄悄回退到环境变量。

这是为了避免“明明登录了 A 账号，却因为环境里还有 B 账号的 Key，悄悄用了 B”的混乱。

### 5.2 凭据不只是 Key

常见认证方式有：

- 环境变量里的 API Key；
- `/login` 保存到 `auth.json` 的 API Key；
- OAuth 登录和自动刷新；
- `models.json` 里写的命令行取值；
- 云平台的 profile、角色或临时凭据。

凭据不是模型目录的一部分。目录可以公开，凭据不能。

### 5.3 安全规则

在实际开发中要守住三条：

1. 不要把 token、完整请求头或完整厂商响应写进普通日志；
2. 不要把 `auth.json` 提交进仓库；
3. 自定义 provider 代码和扩展同权限运行，必须只加载可信代码。

“能在本地跑通”不等于“可以安全分享”。模型适配层经常能接触凭据，所以它天然处在信任边界上。

---

## 六、模型目录：为什么是“构建时生成”

### 6.1 模型元数据不能临时猜

在发出请求之前，Pi 就需要知道：

- 这个模型的上下文窗口多大；
- 支不支持图片；
- 一次最多输出多少；
- 是否支持思考；
- 每百万 token 多少钱。

如果每次启动都去网上抓，会出现三个问题：

1. 没网时不能用；
2. 启动慢且容易受网络故障影响；
3. 类型和字段不稳定，代码难以检查。

所以 Pi 采用“构建时生成目录”的办法：

```text
上游模型数据
   → 生成脚本
   → packages/ai/src/models.generated.ts
   → 随包发布，离线可读
```

运行时还可以从 pi.dev 覆盖更新的目录，并保留缓存。这样既有离线兜底，也能更新新模型信息。

### 6.2 为什么不直接手改生成文件

`models.generated.ts` 是生成产物。直接手改会在下一次生成时被覆盖，也会破坏“单一事实源”。

正确顺序是：

```text
改生成逻辑或上游数据
  → 运行模型数据更新/生成命令
  → 检查生成差异
  → 跑测试和检查
```

学习阶段你只需要知道这条边界，不需要背生成脚本的每个字段。

### 6.3 模型选择时为什么要消歧

不同 provider 可能提供同名模型。比如同一个 `sonnet` 名称，可能来自不同的云平台或代理。

因此 Pi 支持：

```powershell
pi --model anthropic/claude-...
pi --model claude-... --provider anthropic
```

选择规则大致是：

1. `provider/model` 明确指定时，优先使用这个 provider；
2. 没有前缀时，优先选凭据可用的匹配项；
3. 如果仍有多个候选，要求用 `--provider` 消歧。

这不是“名字匹配”的小问题。选错 provider 可能意味着错误的价格、端点、能力或凭据。

---

## 七、流式事件是怎样归一化的

### 7.1 不同厂商，同一套动作

各家流式协议长得不同，但抽象后其实只有几类动作：

```text
开始响应
输出一段文字
输出一段思考
开始一个工具调用
追加一段工具参数 JSON
结束一个内容块
成功结束 / 出错 / 被中止
```

Pi 用 `AssistantMessageEvent` 把这些动作统一表示：

| 统一事件 | 含义 |
| --- | --- |
| `start` | 流开始 |
| `text_start` / `text_delta` / `text_end` | 文字块开始、增量、结束 |
| `thinking_start` / `thinking_delta` / `thinking_end` | 思考块开始、增量、结束 |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | 工具调用开始、参数增量、完整调用 |
| `done` | 正常结束，带停止原因和完整消息 |
| `error` | 出错或被中止，带错误消息 |

适配器的工作，就是把厂商的“方言”翻译成这张表里的动作。

### 7.2 为什么工具参数要分片

模型生成工具调用时，参数往往是一段 JSON，而且会随着流式输出一点点出现：

```text
toolcall_start
toolcall_delta  {"path": "src/
toolcall_delta  main.ts", "limit":
toolcall_delta   50}
toolcall_end    { path: "src/main.ts", limit: 50 }
```

循环不会在第一个 `delta` 就执行工具。它必须等到 `toolcall_end`，拿到完整参数，后面才进入校验和执行。

### 7.3 错误为什么编码进流里

模型请求可能遇到：

- 网络断开；
- 认证失效；
- 限流；
- 上下文超限；
- 用户中止；
- 厂商返回不可恢复错误。

Pi 的流式接口约定，模型请求层的失败通常应通过最终错误消息或错误事件表达，而不是让流消费者只收到一个未处理的拒绝。这样上层循环可以统一决定：

- 是否自动重试；
- 是否压缩后重试；
- 是否把错误告诉用户；
- 是否把排队消息恢复出来。

这也是为什么你会在 JSON 事件里看到 `error`、`auto_retry_start`、`auto_retry_end` 之类的事件。

---

## 八、接入新模型：先选最小方案

很多人的第一反应是“我要写一个 provider”。实际上应该先判断需求：

| 需求 | 最小方案 |
| --- | --- |
| 服务已经有 OpenAI / Anthropic / Google 兼容接口 | 在 `models.json` 里配置端点 |
| 只改某个内置 provider 的地址或请求头 | `models.json` 覆盖或很小的 provider 配置 |
| 需要动态发现模型 | provider 扩展的 `refreshModels` |
| 需要自定义登录流程 | provider 扩展的认证实现 |
| 需要完全不同的线上协议 | 实现新的 `stream` / `streamSimple` |
| 想按请求把模型路由到不同后端 | 虚拟模型（virtual model） |

原则：**能配置就不写代码，能复用现有协议就不新造协议。**

### 8.1 零代码接入一个 OpenAI 兼容端点

在用户目录的 `models.json` 中配置：

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "my-local": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "local-dummy-key",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

这里每个字段都很重要：

- `my-local`：你给这个 provider 起的名字；
- `baseUrl`：服务地址；
- `api`：使用哪种协议适配器；
- `apiKey`：有些本地服务不校验，但客户端仍需要一个占位值；
- `models`：这个端点暴露的模型 ID。

然后在 Pi 中选模型，或直接指定：

```powershell
cd $PI_SRC
.\pi-test.ps1 --provider my-local --model qwen2.5-coder:7b --print "用一句话介绍你自己"
```

如果服务实际上不是 OpenAI 兼容协议，不要硬套这个配置；否则会出现请求格式、流式事件和工具调用全部对不上。

### 8.2 什么时候必须写 provider 扩展

只有这些情况值得写：

- 认证方式无法用 API Key/现有 OAuth 表达；
- 模型列表需要动态查询；
- 请求体和响应流是另一种协议；
- 需要在请求前后做厂商特有的处理。

provider 扩展本质上还是一个扩展：它在 Pi 进程内运行，注册自己的 provider、认证、模型和流式实现。它能看到凭据、请求和响应，因此必须按“可信代码”对待。

### 8.3 虚拟模型是什么

虚拟模型解决的是另一类问题：

> 用户想选择一个名字，但实际请求应该按规则路由到不同后端。

例如：

```text
用户选择：company/fast
实际请求：根据任务、成本或可用性，转到 A 模型或 B 模型
```

它把“选择哪个模型”和“最终派发到哪个模型”分开。初学阶段知道这个能力存在即可，不需要先写路由器。

---

## 九、你可以马上做的观察

### 实验 1：看模型目录和可用性

```powershell
cd $PI_SRC
.\pi-test.ps1 --list-models
```

问自己：

- 哪些 provider 有凭据，哪些没有？
- 同一个模型名是否出现在多个 provider 下？
- 一个模型没有出现，是目录没有它，还是凭据不可用？

### 实验 2：观察一次流式事件

```powershell
.\pi-test.ps1 --mode json "用三句话解释什么是流式响应" > model-events.jsonl
```

在文件里找：

1. `message_start`；
2. 多个 `text_delta`；
3. `text_end`；
4. `message_end`；
5. `turn_end`。

然后解释：**为什么 `message_update` 里是增量，而最终以 `message_end` 为准？**

### 实验 3：找一次工具调用的参数分片

让模型读取一个文件，在 JSON 流里寻找 `toolcall_start`、`toolcall_delta`、`toolcall_end`。确认：

- 参数不是一次性出现的；
- 只有完整参数才进入执行；
- 工具执行事件发生在 `toolcall_end` 之后。

---

## 十、常见误区

| 误区 | 正确理解 |
| --- | --- |
| Provider 就是 API 协议 | Provider 是服务来源；API 是请求/响应的协议 |
| 接了新公司就必须写新协议 | 如果它兼容现有协议，只需配置 provider 和模型 |
| 模型 ID 一样就是同一个模型 | 不同 provider、端点、能力和价格可能不同 |
| 有模型目录就能用 | 还要有可用凭据，且端点兼容 |
| 模型目录是运行时随便抓的 | 内置目录构建时生成，可离线使用并支持覆盖更新 |
| 看到 `text_delta` 就可以拼出最终消息 | 最终内容以 `message_end` 的权威消息为准 |
| 工具参数一分片就可以执行 | 必须等完整工具调用和参数校验 |
| 厂商报错就应该让整个进程崩掉 | 请求错误通常编码进流，由上层决定重试或恢复 |
| 自定义 provider 只是配置 | 它是在 Pi 进程内运行的代码，拥有同等权限 |

---

## 十一、通关自检

请先不看文档回答：

1. Provider、API、Model、Credential 各是什么？举一个“同一协议被多个 provider 使用”的例子。
2. 没有模型接入层，循环会被迫处理哪些差异？
3. 凭据的常见来源有哪些？为什么存储凭据存在时不能悄悄回退到环境变量？
4. 模型元数据里的 `contextWindow`、`input`、`cost` 分别影响什么？
5. 厂商流、`AssistantMessageEvent`、Agent 事件三者是什么关系？
6. 什么情况下只需改 `models.json`，什么情况下必须写 provider 扩展？
7. 为什么同一模型名可能需要 `provider/model` 或 `--provider` 消歧？

建议产出：

- [ ] 一张“循环 → Models → Provider → API → HTTP”的链路图；
- [ ] 一份 `models.json` 配置，能解释每个字段；
- [ ] 一张“厂商字段 → 统一事件”的对照表；
- [ ] 一段 3 分钟讲解，说明为什么换模型不该改循环。

下一站是阶段 6：扩展。模型和工具都已经能被替换，接下来看看怎样在不改核心的情况下，把新能力接入同一套运行时。

---

*配套[学习路线](../learning-path/)阶段 5 · 基于 v1.3.0（`71023aec`）*
