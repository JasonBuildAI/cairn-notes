---
title: "阶段 4：Capability、Provider 与 Host"
description: "阶段 4：Capability、Provider 与 Host。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：LoopX 源码课 · 阶段卷
> 前置：阶段 3，理解 Turn Envelope 与七阶段事务
> 对应总览：`core-mechanisms.md` 的工具与扩展部分
> 本阶段目标：分清“领域规则”“外部实现”“候选执行者”三种责任。

## 1. 本阶段解决什么

Turn 计划建立后，下一步是把工作交给 Host。但 Host 只是执行者，不是事实裁判。LoopX 用三层分工避免“模型说完成就算完成”：

- Capability 定义这个领域什么叫成功、需要什么证据、失败怎样分类；
- Provider 声明能否提供某项实现，并执行有类型的 effect/readback；
- Host 接收有界请求，产出候选 typed result。

同一个模型可以换 Host，同一种 Capability 也可以有多个 Provider。内核只认合同，不认某个模型品牌。

## 2. 先记住一个判断

**Host 产出的是候选结果，Capability 定义验收语义，Provider 提供受控实现。**

三者不能互相替代。Host 不可以直接写 canonical state；Provider 不可以绕过 validation 和 settlement；Capability 也不应该偷偷执行未声明的副作用。

## 3. 源码主线

1. `capabilities/registry.py` 注册 Provider、Capability 与 implementation，并校验生命周期顺序。
2. `capabilities/catalog.py::get_capability()` 从目录解析当前可用的领域合同。
3. `control_plane/capability_hooks.py::project_turn_context()` 把能力要求投影进本轮上下文。
4. `turn_driver/executor.py::build_loopx_turn_host_request()` 生成 Host 请求，声明本轮只允许完成前两阶段。
5. `validate_loopx_turn_host_result()` 检查 result kind、evidence、path delta、completed phases 和 completion lifecycle。
6. `run_loopx_turn_once()` 把 Host 执行、验证、写回、消费与调度串起来。

## 4. 关键对象与合同

### Provider 的四层生命周期

| 状态 | 含义 | 合法变化 |
| --- | --- | --- |
| `declared` | 目录知道它会提供某项能力 | 先声明，才可安装 |
| `installed` | 本机已安装实现 | 不能“已安装但未声明” |
| `enabled` | 当前策略允许使用 | 不能“已启用但未安装” |
| `ready` | 健康检查与依赖满足 | 不能“已就绪但未启用” |

四层不是四个同义词。`enabled` 只说明策略开启，`ready` 才说明当前能安全调用。

### Capability 与 Host 的合同

| 合同 | 必须表达 | 不允许 |
| --- | --- | --- |
| 成功条件 | 哪些可观察事实证明完成 | 以自然语言“我觉得好了”替代 |
| 证据要求 | 证据类型、scope、可 public-safe 的内容 | 把私有路径或秘密塞进证据 |
| 错误分类 | validation、host、writeback、spend 等类型 | 所有异常都归为“失败了” |
| typed transition | progress/completion/repair/replan 的合法迁移 | 跳过 repair 直接宣布完成 |
| Host request | route、Todo、gate、输出 schema、resume 条件 | 让 Host 自己扩大 scope |
| Host result | 候选结果、证据、完成阶段、lifecycle 意图 | 让 Host 声称已写回或已消费 |

### Host 结果的硬约束

- `completed_phases` 只能是 `host_execute` 与 `typed_result`，不能声称 validation、writeback 或 spend 已完成。
- `validated_completion` 必须带 lifecycle adapter、后继/active goal 或 `no_followup` 的完整意图。
- 非 material result 不能夹带 evidence、path delta 或 progress observation，避免“说等待但偷偷推进”。
- Host result 有 `HOST_RESULT_MAX_BYTES = 12_000` 的读取上限，超大输出不能直接变成事实。
- 结果必须绑定同一个 `turn_key` 与 `effect_ref`，不能把另一轮的 receipt 拼进来。

## 5. 一条可观察链路

```text
Capability record
  → required provider / evidence / transition
  → provider lifecycle: declared → installed → enabled → ready
  → project_turn_context
  → host request（scope + schema + completed_phases[:2]）
  → host execution
  → candidate result
  → validate_loopx_turn_host_result
  → validation phase
```

调试时先看 Provider 是卡在 installed、enabled 还是 ready，再看 Host 是否越权声称后续阶段。两者不要混成一个“工具不可用”。

## 6. 实验

### 实验 A：破坏生命周期顺序

构造 `enabled=true, installed=false` 的 Provider。参考验收：registry 明确拒绝注册，而不是让 Host 运行到一半才发现。再验证 `installed=true, declared=false` 同样被拒。

### 实验 B：观察 Host 请求边界

打印 `build_loopx_turn_host_request(plan)`。参考验收：请求只允许 Host 完成前两阶段，并携带 scope、输出 schema、证据要求和停止条件；不包含内核私有状态写入口。

### 实验 C：伪造完成结果

提交 `validated_completion`，但不给 lifecycle adapter 或后继意图。参考验收：validation 失败并指出缺少 lifecycle/后继字段；不得降级成 silently successful progress。

### 实验 D：验证结果大小

让 Host 返回超过 12,000 字节的输出。参考验收：读取阶段明确报错/截断为可诊断失败，而不是把半截 JSON 当完整结果。

### 实验参考答案

1. `enabled=true, installed=false` 与 `installed=true, declared=false` 都应在 registry 阶段被拒，不能等运行时失败。
2. Host 请求只包含前两阶段可完成的内容，以及 scope、输出 schema、证据要求、停止条件；不能携带内核私有写入口。
3. 带 `validated_completion` 却缺 lifecycle adapter 或后继意图时应 validation 失败，不能降级成 progress 或静默成功。
4. 超过 12,000 字节的输出应明确报错或形成可诊断失败，不能把半截 JSON 当完整 typed result。

## 7. 失败与恢复

| 失败 | 事实归属 | 恢复 |
| --- | --- | --- |
| Provider 未安装 | 注册表与安装状态 | 安装并重新探测，禁用跳过 |
| Provider 未 ready | 健康检查/依赖 | 修复依赖，走 capability gate |
| Host 越权声明阶段 | Host result 与计划 | validation 拒绝，保留 journal |
| completion 无 lifecycle | typed result | 改为合法 progress 或补齐后继合同 |
| 非 material 却带证据 | result schema | 拒绝夹带，重出 typed result |
| Host 输出过大 | executor 边界 | 让 Host 缩小输出或保存引用 |
| Provider 调用后崩溃 | effect/readback receipt | 先读回，禁止盲目重复副作用 |

## 8. 通关自测

1. Capability、Provider、Host 各自负责什么？
2. 为什么 Provider 要分 declared/installed/enabled/ready？
3. Host 为什么不能把 `completed_phases` 写成七阶段全完成？
4. `validated_completion` 为什么必须有 lifecycle adapter？
5. 非 material 结果为什么不能夹带 evidence？
6. Provider 已执行但进程崩溃时，为什么不能直接重试？

### 参考答案

1. Capability 定义领域成功条件、证据、错误分类和 typed transition；Provider 提供生命周期管理、受控 effect 与 readback；Host 用模型和工具执行一次有界工作，只产出候选结果。
2. 四个状态回答不同问题：是否被目录知道、是否已安装、是否被策略启用、当前是否健康可用。合并后会把“声明了”误当“能运行”，或在依赖未就绪时执行。
3. Host 只能证明自己执行并产出了 typed result。验证、写回、配额消费和调度必须由内核按顺序提交；让 Host 自称完成会绕过证据、幂等和恢复边界。
4. completion 会关闭生命周期或安排后继，必须知道由谁接续、active goal 如何变化或是否 `no_followup`。没有 adapter 的 completion 无法安全落账，应拒绝而不是猜测。
5. material 字段会参与证据校验、路径变化和进展写回。等待或失败结果若夹带这些字段，后续可能被误当成推进；合同要求按 result kind 保持纯净。
6. 外部 effect 可能已经发生，但 receipt 尚未提交。直接重试可能重复写文件、发消息或消费资源；必须先通过 readback/journal 判断 effect 是否存在，再走幂等恢复。

## 9. 源码坐标

- `loopx/capabilities/registry.py`
- `loopx/capabilities/catalog.py`
- `loopx/control_plane/capability_hooks.py`
- `loopx/control_plane/turn_driver/executor.py`
- `loopx/control_plane/turn_driver/host_candidate.py`
- `loopx/control_plane/turn_driver/turn_contract_generated.py`
- `loopx/control_plane/turn_driver/transaction.py`

## 10. 下一步

进入阶段 5：候选结果已经产出，但“证据是否够、何时写回、何时消费、scheduler 怎样 apply/ack”还没有解决。下一阶段专门拆结算。
