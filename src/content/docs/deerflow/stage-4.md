---
title: "阶段 4：工具与 Sandbox"
description: "阶段 4：工具与 Sandbox。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：DeerFlow 源码课 · 阶段卷
> 前置：阶段 2、3
> 对应总览：`core-mechanisms.md` 的工具与沙箱部分
> 本阶段目标：从一次 tool call 追到 middleware、sandbox lease、执行结果和 receipt。

## 1. 本阶段解决什么

工具不是“模型生成的字符串直接交给 shell”。完整链路是：

~~~text
AIMessage(tool_calls)
  → tool 可见性/策略
  → 参数校验
  → 审批/读前写保护/预算
  → sandbox lease
  → 执行与输出截断
  → ToolMessage + receipt
  → 下一轮模型
~~~

DeerFlow 把“工具接口”“执行环境”“行为约束”和“结果证据”拆开，以免任意一个模型参数变成宿主权限。

## 2. 先记住一个判断

**工具是受控能力，不是宿主函数的薄包装。**

模型只能提出调用；是否可见、是否允许、在哪里执行、结果给多少、失败如何回填，都由服务端决定。

## 3. 源码主线

1. 工具集合由 `tools/tools.py`、builtins、sandbox tools、memory tools、MCP/skill 工具等装配。
2. `agents/middlewares/` 中的 `ReadBeforeWriteMiddleware`、`ToolOutputBudgetMiddleware`、`ToolReceiptMiddleware`、`DanglingToolCallMiddleware` 等约束调用与结果。
3. `sandbox/tools.py` 提供 `bash_tool`、`read_file_tool`、`write_file_tool` 等适配层。
4. `sandbox/sandbox.py::Sandbox` 定义执行、文件、路径解析等抽象合同。
5. `sandbox/sandbox_provider.py` 选择 provider；`local/local_sandbox_provider.py` 展示 per-thread 路径映射。
6. `sandbox/lease.py::SandboxLeaseManager` 管并发使用、获取与释放；`security.py` 和 `path_patterns.py` 处理越界。
7. 结果经过截断、清洗、配平和 receipt 记录后，才回到模型。

## 4. 关键对象与合同

| 对象 | 作用 | 不能做什么 |
| --- | --- | --- |
| `Sandbox` | 隔离执行合同 | 直接暴露宿主 root |
| `SandboxProvider` | 创建/查找沙箱 | 绕过 lease |
| `SandboxLeaseManager` | 并发和生命周期 | 把 lease 当永久所有权 |
| `ReadBeforeWriteMiddleware` | 防止盲写 | 代替路径安全校验 |
| `ToolOutputBudgetMiddleware` | 限制上下文污染 | 删除原始证据 |
| `ToolReceiptMiddleware` | 记录调用事实 | 证明外部副作用一定成功 |

## 5. 一条可观察链路

~~~text
tool_call
  → 可见工具表
  → 参数与策略
  → ensure_sandbox_initialized
  → acquire/lease sandbox
  → execute_command / read / write
  → truncate + sanitize
  → ToolMessage
  → journal event + receipt
~~~

观察点：`bash_tool` 只是入口，真正的 `execute_command` 由 provider 的 `Sandbox` 实现；`/mnt/user-data/...` 等虚拟路径由 provider 映射，不能当成宿主绝对路径。

## 6. 实验

### 实验 A：验证路径映射

在 local sandbox 中打印虚拟路径与真实路径映射。参考验收：同一虚拟路径落到当前 thread 的 workspace，不落到其他用户目录。

### 实验 B：触发读前写保护

直接让模型覆盖一个未读文件，再先读后写。参考观察：前者被 middleware 拒绝或要求先读，后者通过；拒绝发生在执行前。

### 实验 C：放大工具输出

调用一个输出很大的命令。参考验收：模型侧看到有界内容，原始输出仍可由日志/receipt 或文件定位，截断是显式事实。

### 实验参考答案

1. 虚拟路径必须映射到当前 thread 的 sandbox workspace；不同 thread 不共享同一真实根目录。
2. 未读直接覆盖应在执行前被 middleware 拒绝或要求先读；先读后写才通过，说明策略发生在副作用之前。
3. 模型看到有界内容，原始输出仍可按 receipt/文件定位；截断标记不能等同于命令失败。

## 7. 失败与恢复

| 失败 | 已发生事实 | 不能重做 |
| --- | --- | --- |
| sandbox 获取失败 | 无工具副作用 | 不要在宿主重跑 |
| 命令执行超时 | 可能已有部分副作用 | 不能假设完全未执行 |
| 输出截断 | 调用已成功 | 不能把截断标记当失败 |
| lease 丢失 | 执行权不确定 | 旧执行者不得继续写 |
| receipt 写失败 | 工具可能已生效 | 不能盲目重复写操作 |

## 8. 通关自测

1. 为什么不能让模型直接调用宿主 shell？
2. provider、sandbox、lease、tool middleware 各管什么？
3. 工具输出被截断后，如何仍证明调用发生过？
4. 一个写文件工具超时后，为什么不能直接重试覆盖？

### 参考答案

1. 因为模型参数不可信。直接调用宿主 shell 会绕过隔离、路径映射、权限、资源回收和审计，还可能把一个对话错误升级为宿主机破坏。
2. provider 负责创建/管理沙箱；sandbox 定义执行与文件合同；lease 管并发使用权和释放；middleware 管可见性、策略、审批、预算、配对与证据。
3. 通过 `ToolReceiptMiddleware`、journal 事件、截断标记和产物路径形成事实链。截断只说明给模型的内容有界，不等于调用失败。
4. 超时可能发生在写入前、写入中或写入后。直接重试可能重复追加、覆盖新内容或制造不一致；应先 readback/检查幂等键，再决定补写还是报错。

## 9. 源码坐标

- `backend/packages/harness/deerflow/tools/`
- `backend/packages/harness/deerflow/sandbox/tools.py`
- `backend/packages/harness/deerflow/sandbox/sandbox.py`
- `backend/packages/harness/deerflow/sandbox/lease.py`
- `backend/packages/harness/deerflow/sandbox/local/local_sandbox_provider.py`
- `backend/packages/harness/deerflow/agents/middlewares/read_before_write_middleware.py`
- `backend/packages/harness/deerflow/agents/middlewares/tool_output_budget_middleware.py`

## 10. 下一步

进入阶段 5：工具和上下文都有了，模型实例本身如何从配置与 provider 适配中产生？
