---
title: "阶段 4：运行时与隔离"
description: "Docker、Kubernetes、FastSandbox：同一份契约的三种落脚点。"
---

> 本阶段回答：同一个创建请求，凭什么能在 Docker 容器、Kubernetes Pod 和 FastSandbox 微虚拟机上跑出“差不多”的行为？哪些差异是设计，哪些差异是当前后端的条件？
> 预计 4–5 天。核心产出是一张**能力矩阵**、一棵**选择决策树**，以及一份能解释“为什么暂停后内存没了”“为什么 Pool 会返回 429”“为什么 gVisor 不能配 egress”的说明。

## 为什么需要这一步

阶段 3 结束时，你已经能把“执行”看成一条稳定的链路：客户端 → execd → 进程 → 输出。那条链路之所以稳定，是因为 execd 的契约不关心自己跑在什么里面。

但只要往下看一层，问题立刻出现：

```text
同一段 Python 代码
  -> 在开发机上创建，100 毫秒起容器，pause 后内存还在
  -> 在 Kubernetes 上创建，可能要等调度、拉镜像、Pool 分配
  -> 换成 FastSandbox，请求里连镜像都不能改
```

如果不知道下面这一层在做什么，你会把三种完全正常的现象当成 bug：

- “昨天还能 pause 后继续跑，今天恢复后变量全没了。”
- “Pool 明明有 Pod，为什么创建请求返回 429？”
- “文档说支持 gVisor，我配上以后网络策略怎么不生效？”
- “同一个镜像，为什么在本地是 `host` 网络，在集群里却要经过网关？”

这一阶段要建立的判断力是：**接口统一，不等于能力等价；能力等价，也不等于代价相同。**

先记住三个词的区别，后面所有内容都围绕它们展开：

| 词 | 回答的问题 | 常见误解 |
| --- | --- | --- |
| runtime（运行时） | 沙箱资源由谁创建、跑在哪 | 以为只有 Docker 和 K8s 两种“部署方式” |
| isolation（隔离等级） | 沙箱和宿主机之间的边界有多硬 | 以为换个 runtime 就自动更安全 |
| capability（能力条件） | 当前后端、配置、版本、镜像是否支持某个功能 | 以为 SDK 有这个方法就等于后端一定能做到 |

## 一个比喻：同一张订单，三种履约方式

把“创建沙箱”想成下一张订单，运行时就是履约方式：

```text
订单：一个 python:3.12 环境，跑 15 分钟，能执行命令

Docker        = 门店现做
                现点现做，看得见过程，改配方最快
                但只有这一家店，忙不过来就排队

Kubernetes    = 中央仓 + 配送
                你只写“要什么”，仓库负责找货、调度、补货
                能力最强，但链路长，出问题要逐层查

Pool          = 提前备货
                把“等制作”换成“等容量”
                 latency 降下来，成本提前支付

FastSandbox   = 预制房
                模板先建好，订单只表达“用哪套、给谁、用多久”
                 最快，但配方不能现场改
```

四种履约方式对应同一张订单格式，这正是 OpenSandbox 的设计目标：**上层 API 不随运行时改写**。但履约方式不同，可选项、失败模式和成本结构就不同。教材后面每次说“支持”，你都要追问一句：在哪个运行时、什么配置下支持？

## 步骤 1 · 先找到运行时层的位置

把阶段 1 的系统图往下补一层：

```text
SDK / CLI / MCP
  -> lifecycle server（认证、TTL、状态、错误映射）
       -> SandboxService（统一接口）
            -> DockerRuntime      （本机容器）
            -> KubernetesRuntime  （BatchSandbox / agent-sandbox）
            -> FastSandboxService （fsb- 沙箱，FastPath）
                 -> 运行面：execd + 你的进程
```

三个要点：

1. **server 不直接操纵容器或 Pod。** 它调用 `SandboxService` 的实现，把“创建/暂停/删除”翻译成后端动作。
2. **execd 契约不随运行时改变。** 变的只是“谁把 execd 跑起来、跑在哪个网络里、端点怎么解析”。
3. **FastSandbox 不是一个 `runtime.type`。** 在 `runtime.type = "kubernetes"` 下，它是一条并行的服务分支，靠请求特征路由。

配置里能选的 `runtime.type` 只有两个值：

```toml
[runtime]
type = "docker"        # 或 "kubernetes"
execd_image = "opensandbox/execd:<tag>"
execd_run_as_init = false
```

`execd_image` 是必需的：无论哪种运行时，沙箱里都要有 execd 这个“执行代理”。`execd_run_as_init = true` 会让 execd 成为容器 1 号进程（OSEP-0018），接管子进程回收和容器生命周期，同时抬高安全下限——这是一个**运行时启动方式**的选择，不是 API 能力。

### 为什么“隔离运行时”不在这张表里

初学者常把 gVisor、Kata、Firecracker 当成第四种 `runtime.type`。不是。它们是**在同一运行时内部替换隔离边界**：

```toml
[secure_runtime]
type = "gvisor"          # ""(runc) / gvisor / kata / firecracker
# docker_runtime = "runsc"
# k8s_runtime_class = "gvisor"
```

所以本阶段要同时看懂两条轴：

```text
横轴：资源在哪里（Docker / Kubernetes / FastSandbox）
纵轴：边界有多硬（runc / gVisor / Kata / Firecracker）
```

两条轴可以组合，但不是任意组合。后面步骤 7 会给出限制。

## 步骤 2 · Docker：最短路径，也是最好的观察窗口

Docker 运行时把“一个沙箱”落成“一个容器 + 端口映射 + 若干标签”。它不擅长规模，但极其适合学习：每一步都能用 `docker ps`、`docker inspect` 看见。

### 关键配置与它们的取舍

| 配置 | 默认 | 影响 |
| --- | --- | --- |
| `docker.network_mode` | `"host"` | 沙箱直接用宿主机网络，简单、无 NAT；但 egress sidecar 和 `networkPolicy` 需要 **`bridge`** |
| `docker.port_range_min/max` | `40000` / `60000` | bridge 模式下宿主机端口分配范围，至少 100 个；每个沙箱要 2–3 个端口（带 egress 时 3 个） |
| `docker.publish_host` | `"0.0.0.0"` | 端口发布到哪个地址；server 在宿主机上时可收紧到 `127.0.0.1` |
| `docker.pids_limit` | `4096` | 防止 fork 炸弹拖垮宿主机 |
| `docker.no_new_privileges` | `true` | 阻止提权 |
| `docker.drop_capabilities` | 见 `config.py` | 默认丢弃一批 Linux capabilities |
| `docker.sandbox_binds` | `[]` | 给所有沙箱统一挂载，排在请求自带挂载之前 |

这里最值得理解的是 `host` 与 `bridge` 的取舍：

```text
host   ：快、地址直观、调试方便
         但每个沙箱共享宿主机网络命名空间，出站策略无从附加

bridge ：每个沙箱独立网络命名空间，可以插入 egress sidecar
         代价是端口映射、地址改写、端口范围管理
```

所以“我在 Docker 上配了 `networkPolicy` 却被拒绝”，根因往往不是 API 写错，而是 `network_mode` 不满足条件。这类错误应该被理解为**能力条件不满足**，而不是参数校验太严。

### 生命周期在 Docker 上的样子

- 创建：起容器，等 execd 端口可用。
- TTL：服务端用标签记录绝对过期时间，并有定时器；server 重启后会从标签恢复，而不是把过期时间丢掉。
- 暂停：**冻结容器**。进程被挂起，内存还在，容器仍占资源，端口仍被占用。
- 删除：停容器、删容器、释放端口。

“暂停仍占资源”不是缺陷，而是冻结语义的必然结果。你想要“释放资源但保留文件”，那是快照路径，不是 pause 路径。

### 什么时候该用 Docker

- 本机开发、教学、单机 CI。
- 需要频繁改镜像、改挂载、看容器内部。
- 沙箱数量在单机可承受范围内，且不需要调度和池化。

代价也要说清楚：没有跨节点调度，没有 Pool，没有控制器收敛；宿主机故障就是全部故障。

## 步骤 3 · Kubernetes：把“创建”变成“收敛”

Kubernetes 运行时的核心变化不是“容器变成了 Pod”，而是**创建动作从“命令式”变成“声明式”**：

```text
server 不再说“给我起一个容器”
server 说“这里有一个 BatchSandbox，期望它这样运行”
controller 反复比较期望与实际，直到一致
```

### 创建链路

```text
1. server 校验请求（镜像/快照、资源、entrypoint、TTL）
2. server 生成 BatchSandbox CR，写入 Kubernetes API
3. controller 观察到 CR：
     - 有 poolRef -> 向 Pool 申请容量
     - 无 poolRef -> 按 template 创建 Pod
4. Pod 调度、拉镜像、启动，execd 就绪
5. controller 把 allocated / ready / conditions 写回 status
6. server 读到 Ready 与端点，返回 sandbox id 和 endpoint
```

注意第 2 步和第 6 步之间可能隔了很久。这就是为什么阶段 1 要区分三个层次：

```text
资源已接受（CR 写入成功）
  ≠ Pod 已 Ready
    ≠ execd 可访问
```

server 的等待上限由 `kubernetes.sandbox_create_timeout_seconds` 控制，默认 60 秒。它等的是“可用”，不是“已提交”。超时后返回错误，但 CR 可能仍存在，需要清理路径兜底——这正是控制器模式必须配 finalizer/清理逻辑的原因。

### 读 BatchSandbox：一张“运行合同”

`BatchSandboxSpec` 的主要字段：

| 字段 | 作用 | 设计含义 |
| --- | --- | --- |
| `replicas` | 期望副本数 | 支持批量；生命周期 API 创建的普通沙箱通常是 1 |
| `template` | Pod 模板 | 直接创建：镜像、入口、资源、环境都在这里 |
| `poolRef` | 引用一个 Pool | 走预热容量；与 `template` 是两条分配路径 |
| `shardPatches` | 对每个副本做差异化 patch | 一个批次里副本可以不完全相同 |
| `taskTemplate` | 分配成功后下发的任务 | 承载 entrypoint、初始化或业务进程 |
| `expireTime` | 绝对过期时间 | 控制面按时间清理，不依赖调用方记得删 |
| `pause` | 暂停/恢复意图 | `true` 请求暂停，`false` 请求恢复，`nil` 表示没有新操作 |

一个容易误读的点：**Pool 模式下，`template` 和 `taskTemplate` 不是一层东西。**

```text
Pool 里的 Pod：镜像和运行形状在请求之前就固定了
创建请求：entrypoint / env 可能作为“任务”下发
```

所以你在 Pod spec 里看到原始模板，不代表请求里的入口没生效；反过来，你也不能靠改 Pod spec 来改请求行为。读状态时要同时看 CR、Pod 和任务三层。

### 读 status：数量、健康、原因分开看

| 字段 | 回答什么 | 不要拿它回答什么 |
| --- | --- | --- |
| `replicas` / `allocated` / `ready` | 数量进展 | 业务任务是否成功 |
| `phase` | 整体运行健康 | 单次命令是否成功 |
| `conditions` | 为什么变成这样 | 当前 spec 是否已生效 |

`conditions` 里常见的有 `Ready`、`Progressing`、`PoolAllocationPending`、`PodFailed`。判断一条 condition 是否对应当前 spec，要看 `observedGeneration` 是否追上 `metadata.generation`。旧 generation 的 status 可能只是历史快照。

### 两种 workload provider

1.1.1 的 Kubernetes 运行时支持两种工作负载提供方：

- `batchsandbox`（默认）：CRD + controller 模式，本阶段主讲。
- `agent-sandbox`：使用 `Sandbox` CR 与 `[agent_sandbox]` 配置，`shutdown_policy` 可选 `Delete` 或 `Retain`。

两者共享 `[kubernetes]` 的连接、超时和限流配置，但模板来源和生命周期细节不同。看到文档里出现 `Sandbox` CR 而不是 `BatchSandbox` 时，先确认 provider，不要混读。

## 步骤 4 · Pool：把“等启动”换成“等容量”

Pool 解决的问题不是“让镜像变小”，而是把创建过程拆成两段：

```text
预先准备 Pod（成本提前支付）
  -> 请求到来时只做分配和少量注入
  -> 用完后按回收策略归还
```

### 两级容量

`PoolSpec` 的核心字段：

| 字段 | 含义 | 你在优化什么 |
| --- | --- | --- |
| `bufferMin` / `bufferMax` | 随时可用的空闲缓冲区上下界 | 冷启动延迟 |
| `poolMin` / `poolMax` | 整个 Pool 的容量上下界 | 总成本与故障时的扩张上限 |
| `scaleStrategy.maxUnavailable` | 扩容时允许多少 Pod 暂不可用 | 扩容速度与稳定性 |
| `updateStrategy.maxUnavailable` | 模板变化时滚动更新的不可用预算 | 升级期间的服务能力 |
| `recycleStrategy` | 归还后的处理：`Delete` / `Restart` / `Noop` | 复用速度与污染风险 |

直觉上：

```text
bufferMin 买的是“来了就能用”
poolMax   买的是“坏的时候不会无限膨胀”
recycle   决定“上一个用户留下的东西怎么处理”
```

`Restart` 比 `Delete` 快，但要求你能接受同一个 Pod 被再次使用；`Delete` 更干净，但每次都要重新走调度和启动。这里没有默认正确答案，只有业务对“隔离残留”的容忍度。

### Pool 耗尽：等待、429、以及不要误解的 30 秒

没有可用 slot 时，完整路径是：

```text
controller：在等待的 BatchSandbox 上写 PoolAllocationPending
            reason 常见为 PoolCapacityExhausted，并周期性重查
server    ：在 pool_acquisition_timeout_seconds（默认 30s）内等待容量
            仍未释放 -> 映射为可重试的 HTTP 429 + Retry-After 语义
```

两个精确细节经常被讲错：

1. **这个 30 秒不会延长创建超时。** 配置文档明确写着 Pool 等待“不延长创建超时”。60 秒创建预算仍然约束整体。
2. **等待窗口内释放的 slot 仍可能满足原请求。** 所以 429 不是“永久失败”，但也不该立刻无上限重试。

客户端策略应该是：尊重 `Retry-After`、加抖动、设总预算，多次失败后降级到普通创建或向用户报容量不足。

### Pool 带来的 API 约束

- Pool Pod 在请求前已存在，**不能**为单个请求注入任意 `networkPolicy` 或 `volumes`；这些必须随 Pool 模板固定。
- Pool Pod 必须满足任务契约：可被 task-executor 管理、装有 execd、bootstrap 入口正确。否则“Pod 能启动”仍然不等于“生命周期 API 能用”。
- 需要按请求区分网络策略时，应该用直接创建模板，或者为不同策略准备不同 Pool。

## 步骤 5 · 暂停与快照：保留边界由后端决定

这是跨运行时最容易踩坑的地方。同样是 `pause()`，两个后端的语义完全不同：

| 维度 | Docker | Kubernetes（默认 rootfs 模式） |
| --- | --- | --- |
| 动作 | 冻结容器 | 提交根文件系统为 OCI 镜像，释放 Pod 与 Pool 分配 |
| 内存 | 保留（进程被挂起） | **不保留**（恢复是重建） |
| 资源占用 | 仍占 CPU/内存配额 | 释放运行时资源，保留镜像存储 |
| 端点 | 通常不变 | 可能变化，需要重新解析 |
| Credential Vault | sidecar 内存仍在 | **丢失**，恢复后需重新注入 |
| 恢复 | 解冻 | 用快照镜像重建运行环境 |

```text
Kubernetes 暂停：Running -> Pausing -> Paused -> Resuming -> Running
```

“文件还在、变量没了”不是故障，而是 rootfs 快照的定义：它保存**文件系统**，不保存**运行内存**。需要保留 Guest 内存的场景，才轮到 QEMU VMState 这类能力，并且有额外的兼容性和节点条件。

### 快照状态要分两层读

```text
公开 API：Creating / Ready / Failed / Deleting
控制器内部：Pending -> Committing -> Succeed / Failed
```

内部 `Succeed` 与公开 `Ready` 不是矛盾，而是两层状态机。排查顺序应该是先看内部资源，再看公开层：

```text
kubectl -n <ns> get sandboxsnapshot <name> -o yaml
kubectl -n <ns> get job,pod -l sandbox.opensandbox.io/sandbox-snapshot-name=<name>
kubectl -n <ns> logs job/<commit-job-name> --all-containers
```

常见失败层级：

- `Pending` 卡住：找不到源 Pod、源节点不匹配、commit Job 无法调度。
- `Committing` 失败：镜像仓库不可达、push secret 错误、提交超时。
- 恢复后 `ImagePullBackOff`：pull secret 或快照镜像地址不对。
- 恢复后进程状态丢失：rootfs 模式的预期行为。

另外两条硬约束：暂停/恢复目前只支持单副本（`replicas=1`）；从快照恢复会创建**新的 sandbox ID**，不是把旧 ID 原地复活。

## 步骤 6 · FastSandbox：模板固定，请求只表达意图

FastSandbox 的定位不是“更快的 Docker”，而是**把调度、watch 传播和 kubelet 路径移出创建热路径**。

### 路由：它藏在 Kubernetes 运行时里面

在 `runtime.type = "kubernetes"` 下，`CompositeSandboxService` 按两个信号分流：

```text
请求带 templateId        -> FastSandboxService
现有 sandbox id 以 fsb-  -> FastSandboxService
其余                      -> KubernetesRuntime（BatchSandbox 路径）
```

这两个信号缺一不可：创建时看 `templateId`，后续操作看 ID 前缀。所以“模板沙箱创建成功，但删除时走了另一条路径”这类问题，本质是路由信号不一致。

### 模板：先构建，后下单

```text
创建 template（镜像、入口、资源、guest wiring）
  -> 异步构建：Pending -> Building -> Succeeded / Failed
  -> 只有 Succeeded 的模板才能创建沙箱
  -> 创建请求只带 templateId、TTL、metadata、networkPolicy 等
```

硬约束要记牢：

- `create_from_template()` 必须显式提供 TTL，不能用 `timeout=None` 逃避过期管理。
- 不能同时带 per-request 的 `image`、`env`、`resource`、`entrypoint` 或 `volumes`。
- 模板沙箱**没有**沙箱侧 Credential Vault；密钥能力不能想当然地跨后端复用。

这些约束不是“暂时没做”，而是模板模式的前提：模板是**不可变 golden image**，请求只表达意图。要换运行时形状，构建新模板，而不是在请求里改。

### 组件分工

| 组件 | 职责 |
| --- | --- |
| FastPath | 控制面和实时操作入口 |
| CRD | 保存持久意图，崩溃后可恢复 |
| Fastlet | 提供预热运行容量 |
| runtime agent | 管理 Firecracker 生命周期 |
| template builder | 生成不可变 golden image |
| janitor | 清理失败操作的孤儿资源 |

它快，是因为热路径短；它贵，是因为多了一整套组件要部署、监控和排障。选择它之前，先确认你的瓶颈真的是创建延迟，而不是镜像大小或网络。

## 步骤 7 · 隔离运行时：换的是边界，不是接口

`[secure_runtime]` 让你把沙箱从“共享内核的容器”换成“更强边界”：

| type | Docker 映射 | Kubernetes 映射 | 边界 | 主要代价 |
| --- | --- | --- | --- | --- |
| `""`（runc） | 默认 | 默认 | 共享宿主机内核 | 最快，隔离最弱 |
| `gvisor` | `runsc` | RuntimeClass `gvisor` | 用户态内核（syscall 拦截） | 系统调用开销、部分特性不兼容 |
| `kata` | `kata-runtime` | RuntimeClass `kata-qemu` | 轻量虚拟机 | 启动更慢、需要节点支持 |
| `firecracker` | 不支持 | RuntimeClass `kata-fc` | 微虚拟机 | **仅 Kubernetes**，必须显式指定 RuntimeClass |

配置校验规则也值得知道：

- `type` 为空时，两个映射字段都必须省略。
- `firecracker` 必须提供 `k8s_runtime_class`。
- `gvisor` / `kata` 至少提供 Docker 或 K8s 其中一个映射。
- 启动时会校验 RuntimeClass 是否存在；不存在会报错或明确警告。

最重要的限制：**一个 server 进程只有一个 `[secure_runtime]` profile，API 请求不能按沙箱选择隔离等级。** 如果同一集群里需要多种隔离等级，就要部署多个 server 实例，分别对外提供地址。

还有两条兼容性红线：

- gVisor 的 netstack 不支持 egress 的重定向机制，配了 egress 也不会按预期工作。
- 透明 service mesh sidecar 与 egress 在同一网络命名空间会冲突，不能当成可叠加的默认组合。

## 步骤 8 · 能力矩阵与选择决策树

把前面的内容压缩成一张表。`条件` 表示“接口支持，但需要满足后端/配置前提”。

| 能力 | Docker | Kubernetes | FastSandbox |
| --- | --- | --- | --- |
| 创建/删除/查询 | 支持 | 支持 | 支持（templateId 路径） |
| 公网/宿主端点解析 | 支持（端口映射） | 需要 ingress 方案 | 由 FastPath 提供 |
| 自定义镜像 | 支持 | 支持 | 仅通过模板 |
| 每请求 env/entrypoint | 支持 | 支持（直接模板或任务） | 不支持 |
| TTL / renew | 支持 | 支持（`expireTime`） | 支持（创建必须给 TTL） |
| pause / resume | 冻结容器，保留内存 | rootfs 快照，默认不保留内存 | 支持暂停/唤醒，含 `idlePolicy` 自动路径 |
| 文件系统快照 | 不是主路径 | 支持，单副本 | 模板/镜像路径 |
| Pool 预热 | 无 | 支持 | 预热容量由 Fastlet 提供 |
| egress `networkPolicy` | 条件：`bridge` 模式 | 支持（创建时声明） | 条件：模板/池预置策略 |
| Credential Vault | 条件：`dns+nft` + 创建时策略 | 条件：同上，且非模板沙箱 | 模板沙箱不支持 |
| 多副本沙箱 | 不适用 | `replicas` 支持 | 按 FastSandbox 能力 |
| 强隔离 | 条件：`runsc`/`kata-runtime` | 条件：RuntimeClass | Firecracker 内置 |
| 跨节点调度 | 无 | 支持 | 由 Fastlet 池承担 |

选型时可以按这个顺序问自己：

```text
1. 只是本机验证/开发？ -> Docker
2. 需要多租户、调度、弹性、快照？ -> Kubernetes
3. 创建延迟是核心指标，且工作负载形状固定？ -> Kubernetes + FastSandbox 模板
4. 需要硬隔离？ -> 先定 secure_runtime，再确认节点/RuntimeClass 支持
5. 需要每请求不同的网络或卷？ -> 不要用 Pool；用直接创建或分池
```

## 步骤 9 · 部署顺序与前置条件（只看与运行时相关的部分）

Kubernetes 上的官方顺序：

```text
base（CRD + RBAC）
  -> opensandbox-controller
  -> fast-sandbox（可选）
  -> ingress-gateway（Kubernetes 必需）
  -> opensandbox-server
  -> opensandbox-node-agent（可选）
```

顺序不是形式主义：

1. 没有 CRD，controller 没有可观察对象。
2. controller 必须先能 reconcile `BatchSandbox`、`Pool`、`SandboxSnapshot`。
3. 启用 fast-sandbox 时，它必须早于 server，因为 server 启动时要连 FastPath 并 watch 相关资源。
4. gateway 必须在 server 之前就绪，server 才能从第一次启动就拿到正确地址。
5. server 最后安装，避免“启动时后端还不存在”的假故障。

两个容易漏掉的配置事实：

- umbrella chart 的 `ingress-gateway.enabled` 默认是 `false`，尽管 Kubernetes 部署需要 ingress。不要以为“chart 装上了”就等于“路由开了”。
- `kubernetes.namespace` 不填时使用默认行为；生产上应显式指定 workload 命名空间，并与 RBAC 对齐。

## 步骤 10 · 实验

> 说明：作者编写这套笔记时，环境中没有运行中的 Docker daemon 和 Kubernetes 集群，下面的 D 系列可在有 Docker 的机器上完成；K 系列需要可丢弃的测试集群，编写环境**未执行**，阅读时请把“命令存在”与“本机已验证”分开。

### 实验 D1 · 看见“沙箱 = 容器 + 标签 + 端口”

用 `runtime.type = "docker"` 启动 server，创建一个沙箱，然后在宿主机上：

```bash
docker ps --format '{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Names}}'
docker inspect <container-id>
```

观察三件事：镜像是不是你请求的那个、端口映射落在 `port_range` 内、容器的网络模式是 `host` 还是 `bridge`。这一步的目的不是背字段，而是建立“API 之下确实有一个具体对象”的直觉。

### 实验 D2 · 制造一次能力条件失败

把 `docker.network_mode` 设为 `host`，然后创建带 `networkPolicy` 的沙箱。预期是被拒绝，而不是静默忽略。

把失败信息抄下来，再改回 `bridge` 重试。你要能用自己的话解释：**为什么这个组合不允许**，以及如果平台选择“忽略策略直接放行”，会带来什么安全后果。

### 实验 K1 · 观察创建的三层状态（需集群）

创建沙箱的同时，在另一个终端循环：

```bash
kubectl -n <ns> get batchsandbox -w
kubectl -n <ns> get pods -w
```

记录三个时间点：CR 出现、Pod Ready、首次命令成功。三者之间的差值，就是你后续做容量规划时要优化的部分。

### 实验 K2 · 推演一次 Pool 耗尽（需集群）

把 `bufferMin` 设为 1、`poolMax` 设为 1，并发创建 3 个沙箱。预期看到一个成功、其余进入 `PoolAllocationPending`，并在等待窗口后收到 429。

如果暂时没有集群，就用纸面推演：写出 controller 写 condition 的时刻、server 开始等待的时刻、返回 429 的时刻，以及第一个沙箱释放后哪个请求会被满足。**能把时间线写对，比跑通更有价值。**

### 实验 K3 · 读一次快照失败（需集群）

创建一个沙箱，写入一个文件，暂停，然后检查 `sandboxsnapshot` 的内部 phase 和 commit Job 的日志。再故意把 push secret 配错，观察失败落在 `Pending` 还是 `Committing`。

### 实验 S1 · 验证 secure_runtime 的启动校验

在配置里写 `type = "firecracker"` 但不给 `k8s_runtime_class`，启动 server，预期是配置校验失败。再写一个不存在的 RuntimeClass，观察是“启动失败”还是“启动警告、创建时失败”。

这个实验的意义是让你分清**配置期错误**和**运行期错误**：越早失败，越容易定位。

## 故障速查

| 现象 | 先查什么 | 常见根因 |
| --- | --- | --- |
| 创建超时 | `sandbox_create_timeout_seconds`、Pod events | 镜像拉取慢、调度失败、execd 未就绪 |
| 429 | `PoolAllocationPending` 的 reason/message | Pool 耗尽、Pool Pod 不 Ready、选择器不匹配 |
| 暂停后恢复 401 | Vault 注入、网络策略 | 密钥只在 sidecar 内存，恢复后未重注入 |
| 恢复后变量丢失 | 后端与快照模式 | rootfs 快照不保存内存，属预期 |
| 恢复后 `ImagePullBackOff` | pull secret、镜像地址 | 快照镜像推送成功但拉取凭据缺失 |
| `networkPolicy` 被拒 | `network_mode` / Pool 模式 | Docker 非 bridge，或 Pool 预创建无法按请求注入 |
| gVisor 下出站策略异常 | `[egress]` 与 `secure_runtime` | netstack 不支持该重定向机制 |
| 模板创建失败 | 模板 phase、builder 日志 | 模板未 `Succeeded`，或请求里混入了 per-request 字段 |

## 常见误区

| 误区 | 纠正 |
| --- | --- |
| “FastSandbox 是第三种 `runtime.type`” | 它是 `kubernetes` 下的服务分支，靠 `templateId` / `fsb-` 前缀路由 |
| “暂停一定省资源” | Docker 冻结仍占资源；K8s 释放资源但不保留内存 |
| “Pool 有 Pod 就一定有容量” | 要看 Ready、是否被占用、`status.available`、标签选择器 |
| “快照成功就能原样恢复进程” | 默认只恢复文件系统；内存需要 VMState 等额外能力 |
| “配置了 gVisor 就自动更安全” | 边界更强，但兼容性更窄，egress/网络方案要重新验证 |
| “接口有 `credential_vault` 就代表所有后端都有” | 模板沙箱没有沙箱侧 Vault；Pool 也受预创建约束 |
| “429 是服务端 bug” | 它是容量语义，应按可重试错误处理并尊重 `Retry-After` |

## 自检与参考答案

**1. 为什么说“接口统一不等于能力等价”？**

因为 `SandboxService` 统一的是调用形状，不是后端能力。Docker 没有 Pool 和调度，K8s 的 pause 是快照语义，FastSandbox 不允许每请求改镜像。判断一个功能是否可用，要同时看运行时、配置、版本和镜像。

**2. `runtime.type`、`secure_runtime.type` 和 FastSandbox 三者的关系是什么？**

`runtime.type` 决定资源在哪（docker/kubernetes）；`secure_runtime.type` 决定隔离边界（runc/gVisor/Kata/Firecracker）；FastSandbox 是 kubernetes 内部按请求特征分流的一条服务路径。三者是不同维度，不能互相替代。

**3. 为什么 Pool 耗尽会先看到 `PoolAllocationPending`，而不是直接 429？**

因为 429 是 server 层的对外映射。控制器先把“我在等容量”写进 CR condition，server 在有限窗口内等待，窗口结束仍无容量才转成 429。这样等待中的请求仍有机会被释放的 slot 满足。

**4. `pool_acquisition_timeout_seconds` 和 `sandbox_create_timeout_seconds` 是什么关系？**

前者是等待 Pool 容量的上限，后者是创建整体预算；前者不延长后者。两个都要考虑，不能只调大其中一个就以为能等更久。

**5. 为什么 Kubernetes 暂停后恢复，进程里的变量没了？**

因为默认 rootfs 快照提交的是文件系统镜像，恢复时重建容器。进程和内存没有被保存。要保留 Guest 内存，需要额外的 VMState 能力，并且受节点与兼容性约束。

**6. 内部 `Succeed` 和公开 `Ready` 为什么不一致？**

它们是两层状态机。控制器先完成提交，公开层还要完成镜像可拉取、端点发布等步骤。排查时先看内部资源，再看公开状态，并用 `observedGeneration` 判断状态是否对应当前 spec。

**7. 为什么模板沙箱不能带 per-request 的 `image` 或 `env`？**

模板是不可变 golden image，请求只表达“用哪个模板、给谁、用多久、什么网络策略”。允许改镜像会破坏可复现性和构建产物的一致性。要换形状就构建新模板。

**8. 一个集群里能同时有 gVisor 和 Kata 沙箱吗？**

可以，但不能靠同一个 server 实例按请求切换。一个 server 进程只有一个 `[secure_runtime]` profile，需要多种隔离等级就要部署多个 server 实例或使用不同入口。

**9. 选 Docker 还是 Kubernetes，最短的判断句是什么？**

需要“单机、可观察、快速改”的用 Docker；需要“多租户、调度、池化、快照、收敛”的用 Kubernetes。延迟是核心指标且形状固定时，再考虑 FastSandbox 模板。

## 关键源码坐标

| 想回答的问题 | 先看 |
| --- | --- |
| 统一接口与后端实现 | `server/opensandbox_server/services/sandbox_service.py`、`docker/`、`k8s/` |
| FastSandbox 路由 | `server/opensandbox_server/services/composite_service.py` |
| 运行时与隔离配置 | `server/configuration.md` 的 `[runtime]`、`[docker]`、`[kubernetes]`、`[secure_runtime]` |
| 隔离运行时映射与启动校验 | `server/opensandbox_server/services/runtime_resolver.py` |
| BatchSandbox 字段与条件 | `kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go` |
| Pool 容量与回收 | `kubernetes/apis/sandbox/v1alpha1/pool_types.go` |
| 快照 phase 与格式 | `kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go` |
| 控制器与分配器 | `kubernetes/internal/controller/`、`allocator.go`、`internal/scheduler/` |
| 部署顺序与 Helm 值 | `docs/deployment/index.md`、`manifests/charts/opensandbox/values.yaml` |
| 暂停恢复行为 | `docs/guides/pause-resume.md` |
| FastSandbox 设计 | `docs/architecture/fast-sandbox/index.md`、`templates.md`、`scheduling.md` |

## 做完之后

你现在应该能回答本阶段开头那四个“像 bug 的现象”，并且能在一张表上同时标出“哪个后端支持”和“需要什么条件”。这就是运行时层的核心判断力。

下一阶段换一条轴：资源已经跑起来了，**外部怎么访问它、它怎么访问外部、密钥怎样不进入沙箱**。同一个运行时之上，网络与凭据会再叠加一层条件。

带着这个问题进入下一章：**“沙箱已经 Ready，凭什么说它‘能安全地联网’？”** 进入[阶段 5](../stage-5/)。
