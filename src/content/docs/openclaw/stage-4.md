---
title: "阶段 4：工具审批与 Sandbox"
description: "阶段 4：工具审批与 Sandbox。沿源码主线理解事实、合同、可观察证据与失败恢复。"
---

> 课程：OpenClaw 源码课 · 阶段卷
> 前置：阶段 2～3
> 对应总览：`core-mechanisms.md` 的工具部分
> 本阶段目标：分清工具装配、调用策略、人工审批与隔离执行四层，掌握 before_tool_call 的顺序。

## 1. 本阶段解决什么

模型提出 tool call 只表示“想做什么”，不表示“允许做什么”。OpenClaw 要回答：

- 这个工具在当前 agent/session/channel 下是否装配；
- 参数是否符合策略，是否需要人工确认；
- 普通 hook 能否改参数，审批看的是原始还是改后调用；
- 多个工具并行时谁负责批次一致性；
- 真正执行在 host、sandbox、容器还是远端；
- 被拒绝/跳过时怎样生成成对 tool result。

## 2. 先记住一个判断

**Policy 决定“规则允许吗”，Approval 决定“这个调用现在放行吗”，Sandbox 决定“放行后在哪个隔离边界执行”。**

三者不能互相替代。审批通过不代表沙箱配置安全；沙箱存在也不代表工具应被允许。

## 3. 源码主线

1. `agent-tools.ts` 按 agent、session、channel、capability/profile 装配工具目录。
2. `before_tool_call.policy.ts` 执行 loop admission、owner probes、voice confirmation、trusted policies。
3. `before_tool_call.approval.ts` 处理 approvals 与 final owner approval。
4. 普通 hooks 在审批之后运行，不能先把参数“洗过”再给审批看。
5. `before_tool_call.decision.ts` 把 deny/defer/report/request 等结果转成统一决策。
6. `agent-loop.ts::executeToolCallGroups()` 应用批次级串行、并行、steering 跳过与结果配对。
7. `src/agents/sandbox/` 通过 backend、workspace authority、mount plan、env sanitize、security validation 选择执行边界。

## 4. 关键对象与合同

### `before_tool_call` 的顺序

```text
loop admission
  → owner probes
  → voice confirmation
  → trusted policies
  → approvals
  → normal hooks
  → final owner approval
```

这个顺序不能换：审批必须在普通 hook 前，最终 owner approval 又必须在 hook 后独立确认。

### 四种决策语义

| 决策 | 含义 | 结果 |
| --- | --- | --- |
| `deny` | 明确拒绝 | 生成拒绝 result，不执行 |
| `defer` | 推迟到执行边界 | 由后续 owner/上下文决定 |
| `report` | 只报告，不阻断 | 继续执行，留下观察 |
| `request` | 立即请求人工审批 | 等待 approval owner |
| skipped | 因 steering/终止未启动 | 生成配对 synthetic result |

### Sandbox 层

| 层 | 回答 |
| --- | --- |
| backend | Docker/Podman/SSH/remote-shell/local 哪类执行器 |
| workspace authority | 哪个 workspace 可挂载/读写 |
| mount plan | 哪些路径只读/读写/隐藏 |
| env sanitize | 哪些秘密可进入子进程 |
| security validation | 配置是否允许启动 |
| lifecycle | 容器创建、复用、清理与失败回收 |

## 5. 一条可观察链路

```text
model tool call
  → tool lookup / profile
  → before_tool_call chain
  → decision
  → sandbox/backend selection
  → execute
  → tool result
  → transcript
```

被拒绝也要走“结果”路径；否则 transcript 会出现孤立 tool call，后续模型无法继续。

## 6. 实验

### 实验 A：审批前改参数

构造一个普通 hook 修改工具参数。参考验收：审批看到原始调用；hook 后的最终 owner approval 再检查修改结果。顺序颠倒即失败。

### 实验 B：比较 deny/defer/report

分别返回三种决策。参考验收：deny 不执行，defer 留到边界，report 继续但有观察记录；三者都能生成明确结果。

### 实验 C：steering 跳过

在批次中注入 steering，让部分调用未启动。参考验收：未启动调用生成 skipped/error result，已启动工具完成，不出现孤立 call。

### 实验 D：Sandbox 越界

让工具访问 workspace 外路径或读取未允许秘密。参考验收：mount/authority/env 层在启动前拒绝，错误可审计，不依赖工具自己检查。

### 实验参考答案

1. 审批必须看到原始调用；hook 若修改参数，最终 owner approval 还要检查修改后的结果。先审批后改参数会失效。
2. deny 不执行；defer 留到明确边界；report 继续但留下观察记录。三者都应生成可解释结果。
3. 已启动调用完成，未启动调用生成 skipped/error result；批次必须保持配对。
4. 越界路径、mount 权限和秘密环境应在启动前由 authority/mount/env 层拒绝并审计，不能依赖工具自觉检查。

## 7. 失败与恢复

| 失败 | 根因 | 恢复 |
| --- | --- | --- |
| 工具未装配 | profile/capability 不匹配 | 修装配，不伪造调用 |
| 审批看到改后参数 | hook 顺序错误 | 恢复审批在 hook 前 |
| 拒绝后无 result | 没走统一结果路径 | 补配对的拒绝结果 |
| 批次并发冲突 | 忽略 sequential/预算 | 批次层串行/拒绝 |
| 沙箱配置不安全 | mount/env/backend 校验缺失 | 启动前 fail closed |
| 容器残留 | lifecycle/清理失败 | 记录并回收，不重复创建 |

## 8. 通关自测

1. 工具装配、policy、approval、sandbox 各回答什么？
2. 为什么 approval 必须在 normal hooks 前？
3. final owner approval 与普通 hook 有什么区别？
4. deny、defer、report、request 分别意味着什么？
5. 工具被 steering 跳过时为什么还要生成 result？
6. 审批通过后为什么仍需要 sandbox？

### 参考答案

1. 装配决定工具是否存在；policy 决定规则是否允许；approval 决定当前调用是否获人工/owner 放行；sandbox 决定执行隔离与路径/秘密边界。
2. 否则 hook 可以先修改参数或补造上下文，让审批看到“洗过”的调用。审批必须针对原始调用，hook 后的最终 owner approval 再独立检查。
3. 普通 hook 是扩展逻辑，不是权限所有者；final owner approval 是最后的独立放行点，必须在 hook 之后确认，不能被 hook 替代。
4. deny 直接拒绝；defer 推迟到执行边界；report 只记录不阻断；request 立即请求人工审批。skipped 则是因 steering/终止未启动。
5. tool call 与 result 必须成对。缺少跳过结果会让 transcript 协议不合法，模型无法正确理解哪些调用未执行。
6. 审批回答“是否允许”，不保证工具本身安全或参数不会越界。sandbox 继续限制 workspace、路径、环境和进程，防止已批准工具造成过大副作用。

## 9. 源码坐标

- `src/agents/agent-tools.ts`
- `src/agents/agent-tools.before-tool-call.policy.ts`
- `src/agents/agent-tools.before-tool-call.approval.ts`
- `src/agents/agent-tools.before-tool-call.decision.ts`
- `packages/agent-core/src/agent-loop.ts`
- `src/agents/sandbox/backend.ts`
- `src/agents/sandbox/workspace-authority.ts`
- `src/agents/sandbox/validate-sandbox-security.ts`
- `src/agents/sandbox/sanitize-env-vars.ts`

## 10. 下一步

进入阶段 5：工具在某个 harness/model 下执行。模型解析、认证、fallback 与 harness 选择怎样避免把一次 run 跑成两套语义？
