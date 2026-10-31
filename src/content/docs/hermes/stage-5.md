---
title: "阶段 5：Provider、凭据与 Fallback"
description: "阶段 5：Provider、凭据与 Fallback。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：Hermes Agent 源码课 · 阶段卷
> 前置：阶段 3、4
> 对应总览：`turn-lifecycle.md` 第 8 节，`core-mechanisms.md` 第 4 节
> 本阶段目标：区分请求构造、传输重试、凭据轮换和 provider fallback，理解为什么 fallback 必须重建上下文。

## 1. 本阶段解决什么

Provider 层不是“一个 OpenAI SDK 换个 base_url”。Hermes 要同时面对：

- OpenAI-compatible、Anthropic、Bedrock、Gemini、Codex 等不同 wire format；
- API key、OAuth、环境变量、credential pool 多种凭据来源；
- 限流、超时、过载、上下文超窗、鉴权过期、模型不可用等不同错误；
- 同一 provider 的 key 轮换、模型 cooldown 与跨 provider fallback；
- 每个 provider 的 context window、tool schema、reasoning replay 和请求字段差异。

这里的关键不是“会不会重试”，而是 **每种恢复动作改变的是哪一层事实**。

## 2. 先记住一个判断

**Retry 复用当前请求；credential recovery 更换调用凭据；fallback 更换 provider/模型并重建整个请求上下文。**

三者不能混：

- retry 可以继续用同一 `api_messages`，但必须受次数和间隔约束；
- 换 key 仍可能保持 provider、模型和上下文窗口，因此可从当前请求继续；
- 换 provider 后 context window、adapter、schema、system prompt 兼容性都可能变化，必须回到 preflight。

## 3. 源码主线

1. `providers/base.py::ProviderProfile` 描述 provider 的 `auth_type`、环境变量、base URL、API mode、模型目录和能力。
2. `providers/__init__.py` 负责内置 provider 注册/发现；用户插件也可以提供 provider。
3. `agent/credential_pool.py` 管理 pooled credentials、来源标签、优先级、cooldown、失败计数和刷新。
4. `agent/conversation_loop.py` 在 turn 开始时刷新环境凭据，让 Settings 保存的 `.env` 不一定等到进程重启才生效。
5. `agent/turn_api_request.py::build_api_request()` 组装 messages、system prompt、tools、extra body/headers、request id，并触发 pre-API hook。
6. `agent/turn_api_call.py::perform_api_call()` 根据 provider 与配置选择流式或非流式调用，并把响应/异常转换为 verdict。
7. `_run_api_retry_loop()` 在 `max_retries` 内执行 `request → call → error handling`。
8. `agent/turn_api_error.py::handle_api_error()` 先尝试 `recover_before_classification()`，再分类错误、恢复凭据、处理 overflow，最后 settle 未恢复错误。
9. 一旦 fallback 激活，必须令 `restart_with_rebuilt_messages` 生效并从重试环 `break`，让下一轮重新走 assemble 与 preflight。
10. 新的 provider 可能改变 token 预算和消息兼容性，所以不能把旧 provider 校验过的 wire copy 直接复用。

## 4. 关键对象与合同

| 对象 | 责任 | 不能做 |
| --- | --- | --- |
| `ProviderProfile` | 声明 provider 合同 | 假装所有 provider 同构 |
| adapter | 转换请求/响应/流事件 | 改写 durable transcript |
| `ApiRequestBuild` | 一次 wire request 的构建结果 | 绕过 preflight |
| `ApiCallVerdict` | 调用阶段结果 | 自行决定 fallback 上下文 |
| `ApiErrorVerdict` | 错误恢复动作 | 在 fallback 后沿用旧 messages |
| `CredentialPool` | 选择与冷却凭据 | 把某个 key 的失败当成整个 provider 永久死亡 |
| fallback route | 新 provider/模型选择 | 跳过 rebuild/preflight |

错误分类至少要区分：

- **本地校验/参数错误**：重试相同请求通常无用；
- **鉴权/凭据错误**：可刷新 OAuth、换 key 或标记该凭据冷却；
- **限流/过载/瞬时网络错误**：可限次退避重试；
- **上下文超窗**：压缩或切更大窗口，不能无限重发；
- **provider 不可用/能力不匹配**：进入 fallback；
- **用户中断/进程关闭**：停止，不进入普通 retry。

## 5. 一条可观察链路

~~~text
assemble_api_request
  → build_api_request
       messages + system prompt + tools
       provider profile / auth / base_url
       hooks / headers / request id
  → perform_api_call
       success → normalize response
       error   → handle_api_error
                   recover_before_classification
                   classify
                   credential recovery / overflow / retry
                   fallback armed?
                     yes → break retry loop
                         → re-assemble / preflight / build with new provider
                     no  → settle unrecovered
  → next model turn or terminal result
~~~

观察点：fallback 日志后不应立刻出现旧请求的“重发”；正确表现是回到 preflight 重新估算，再产生一次新 provider 的 request。

## 6. 实验

### 实验 A：单凭据瞬时 429

模拟一次 429 后成功，观察 retry 次数、退避和请求是否复用。

### 实验 B：凭据池轮换

准备两个 key，让第一个持续 401，观察冷却/换用第二个以及主请求是否继续。

### 实验 C：跨 provider fallback

让主 provider 返回可 fallback 错误，记录 fallback 前后 context window、messages 和 preflight 次数。

### 实验参考答案

1. **实验 A**：应限次重试并复用同一请求；成功后不切换 provider。若错误被判定不可重试，则直接进入后续恢复或失败。
2. **实验 B**：第一个凭据应被冷却/降级，第二个可服务同一 provider 请求；不能把 provider 永久标死，也不能无限刷新同一个坏 key。
3. **实验 C**：fallback 激活后必须离开原 retry loop，重新 assemble 并经过 preflight；新请求的 token 估计、adapter 字段和消息副本应由新 provider 重新生成。

## 7. 失败与恢复

| 失败 | 正确动作 | 常见错误 |
| --- | --- | --- |
| 401 / OAuth 过期 | 刷新/换凭据或 fallback | 无限原样重试 |
| 429 / overload | 有限退避 retry | 立即并发轰炸 |
| context length | 压缩/扩窗/fail closed | 截断后偷偷发送 |
| provider 5xx | 按策略 retry/fallback | 把流式半包当完整响应 |
| 不支持的 tool schema | 适配或换 provider | 发送旧 provider 字段 |
| fallback | 重建 messages、preflight | 直接复用旧请求 |
| 用户中断 | 停止并闭合 turn | 当普通网络错误重试 |
| 进程关闭 | 放弃 turn，返回明确失败 | 在 shutdown 中继续轮换 |

## 8. 通关自测

1. retry、credential rotation、fallback 各改变哪一层？
2. 为什么工具可见性要在 provider 适配前后都保持可解释？
3. fallback 为什么必须回到 preflight？
4. 上下文超窗与 429 的处理为什么不同？
5. 凭据池冷却解决什么问题，不能解决什么？
6. 流式调用失败时，为什么不能直接把已收到的半段文本当成功？

### 参考答案

1. retry 复用当前请求；credential rotation 更换同一 provider 的凭据；fallback 更换 provider/模型，并重新构造上下文与请求。
2. 不同 provider 支持的工具 schema 能力不同；适配要保证模型看到的是合法、可执行、经过授权的工具集合，而不是旧 provider 的残留字段。
3. 因为新 provider 的 context window、tokenizer、消息格式和系统提示兼容性可能不同。旧请求可能超窗或包含不兼容字段，必须重新估计、压缩和组装。
4. 429 是暂态资源限制，可退避重试；超窗是请求结构/预算问题，重发同样内容不会成功，必须压缩、扩窗或明确失败。
5. 它避免反复使用已知失败的凭据、分摊限流并保存恢复状态；它不能把无效请求、超窗或 provider 能力不匹配变成成功。
6. 半段文本不是完整模型消息，reasoning、tool calls、finish reason 和 usage 都可能缺失；当成功会污染 transcript，必须按错误恢复或明确失败。

## 9. 源码坐标

- `providers/base.py::ProviderProfile`
- `providers/__init__.py`
- `agent/credential_pool.py::CredentialPool`
- `agent/turn_api_request.py::build_api_request`
- `agent/turn_api_call.py::perform_api_call`
- `agent/turn_api_error.py::handle_api_error`
- `agent/conversation_loop.py::_run_api_retry_loop`
- `tests/hermes_cli/test_oneshot_fallback.py`
- `tests/gateway/test_custom_provider_request_overrides.py`

## 10. 下一步

进入阶段 6：一次 turn 即使跑完，也要靠 SessionDB 把消息、admission、lease、压缩和恢复事实落成可重放的账本。
