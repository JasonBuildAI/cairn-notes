---
title: "选修区：按需深入"
description: "Code Interpreter、浏览器、存储挂载、K8s 与评测等延伸路线。"
---

> 这份导读不是“进阶必读清单”，而是一张**问题地图**：当你遇到主线没覆盖的场景时，知道该读哪一篇、补哪个前置阶段、做出什么最小验证。

## 先明确：什么算“选修”

主线（阶段 0–9）回答的是“一次沙箱任务的一生”。凡是下面三类内容，都放在选修区：

```text
1. 特定形态：代码解释器、浏览器、桌面、Windows 沙箱
2. 特定平台：Kubernetes/FastSandbox、AKS + Kata、节点代理
3. 特定生态：Agent 框架、编码 CLI、评测工具、客户端池
```

它们不是“更难”，而是“更窄”。**没有主线的前置，直接读选修会得到一堆命令，却不知道失败时该看哪一层。**

## 怎么读选修：三步法

```text
第 1 步：写清问题
        “我要在沙箱里跑 Jupyter”“我要挂载已有数据盘”
        而不是“我想看看这个示例”

第 2 步：做最小实验
        只保留示例里能证明该能力的那几步
        删掉与问题无关的模型调用、UI、部署

第 3 步：记录边界
        什么条件下能用？失败时是什么形态？密钥/网络/清理怎么处理？
```

一份合格的选修笔记，至少包含：**前置条件、最小命令、预期结果、失败形态、与主线的衔接点。**

## 支线 1 · 执行与交互

| 想解决的问题 | 读什么 | 前置 | 产出 |
| --- | --- | --- | --- |
| 在沙箱里跑代码单元、保留内核状态 | `docs/examples/code-interpreter.md`、`docs/sdks/` | 阶段 3 | 一个能连续执行两个 cell 并共享变量的脚本 |
| 需要交互式终端 | execd 的 PTY 接口（`/pty`） | 阶段 3 | 一个能创建/读写/关闭 PTY 的最小客户端 |
| 多步骤隔离执行 | `docs/guides/isolation-sessions.md` | 阶段 3、5 | 一份“会话生命周期 + 清理”的记录 |
| 需要保持 shell 状态 | execd `/session` | 阶段 3 | 对比“新命令”和“同会话”的行为差异 |

### Code Interpreter 的边界

它是**独立 SDK 包**（Python / JavaScript / C#），不是 `Sandbox` 的一个方法：

- 必须包装一个已存在的 `Sandbox`。
- 镜像要带 Jupyter 运行时，普通 `python:3.12` 不够。
- 默认健康检查会同时验证 execd 和 Jupyter，二者都就绪才返回。
- `.aclose()` 只释放解释器客户端，**不销毁沙箱**。

这四条任何一条不满足，都会表现成“创建成功但执行失败”。先查镜像，再查健康检查，最后查生命周期。

### PTY 的现状

PTY 在 execd API 层存在（`POST/GET/DELETE /pty`、`/pty/{id}/ws`），但它不在公开的 execd spec 里，Python SDK 也没有暴露。这意味着：

- 你可以按 API 直接调用，但要自己处理 WebSocket。
- 不要把它写进“SDK 已支持”的文档。
- 版本升级时要重新验证接口形状。

## 支线 2 · 界面与桌面

| 想解决的问题 | 读什么 | 前置 | 产出 |
| --- | --- | --- | --- |
| 让 Agent 操作网页 | `docs/examples/playwright.md`、`chrome.md` | 阶段 3、5 | 一次“打开页面→截图→断言”的闭环 |
| 需要完整桌面 | `docs/examples/desktop.md` | 阶段 3、5 | 一张桌面截图 + 端口暴露说明 |
| 在沙箱里跑 IDE | `docs/examples/vscode.md` | 阶段 2、5 | 一个可访问的 IDE 端点 |
| Windows 沙箱 | `docs/guides/windows-sandbox.md`、`docs/examples/windows.md` | 阶段 4 | 一份 Windows 镜像/运行时条件记录 |

### 这条支线的共同难点

```text
1. 镜像大、启动慢      -> TTL 与就绪等待要重新估
2. 端口多              -> 端点解析不能只记一个端口
3. 图形/浏览器依赖重    -> 资源限制不能照抄 python:3.12
4. 入站访问复杂        -> 必须走 gateway/代理，不能假设直连
```

浏览器与桌面场景还多一层安全问题：**页面内容是不可信输入**。阶段 7 的注入防线在这里同样适用，而且更重要——浏览器会把外部内容直接带进执行环境。

## 支线 3 · 存储与数据

| 想解决的问题 | 读什么 | 前置 | 产出 |
| --- | --- | --- | --- |
| 挂载宿主机目录 | `docs/examples/host-volume-mount.md` | 阶段 4 | 一份“读写权限 + 清理”的记录 |
| Docker 下用 PVC/对象存储 | `docs/examples/docker-pvc-volume-mount.md`、`docs/examples/docker-ossfs-volume-mount.md` | 阶段 4 | 挂载成功 + 失败形态 |
| Kubernetes 下用 PVC | `kubernetes-pvc-volume-mount.md` | 阶段 4 | Pod 挂载与回收验证 |
| 与远端存储同步 | `rclone-volume-mount.md` | 阶段 4、5 | 一次同步 + 凭据处理说明 |

### 三条必须回答的问题

1. **快照覆盖它吗？** 答案取决于卷类型；不要用“文件还在”推断“快照包含它”。
2. **Pool 模式能用吗？** Pool Pod 预创建，卷必须随模板固定，不能按请求注入。
3. **清理谁负责？** 挂载的数据通常比沙箱寿命长，销毁沙箱不等于删除数据。

这三条答不上来，就不要在生产开挂载。

## 支线 4 · 平台与运维

| 想解决的问题 | 读什么 | 前置 | 产出 |
| --- | --- | --- | --- |
| 在 Kubernetes 上部署 | `docs/deployment/index.md` | 阶段 4 | 一张组件/端口/命名空间图 |
| 用 FastSandbox 降低创建延迟 | `docs/architecture/fast-sandbox/` | 阶段 4 | 模板构建 + 创建的时间线 |
| 在 AKS 上用 Kata | `docs/examples/aks-kata.md` | 阶段 4、8 | RuntimeClass 验证记录 |
| 节点侧能力 | `docs/guides/node-agent.md` | 阶段 4 | node-agent 的职责边界 |
| Pod 供给失败恢复 | `docs/guides/pod-recovery.md` | 阶段 4、8 | 坏镜像/调度失败的恢复行为 |
| 暂停恢复性能 | `docs/guides/kubernetes-resume-benchmark.md` | 阶段 4 | 一组恢复耗时数据 |
| QEMU VMState 快照 | `docs/guides/qemu-vmstate-snapshots.md` | 阶段 4 | “保留内存”的条件与限制 |
| 多租户 | `docs/guides/multi-tenancy.md` | 阶段 8 | 租户/命名空间/配额表 |
| 遥测 | `docs/guides/telemetry.md` | 阶段 8 | 指标与 trace 清单 |

### FastSandbox 的读法

不要从组件列表开始读。先回答三个问题：

```text
1. 我的工作负载形状是否固定？（固定才适合模板）
2. 我的瓶颈是创建延迟，还是镜像大小/网络？
3. 我能否接受模板不可变、无 sandbox 侧 Vault？
```

三个都答“是/能”，再读模板构建和 FastPath 路由；否则先优化镜像和 Pool。

### 暂停恢复的两个陷阱

- **rootfs 快照不保留内存**：恢复后进程重启，变量丢失。
- **恢复会创建新 ID**：不要拿旧 ID 轮询，也不要把旧端点缓存当有效。

## 支线 5 · 生态与评测

| 想解决的问题 | 读什么 | 前置 | 产出 |
| --- | --- | --- | --- |
| 用 ADK 做工具式 Agent | `docs/examples/google-adk.md` | 阶段 7 | 三个工具的最小闭环 |
| 用 LangGraph 编排 | `docs/examples/langgraph.md` | 阶段 7 | 图 + 停止条件 |
| 用 Microsoft Agent Framework | `docs/examples/microsoft-agent-framework.md` | 阶段 7 | 工具注册与调用记录 |
| 多 Agent / 深度任务 | `docs/examples/deep-agents.md`、`docs/examples/deer-flow.md` | 阶段 7 | 任务分解与预算 |
| 把编码 CLI 关进沙箱 | `docs/examples/codex-cli.md`、`docs/examples/claude-code.md`、`docs/examples/gemini-cli.md`、`docs/examples/opencode.md`、`docs/examples/qwen-code.md`、`docs/examples/kimi-cli.md`、`docs/examples/github-copilot-cli-sandbox.md` | 阶段 7 | 密钥/网络/清理三件事的记录 |
| 批量评测 | `harbor-evaluation.md` | 阶段 7、8 | 一次可复现的评测运行 |
| 应用补丁 | `apply-patch.md` | 阶段 3、7 | patch 应用与失败回滚 |
| 客户端连接池 | `docs/examples/client-pool-schedule.md`、`docs/guides/client-pool.md` | 阶段 2、8 | 池化后的延迟与清理数据 |

### 读一个 Agent 示例，固定看六件事

```text
1. 拓扑：Agent 在外面还是在沙箱里？
2. 密钥：模型密钥和数据密钥分别在哪？
3. 网络：沙箱允许访问哪些目标？
4. 工具：暴露了哪些能力，返回什么结构？
5. 预算：有没有步数/时间/输出上限？
6. 清理：谁负责销毁，异常路径覆盖了吗？
```

六个问题里有两个答不上来，这个示例就只能当“演示”，不能当“参考实现”。

## 三条角色路线

### 应用开发者

```text
阶段 0–3 → 阶段 6（SDK/CLI） → 选修 1（Code Interpreter / 会话）
```

目标：能把沙箱嵌进现有应用，知道失败时查哪一层。

### Agent 工程师

```text
阶段 0–7 → 阶段 8（预算/可观测） → 选修 5（框架与 CLI）
```

目标：能设计工具契约、控制成本、处理注入与重试。

### 平台/运维

```text
阶段 1、2、4、5 → 阶段 8 → 选修 4（K8s/FastSandbox/多租户/遥测）
```

目标：能部署、扩容、排障、回滚，并能解释每个能力的条件。

## 选修与主线的衔接

```text
主线阶段 3（执行）
   ├─ 选修 1：Code Interpreter / PTY / 会话
   └─ 选修 2：浏览器 / 桌面 / IDE

主线阶段 4（运行时）
   ├─ 选修 3：存储挂载
   └─ 选修 4：K8s / FastSandbox / AKS / 快照

主线阶段 5（网络与凭据）
   └─ 选修 2、4：入站暴露、Vault 验收、上游代理

主线阶段 7（Agent）
   └─ 选修 5：框架、编码 CLI、评测

主线阶段 8（工程）
   └─ 选修 4、5：多租户、遥测、连接池
```

## 常见误区

| 误区 | 纠正 |
| --- | --- |
| “选修是进阶，应该先学” | 选修更窄，缺主线前置会变成照抄命令 |
| “示例能跑就等于能力可用” | 示例通常省略配额、清理、失败路径 |
| “Code Interpreter 就是 Sandbox 加个方法” | 它是独立包，需要 Jupyter 镜像和额外健康检查 |
| “PTY 在 SDK 里有” | API 层有，公开 spec/SDK 未必有，使用前先确认 |
| “挂载了数据就等于快照包含它” | 取决于卷类型，rootfs 快照不覆盖所有存储 |
| “模板沙箱和普通沙箱能力一样” | 模板不可变，且没有沙箱侧 Vault |
| “编码 CLI 放进沙箱就安全了” | 密钥、出站、清理仍要单独设计 |

## 做完之后

选修区的正确用法，是**带着一个具体问题进去，带着一份边界记录出来**。

如果你已经完成毕业设计，建议按这个顺序继续：

1. 选一个与你工作最接近的支线，做一次最小实验。
2. 把实验中发现的“文档没写清的条件”记下来。
3. 回到主线对应阶段，用那里的框架重新解释一遍。
4. 如果发现有价值，整理成示例或文档改进，按社区流程提交。

这时你不再只是“学完了一门课”，而是能对这套系统提出有依据的改进了。
