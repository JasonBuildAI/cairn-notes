---
title: "阶段 5：模型接入与 Provider 适配"
description: "阶段 5：模型接入与 Provider 适配。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 2、3
> 对应总览：`core-mechanisms.md` 的模型部分
> 本阶段目标：解释“允许用哪个模型”和“如何构造这个模型”为什么是两层责任。

## 1. 本阶段解决什么

模型接入不是简单写死一个 API key：

~~~text
配置白名单
  → 请求/Agent/全局默认的模型名解析
  → model:use 授权
  → provider 与 credential 选择
  → thinking / reasoning / settings 合并
  → provider 适配器
  → BaseChatModel
~~~

DeerFlow 把授权放在接单/装配阶段，把具体协议差异放在 provider 层，避免每个路由各自判断模型安全。

## 2. 先记住一个判断

**模型名是配置键，也是权限边界；不是客户端任意字符串。**

`start_run()` 先检查白名单，`assemble_lead_agent()` 再解析最终模型与授权，`create_chat_model()` 才构造实例。三者顺序不能倒。

## 3. 源码主线

1. `config/model_config.py` 定义模型配置、provider、能力与默认值。
2. `services.start_run` 对请求中的 `context.model_name` 做白名单检查。
3. `lead_agent/agent.py::_resolve_model_name` 依请求 → Agent 配置 → 全局默认解析。
4. `_authorize_model_name` 执行模型使用授权；拒绝时可降级到允许模型。
5. `models/factory.py::create_chat_model` 读取 provider 类、凭据、base URL、模型设置和追踪。
6. 适配器位于 `claude_provider.py`、`openai_codex_provider.py`、`vllm_provider.py`、`mindie_provider.py` 及 `patched_*`。
7. `credential_loader.py` 与 `request_admission.py` 处理凭据和请求准入。
8. thinking 不支持时会降级为非 thinking，而不是把无效参数发给 provider。

## 4. 关键对象与合同

| 层 | 决定什么 | 失败方式 |
| --- | --- | --- |
| start_run 白名单 | 这个 model 名是否存在于配置 | 400，不创建 Run |
| model:use 授权 | 当前调用者能否使用 | 拒绝或降级 |
| `_resolve_model_name` | 请求/Agent/全局优先级 | 未知名回退或报错 |
| `create_chat_model` | provider 类与参数形状 | 构造失败，Run 失败 |
| provider adapter | 协议、流、tool calling、reasoning | 记录并交由运行层重试/分类 |
| credential loader | 密钥来源与隔离 | 不把密钥写进 checkpoint |

## 5. 一条可观察链路

~~~text
request.model_name
  → app_config.get_model_config
  → resolve（request > agent > default）
  → authorize model:use
  → create_chat_model
  → provider class
  → request / stream
  → usage + tracing
~~~

观察点：客户端只能表达“偏好”，不能传入 provider 私钥、任意 base URL 或未配置模型。运行期配置被写入 checkpoint 时也必须清洗内部键。

## 6. 实验

### 实验 A：非法模型名

请求一个配置中不存在的模型。参考验收：在 `start_run` 阶段被拒绝，不产生 pending Run、不调用 provider。

### 实验 B：thinking 降级

选一个 `supports_thinking=false` 的模型并开启 thinking。参考观察：装配日志显示降级，请求不携带无效思考参数，Run 继续执行。

### 实验 C：比较两个 provider

用同一工具调用任务分别跑 OpenAI 兼容适配器与 Claude 适配器。参考观察：图的工具轮次相同，差异集中在消息转换、流事件、usage 和错误形状。

### 实验参考答案

1. 非法模型应在 `start_run` 的配置/白名单校验阶段被拒，不产生 pending Run，也不应调用 provider。
2. 不支持 thinking 的模型应在装配层降级，请求不携带无效参数；这是能力适配，不是让 provider 自行忽略。
3. 两种适配器应共享同一工具轮次语义，差异集中在消息转换、流事件、usage 与错误形状；若循环本身分叉，说明适配层侵入过深。

## 7. 失败与恢复

| 失败 | 责任层 | 恢复 |
| --- | --- | --- |
| 401/403 | credential/provider | 轮换或终止，不伪装成功 |
| 429 | 运行层 | 有界退避/重试 |
| 参数不支持 | 适配器 | 归一化或降级 |
| 上下文超窗 | 上下文/preflight | 重新测量并压缩 |
| 流中断 | worker/provider | 根据已收内容与幂等边界恢复 |

## 8. 通关自测

1. 模型白名单与 `create_chat_model` 分别防什么？
2. 为什么配置不能原样写入 checkpoint？
3. thinking 与 reasoning effort 为什么要在装配阶段归一化？
4. provider 适配器应不应该决定 Run 最终状态？

### 参考答案

1. 白名单防客户端把任意模型名变成出网、计费和凭据选择权限；`create_chat_model` 负责按已授权配置构造正确协议实例，不承担接单权限。
2. 配置可能包含 API key、base URL、内部 token 和宿主策略。checkpoint 可被恢复/读取/复制，写入秘密会扩大泄露面；必须清洗内部键并使用安全引用。
3. 不同 provider 对 thinking、reasoning 字段的支持不同。先解析并校验能力，再构造请求，能避免无效参数、隐式计费和上下文行为不一致。
4. 不应该。适配器负责协议转换与错误暴露；Run 状态、重试边界、交付和终态由 worker/manager 决定。

## 9. 源码坐标

- `backend/packages/harness/deerflow/models/factory.py`
- `backend/packages/harness/deerflow/models/credential_loader.py`
- `backend/packages/harness/deerflow/models/request_admission.py`
- `backend/packages/harness/deerflow/config/model_config.py`
- `backend/app/gateway/services.py::start_run`
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py`

## 10. 下一步

进入阶段 6：模型调用了、工具也执行了，怎样把过程写成可恢复、可审计的事实？
