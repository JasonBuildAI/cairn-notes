---
title: "阶段 5：模型认证、Fallback 与 Harness"
description: "阶段 5：模型认证、Fallback 与 Harness。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 2～4
> 对应总览：`02-核心机制.md` 的模型接入部分
> 本阶段目标：分清模型解析、认证、候选链、模型 fallback 与 harness 选择。

## 1. 本阶段解决什么

“用哪个模型”远不只是读一个字符串。OpenClaw 要解析：

- 逻辑 model ref 对应哪个 provider/model；
- 当前账号有哪些 auth profile；
- 首个候选失败时，换凭据、换模型还是 surface error；
- 哪个 harness 能支持该 provider、模型与工具策略；
- 显式插件 harness 失败时，能否回退内建 OpenClaw；
- 失败候选的输出能不能污染最终 transcript。

## 2. 先记住一个判断

**模型 fallback 仍在同一个 harness 内换路由；harness fallback 换的是执行运行时。**

前者通常保持工具循环与会话协议，后者可能改变 steering、工具策略、session 映射和能力。两者都必须保证只有被接受的候选推进 transcript。

## 3. 源码主线

1. `model.ts::resolveModelAsync()` 解析 provider/model、workspace、registry 与认证上下文。
2. `model-resolution.ts` 与 `model-fallback-candidates.ts` 生成候选链。
3. `run/model-setup.ts` 冻结本次 run 的 model ownership 与 auth 选择，避免准备后漂移。
4. `embedded-agent-runner/run/attempt.ts` 执行候选；失败按 rotate/fallback/surface 决策。
5. `harness/selection.ts` 解析显式或 auto harness，校验 provider/model/tool policy 支持。
6. `harness/auto-selection.ts` 先过滤明确不支持的候选，再按优先级选择。
7. `harness/builtin-openclaw.ts` 提供内建 fallback；插件 harness 如果未声明 lossless fallback，失败默认 fail closed。

## 4. 关键对象与合同

| 对象 | 作用 | 不能做什么 |
| --- | --- | --- |
| model ref | 逻辑模型身份 | 把 provider 错误当模型不存在 |
| auth profile | 账号/凭据选择 | 在失败后无记录地换账号 |
| candidate chain | 可尝试的模型/路由顺序 | 无限重试或重复副作用 |
| harness | 实际执行运行时 | 绕过统一 tool policy |
| selection decision | 为何选/拒某 harness | 只凭 id 同名信任 |
| fallback policy | 失败转移规则 | 把 harness fallback 当模型 fallback |

### auto harness 的选择顺序

```text
枚举注册的插件 harness
  → 检查 provider/model/tool policy/运行能力
  → 去除 explicit-only 或明确不支持者
  → 选优先级最高
  → 同优先级按 id 稳定排序
  → 无可用插件时回内建 OpenClaw
```

“可用”不是“注册了”。支持条件、认证、平台能力和策略都可能让它不可用。

### 失败候选与 transcript

一个候选失败后，不能把它的半截 assistant 输出写进最终历史。只有被接受、能继续会话的候选才能推进 transcript；其余失败要作为诊断/候选事件保留，不能混入最终消息序列。

## 5. 一条可观察链路

```text
model ref
  → resolve provider/model
  → auth profile
  → candidate chain
  → harness selection
  → attempt
  → error? rotate/fallback/surface
  → accepted candidate
  → loop continues
  → transcript commit
```

调试时记录每次候选的 provider、model、auth profile、harness、错误类型和最终是否 accepted，而不是只看最后一个错误。

## 6. 实验

### 实验 A：凭据轮换

让首个 auth profile 返回可轮换错误。参考验收：换凭据但保持同一 harness/会话协议；失败配置不被标记为成功。

### 实验 B：模型 fallback

让主模型不可用，配置备选模型。参考验收：候选链切换，工具循环继续；最终 transcript 只有被接受模型的有效消息。

### 实验 C：harness auto 选择

注册两个支持条件不同的插件 harness。参考验收：过滤不支持者，按优先级/id 选择；全部不可用时回内建 OpenClaw。

### 实验 D：显式插件失败

显式指定插件 harness，但让它失败且未声明 OpenClaw 为 lossless fallback。参考验收：fail closed 并暴露错误，不偷偷换运行时。

### 实验参考答案

1. 首个 auth profile 可轮换错误时应换凭据、保持同一 harness/会话协议；坏凭据不能被记为成功。
2. 主模型不可用时沿候选链切换，工具循环继续；只有被接受模型的有效消息进入最终 transcript。
3. auto 选择会过滤不支持的 harness，再按优先级/id 选；全部不可用时回内建 OpenClaw。
4. 显式插件 harness 失败且未声明无损 fallback 时必须 fail closed，暴露错误，不能偷偷换运行时。

## 7. 失败与恢复

| 失败 | 先查 | 恢复 |
| --- | --- | --- |
| 模型不存在 | registry/resolveModelAsync | 修 model ref/provider |
| 认证失败 | auth profile 与错误类型 | 轮换或要求重新登录 |
| 候选重复执行 | candidate/admission 幂等 | 只允许一个 accepted effect |
| 插件 harness 不兼容 | support conditions | 换 harness 或内建 fallback |
| 失败输出污染历史 | transcript commit 边界 | 只提交 accepted candidate |
| ownership 漂移 | model/auth tuple | 重新准备，不混用旧会话 |

## 8. 通关自测

1. 模型 fallback 与 harness fallback 的区别是什么？
2. 为什么“注册了 harness”不等于“auto 会选它”？
3. 同优先级如何稳定选择？
4. 显式插件 harness 失败为什么默认 fail closed？
5. 失败候选的 assistant 输出为什么不能进最终 transcript？
6. auth profile 轮换与模型 fallback 有什么区别？

### 参考答案

1. 模型 fallback 在同一执行运行时内换模型/凭据/路由，通常保持工具循环与会话协议；harness fallback 换执行运行时，可能改变协议、策略和 session 映射。
2. 还要满足 provider/model、tool policy、平台能力、explicit-only 与健康等条件。注册只说明存在，支持条件决定能否安全执行。
3. 先按优先级排序，同优先级按稳定 id 排序；不能依赖注册遍历的偶然顺序。
4. 插件 harness 的失败可能不是无损的，切换运行时可能改变工具/steering/上下文语义。除非插件明确声明 OpenClaw 是无损 fallback，否则应暴露失败。
5. 它可能是不完整、错误或被拒绝的输出。写进最终历史会让后续模型基于失败候选继续，也会破坏“只有 accepted candidate 推进会话”的边界。
6. 凭据轮换仍使用同一 provider/model 路由，只换账号/密钥；模型 fallback 换的是模型或 provider，可能改变能力、上下文窗口与输出格式。

## 9. 源码坐标

- `src/agents/embedded-agent-runner/model.ts`
- `src/agents/embedded-agent-runner/model-resolution.ts`
- `src/agents/model-fallback-candidates.ts`
- `src/agents/embedded-agent-runner/run/model-setup.ts`
- `src/agents/embedded-agent-runner/run/attempt.ts`
- `src/agents/harness/selection.ts`
- `src/agents/harness/selection-decision.ts`
- `src/agents/harness/auto-selection.ts`
- `src/agents/harness/builtin-openclaw.ts`

## 10. 下一步

进入阶段 6：模型与工具都跑完了，哪些消息、tool result、错误和摘要真正写进 transcript？谁保证一次 run 只提交一份合法历史？
