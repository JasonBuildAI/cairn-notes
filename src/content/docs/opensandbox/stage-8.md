---
title: "阶段 8：工程与生产"
description: "多租户、测试、指标、发布与回滚：从能跑到敢上线。"
---

> 本阶段回答：多租户怎样隔离？资源怎样不泄漏？测试要测到哪一层？出事时靠什么定位？发布前必须验证什么？
> 预计 4–5 天。核心产出是一份**生产就绪评审清单**和一套**故障分层定位流程**。

## 为什么需要这一步

前七个阶段，你一直在“让一件事成功”：创建成功、执行成功、联网成功、Agent 跑通。

生产环境问的是另一组问题：

```text
100 个租户共用一个 server，A 租户能看到 B 的沙箱吗？
某个 Agent 崩溃了，沙箱还在计费吗？
Pool 配额耗尽和 429 是同一件事吗？
升级 controller 后，旧的 BatchSandbox 还能被管理吗？
凌晨两点报警，值班的人先看哪个指标？
```

这些问题有个共同点：**它们都不在“正常路径”上**。正常路径靠功能测试覆盖，异常路径靠工程件覆盖。工程件包括：隔离模型、配额、测试分层、可观测性、发布流程、回滚预案。

一个残酷的判断标准：

> 如果你说不清“出事时看什么、怎么止损、怎么回滚”，那它就还没到生产就绪。

## 一个比喻：从样板间到连锁酒店

```text
阶段 0–7：样板间
  一间房能住人，水电网络都对

阶段 8：连锁运营
  每间房的门卡不能通用（租户隔离）
  水电有表、有配额（资源治理）
  每天有人巡检（监控）
  出故障有 SOP（诊断与止损）
  换家具不影响住客（发布与回滚）
```

样板间靠“看得见的正确”，连锁靠“看不见的约束”。

## 步骤 1 · 先写威胁模型

不做威胁模型的安全配置，通常只是在“堆开关”。先把资产和攻击面列出来：

| 资产 | 谁会威胁它 | 现有控制 | 残余风险 |
| --- | --- | --- | --- |
| 宿主机/节点 | 沙箱内逃逸、恶意镜像 | 隔离运行时、capability 丢弃、seccomp/AppArmor | 内核漏洞、配置错误 |
| 其他租户的数据 | 越权访问、ID 猜测 | namespace 隔离、租户标签、404 隐藏 | 共享命名空间时的标签遗漏 |
| 凭据/模型密钥 | 提示注入、读环境变量 | Credential Vault、egress 白名单 | sidecar/控制面被攻破 |
| 网络与数据 | 数据外泄 | 默认拒绝、目标白名单 | 允许列表过宽、DNS 绕过 |
| 镜像供应链 | 恶意基础镜像、标签漂移 | 固定 digest、私有仓库、扫描 | 运行时拉取策略过松 |
| 成本 | 泄漏沙箱、无限续期、Pool 闲置 | TTL、配额、预算、巡检 | 孤儿资源、异常重试 |

写威胁模型的目的不是“列全”，而是让每条控制都有对应的**资产**和**残余风险**。没有残余风险的控制，通常是没想清楚。

### 三条优先级最高的控制

1. **默认拒绝出站**：数据外泄是 Agent 场景最现实的损失。
2. **租户级 namespace + 配额**：越权和资源挤兑都从这里收敛。
3. **TTL + 清理巡检**：泄漏的沙箱既是成本，也是可被继续访问的执行环境。

## 步骤 2 · 多租户：一个 server，多个命名空间

OpenSandbox 的多租户模型很直接：

```text
API key -> TenantEntry -> 租户命名空间
所有 lifecycle 操作自动限定在该 namespace
```

### 工作方式

```text
请求带 OPEN-SANDBOX-API-KEY
  -> 配置了 tenant provider？
       是 -> 用 key 查租户
             查到 -> 注入租户上下文，路由到对应 namespace
             查不到 -> 401
       否 -> 回退到单租户 server.api_key
```

具体行为：

- 每个租户一个**预先创建**的 Kubernetes namespace（由集群管理员建）。
- 创建、列表、查询、删除都按租户 namespace 作用域执行。
- 列表只返回本租户的沙箱。
- 多租户模式下，代理路由 `/sandboxes/{id}/proxy/...` 也要求带 API key。
- 创建时会在工作负载上打 `opensandbox.io/tenant=<name>` 标签；多个租户共用一个 namespace 时，list/get/delete/proxy 会隐藏其他租户的带标签沙箱（返回 404）。
- 未打标签的历史沙箱在过期前仍然可见——这是迁移期要特别留意的窗口。

### 前置条件与硬限制

| 条件 | 说明 |
| --- | --- |
| `runtime.type = "kubernetes"` | 多租户依赖 namespace 隔离 |
| **Docker 不支持** | 配了 Docker 又启用租户，server 会拒绝启动（fatal） |
| namespace 预先创建 | server 不会替你建租户命名空间 |
| RBAC 允许跨 namespace | 默认 Helm RBAC 已包含相应 ClusterRole |
| 建议配 ResourceQuota / LimitRange | 防止单租户挤占整个集群 |
| 建议配 egress sidecar 资源 | 防止 sidecar 成为资源黑洞 |

### 租户 provider 与轮换

- `file` provider：本地 TOML，适合单集群、变更不频繁。
- `http` provider：远程端点，适合集中管理。
- 两者都支持热加载与 key 轮换；轮换时要保证**新旧 key 有重叠窗口**，否则正在运行的客户端会突然 401。

### 隔离模型要说清楚边界

多租户隔离的是**控制面可见性和 namespace 资源**，不是“强安全边界”：

- 同一节点上的沙箱仍共享内核（除非启用 gVisor/Kata/Firecracker）。
- 网络隔离要靠 egress/NetworkPolicy，不是 namespace 自动带来的。
- 平台管理员仍能跨租户操作。

把这三条写进你的安全说明，比写“支持多租户隔离”更可信。

## 步骤 3 · 资源治理：四本账

生产上要同时管四本账：

```text
1. 单沙箱账：resourceLimits、磁盘、进程数
2. 租户账：ResourceQuota、LimitRange、并发沙箱数
3. 池账：bufferMin/bufferMax、poolMin/poolMax、闲置成本
4. 时间账：TTL、renew、idle pause、孤儿清理
```

### 单沙箱与租户

- 创建请求里的资源限制是“申请”，不是“保证”；节点容量和配额才是硬约束。
- 配额耗尽的表现可能是创建失败、等待或 429，要和 Pool 耗尽区分（看 reason 和请求路径）。
- `LimitRange` 可以给未声明资源的 Pod 兜底，避免“一个请求吃满节点”。

### 池账

Pool 的缓冲区是**用钱买延迟**：

```text
bufferMin 越大 -> 冷启动越少 -> 闲置成本越高
poolMax   越大 -> 抗突发越强 -> 故障时扩张越猛
```

生产上要按“峰值并发 × 可接受冷启动比例”反推 buffer，而不是拍一个数字。

### 时间账

| 机制 | 作用 | 注意 |
| --- | --- | --- |
| TTL | 绝对过期，控制面清理 | 默认 10 分钟；创建时的最大超时限制不适用于 renew |
| renew | 延长/缩短过期时间 | 只应在有进展时续期 |
| `automation.idle_pause` | 空闲自动暂停/唤醒 | 仅对声明了 `lifecycle.idlePolicy` 的 fast sandbox 生效 |
| 孤儿清理 | 清理失败操作的残留 | 依赖 finalizer/janitor 与巡检 |

`automation.idle_pause` 不是“全局省资源开关”。没有 `idlePolicy` 的沙箱，这段配置完全不生效。

### 成本要看三块

- **运行时**：空闲 Pool、泄漏沙箱、超配资源。
- **存储**：快照镜像、模板 golden image、日志。
- **流量与 token**：egress 流量、模型调用。

只盯 CPU 成本，通常会漏掉后两块。

## 步骤 4 · 测试金字塔：每层证明什么

| 层级 | 命令示例 | 证明什么 | 不证明什么 |
| --- | --- | --- | --- |
| 单元 | `uv run pytest tests/test_docker_service.py` | 单个模块逻辑 | 真实容器/集群行为 |
| 控制器单元 | `go test ./internal/controller/ -run TestAllocatorSchedule -v` | 分配、暂停恢复等收敛逻辑 | 真实调度与镜像拉取 |
| 契约 | `specs/tests` + 生成客户端校验 | 实现与 spec 一致 | 端到端可用性 |
| 集成（K8s） | `make setup-envtest && make test` | controller 与 API Server 的交互 | 真实节点、CNI、RuntimeClass |
| 跨语言 e2e | `tests/` 下按语言目录运行 | SDK 与真实 server 的行为一致 | 生产拓扑与容量 |
| K8s e2e | `make test-e2e` | 创建、Pool、任务、暂停恢复 | 你的生产配置 |
| 冒烟 | `server/tests/smoke.sh` | 部署后最小闭环 | 深度回归 |

### 测试分层的三个原则

1. **越往下越便宜，越往上越可信。** 不要用 e2e 覆盖本该单元测试的分支。
2. **契约测试是跨语言的锚。** 没有它，五种 SDK 会各自漂移。
3. **e2e 要覆盖失败路径。** 只测“创建成功”的 e2e，证明不了 429、快照失败、Pod 恢复。

### 改代码时的最小验证集

```text
改 server 业务逻辑   -> 对应 pytest + 相关 e2e
改 CRD/controller    -> make manifests generate + make test + 相关 e2e
改 spec              -> 重新生成 + 契约测试 + 受影响语言 SDK 测试
改 Helm/部署         -> 渲染校验 + 集群安装 + 冒烟
```

注意 CRD 的生成约束：改了 `apis/` 下的类型，必须跑 `make manifests` 和 `make generate`，否则 CRD YAML 与 DeepCopy 会不同步。这类“生成物漂移”在 review 时很难看出来，但上线会直接坏。

## 步骤 5 · 可观测性：日志、指标、追踪、诊断

### 四类信号

| 信号 | 来源 | 回答什么 |
| --- | --- | --- |
| 日志 | server、controller、execd、egress | 这一刻发生了什么 |
| 指标 | server HTTP、controller 分配/容量、execd、egress | 趋势与饱和度 |
| 追踪 | OTel（HTTP、Pool 预热等） | 一次请求慢在哪一段 |
| 诊断 | `osb diagnostics` 的稳定日志与事件 | 可复现的排障材料 |

### 指标要盯的几组

```text
server：请求量、错误率、延迟、429 比例
controller：分配成功/失败、Pool 可用量、Pending 数
execd：命令数、失败数、OOM 观察
egress：放行/拒绝计数、DNS 延迟、失败原因
```

不要只做“有没有”的监控，要做“够不够”的监控：Pool 可用量、配额余量、快照失败率、租户级并发。

### 追踪的价值在跨层

一次创建可能跨 server → K8s API → controller → Pod → execd。没有 trace，你只能猜是哪一段慢；有 trace，能看到 Pool 等待、调度、拉镜像、execd 就绪各占多少。

Pool 预热有专门的 tracing 支持；开启后可以定位“为什么这次分配比上次慢”。

### 诊断入口

`osb diagnostics` 提供稳定的诊断日志与事件，适合收集“可复现的最小证据包”。`osb devops` 是实验性旧入口，不要写进新脚本或值班手册。

一次好的诊断包应包含：

```text
sandbox id / tenant / 时间窗
请求 ID 与关键响应码
BatchSandbox conditions（含 observedGeneration）
Pod events 与容器状态
相关组件日志片段（脱敏）
指标快照（Pool 可用量、配额余量）
```

## 步骤 6 · 故障分层定位：先定界，再取证

生产排障最容易犯的错是“一上来就看日志”。正确顺序是先定界：

```text
第 1 层：客户端/认证      401/403、配置错、key 轮换
第 2 层：server           4xx/5xx、429、超时、状态映射
第 3 层：调度/控制器      PoolAllocationPending、PodFailed、condition 原因
第 4 层：Pod/容器         调度失败、拉镜像失败、OOM、CrashLoop
第 5 层：execd            端口、健康检查、命令失败
第 6 层：网络/egress      ingress 404/503/502、策略拒绝、DNS
第 7 层：存储/快照        仓库不可达、push secret、ImagePullBackOff
```

每一层都有“最小证据”：

| 层 | 最小证据 |
| --- | --- |
| 客户端 | 请求 ID、状态码、响应体 |
| server | 结构化日志、指标、429 比例 |
| 控制器 | CR conditions、`observedGeneration`、事件 |
| Pod | `kubectl describe pod`、events、上次退出码 |
| execd | `/ping`、端口监听、命令日志 |
| 网络 | 网关日志、策略命中/拒绝计数 |
| 快照 | 内部 phase、commit Job 日志、仓库连通性 |

### 止损顺序

```text
1. 停止扩大：限流/暂停新创建/关闭入口
2. 保住证据：诊断包、日志快照（先于重启）
3. 恢复服务：回滚/扩容/切换 Pool
4. 修根因：代码/配置/容量
5. 复盘：把“这次靠什么定位”写成下一次的检查项
```

第 2 步经常被跳过：一重启，证据就没了。先取证，再动手。

## 步骤 7 · 发布与变更：让回滚是默认能力

### 版本要对齐

一次部署里至少有这些版本：

```text
umbrella chart 版本
server 镜像
controller 镜像
execd 镜像
egress 镜像
gateway / fast-sandbox / node-agent 镜像
SDK 版本（客户端）
```

它们不必完全相同，但必须**明确兼容关系**。SDK 滞后于 server 通常可以（容忍未知字段），反过来则可能缺能力。组件标签与 umbrella 版本不是同一层概念，别拿一个版本号套所有镜像。

### 变更顺序

```text
spec -> 生成物 -> 实现 -> 部署清单 -> 文档 -> 发布说明
```

部署侧的生成物包括 CRD YAML、DeepCopy、Helm 渲染结果。改了 CRD 不重新生成，是最常见的“本地没事、集群报错”。

### 发布策略

- **先灰度一个租户/命名空间**，观察错误率、429、Pool 可用量。
- **保留上一版镜像与 chart**，回滚要能在分钟级完成。
- **数据库/存储变更单独评估**，不要和镜像升级绑在一次发布里。
- **发布说明写清破坏性变更与迁移步骤**，不要只写“修复若干问题”。

### 回滚检查

回滚不是“把镜像换回去”就完了：

- CRD 是否向前兼容？（新字段旧控制器会忽略，通常安全；删除字段则危险）
- 快照/模板格式是否兼容？
- 正在运行的沙箱会不会失联？
- 回滚后 Pool 是否需要重建？

## 步骤 8 · 生产就绪评审清单

发布前逐项打勾，任何一项答不上来都要标为阻塞：

| 类别 | 检查项 |
| --- | --- |
| 认证 | API key 是否必需？是否支持轮换？401 是否有审计？ |
| 租户 | 是否启用多租户？namespace 是否预创建？配额/LimitRange 是否配置？ |
| 隔离 | 是否需要 gVisor/Kata/Firecracker？RuntimeClass 是否验证？ |
| 网络 | 出站是否默认拒绝？允许列表是否最小？ingress 模式与客户端是否匹配？ |
| 凭据 | 是否使用 Vault？密钥是否可能进入沙箱/日志/模型上下文？ |
| 生命周期 | TTL 默认值与上限？renew 策略？孤儿清理？ |
| 容量 | Pool 容量依据？突发上限？配额耗尽行为？ |
| 存储 | 快照仓库、push secret、保留策略、恢复演练？ |
| 可观测 | 日志字段、关键指标、告警阈值、trace 采样？ |
| 诊断 | 诊断包怎么采？值班手册在哪？升级路径是否演练？ |
| 发布 | 灰度方案、回滚步骤、版本兼容矩阵、发布说明？ |
| 成本 | 运行时/存储/流量/token 四本账是否有人负责？ |

### 三个“一票否决”

1. **默认允许出站**，且没有审计。
2. **没有 TTL 或清理机制**，沙箱可以无限存活。
3. **没有回滚方案**，只能“向前修”。

## 步骤 9 · 实验

> 说明：单元/契约测试可在本机运行；K8s e2e、配额与租户实验需要真实集群，本环境未执行，请标注“未验证”。

### 实验 S1 · 跑一个聚焦测试，而不是全量

```bash
cd server
uv run pytest tests/test_docker_service.py -q
uv run ruff check
uv run pyright
```

观察：一个聚焦测试能多快给出反馈；全量套件在什么情况下才值得跑。

### 实验 S2 · 控制器测试

```bash
cd kubernetes
make setup-envtest
go test ./internal/controller/ -run TestAllocatorSchedule -v
```

如果没有 envtest 依赖，记录阻塞点，不要跳过不写。

### 实验 S3 · 契约一致性

修改（或在副本里模拟修改）spec 的一个可选字段，重新生成客户端，观察：

- 哪些语言出现 diff；
- 手写层是否需要改；
- 契约测试是否失败。

不提交这个改动，只把它当作一次“变更影响面”演练。

### 实验 S4 · 指标与追踪

启动带 `[otel]` 配置的 server，创建并执行一次任务，确认：

- HTTP 指标有数据；
- Pool 预热 trace 有跨层 span；
- 日志里能通过 trace id 关联到请求。

### 实验 S5 · 配额耗尽（需集群）

给租户 namespace 设一个很小的 ResourceQuota，持续创建沙箱，观察失败形态：是 403、创建超时，还是 Pending。把它和 Pool 耗尽的 429 区分开。

### 实验 S6 · 租户隔离验证（需集群）

用租户 A 的 key 创建沙箱，再用租户 B 的 key 去 get/list/delete，预期是 404 或空列表。再验证代理路由是否也要求 key。

### 实验 S7 · 诊断包演练

对一个故意失败的沙箱执行 `osb diagnostics`，检查证据包是否包含：conditions、events、日志、指标快照。让另一个没参与排障的人只看这个包，能否说出一半以上的原因。

## 故障速查

| 现象 | 先定界 | 常见根因 |
| --- | --- | --- |
| 全部请求 401 | 认证层 | key 轮换无重叠、租户 provider 未加载 |
| 单租户 403/失败 | 配额层 | ResourceQuota 耗尽、LimitRange 冲突 |
| 创建慢但成功 | 调度/Pool | buffer 不足、镜像拉取慢 |
| 429 集中出现 | server/Pool | Pool 耗尽、等待窗口结束 |
| condition 一直 Pending | 控制器 | 源 Pod/节点不匹配、Job 无法调度 |
| Pod CrashLoop | 容器层 | 入口错误、execd 启动失败、OOM |
| 入站 503 | 网络层 | 端点未就绪、execd 未监听 |
| 快照失败 | 存储层 | 仓库不可达、push secret 错 |
| 指标缺失 | 可观测层 | OTel 未启用、端点/协议不匹配 |
| 成本异常上升 | 时间/容量账 | 孤儿沙箱、无进展续期、Pool 过大 |

## 常见误区

| 误区 | 纠正 |
| --- | --- |
| “多租户等于强隔离” | 它隔离控制面可见性与 namespace 资源；内核/网络边界另算 |
| “Docker 也能开多租户” | 不支持，启用会拒绝启动 |
| “有 TTL 就不会泄漏” | 失败路径、孤儿资源仍要巡检与清理 |
| “测试越多越安全” | 分层缺失时，堆 e2e 只会更慢、更不稳定 |
| “改了 CRD 不用重新生成” | CRD YAML/DeepCopy 会漂移，集群直接报错 |
| “重启一下再看看” | 重启会毁掉证据，先取证 |
| “监控看 CPU 就够了” | 还要看 Pool 可用量、配额余量、快照失败率、429 |
| “回滚就是换镜像” | CRD/存储/运行中沙箱都可能有兼容问题 |

## 自检与参考答案

**1. 为什么多租户要求 Kubernetes 运行时？**

因为隔离依赖 namespace、RBAC 和配额，这些是 Kubernetes 的原语。Docker 没有对应模型，所以启用租户时会直接拒绝启动。

**2. 多租户下，为什么代理路由也要 API key？**

否则知道 sandbox ID 的人可以绕过租户边界访问沙箱端口。代理是数据面入口，必须和 lifecycle 一样做租户鉴权。

**3. 租户 A 和 B 共用一个 namespace 时，如何避免互相看见？**

创建时打 `opensandbox.io/tenant=<name>` 标签，list/get/delete/proxy 按标签过滤，其他租户的沙箱返回 404。未打标签的历史沙箱在过期前仍可见，需要迁移计划。

**4. 测试金字塔里，契约测试为什么不可替代？**

它直接验证实现与 spec 的一致性，是跨语言 SDK 的共同锚点。单元测试看不到契约，e2e 又太慢且覆盖不全。

**5. 改了 CRD 类型后必须做什么？**

运行 `make manifests` 和 `make generate`，同步 CRD YAML 与 DeepCopy，再跑控制器测试。只改 Go 类型会导致集群行为与代码不一致。

**6. 为什么排障要先定界再取证？**

不同层的证据完全不同。先判断是认证、server、控制器、Pod、execd、网络还是存储，才能取对证据；否则会在错误层浪费时间。

**7. 为什么“先重启”是坏习惯？**

重启会清掉容器状态、事件和临时日志。正确顺序是先收集诊断包和日志快照，再止损。

**8. 发布时哪些版本需要一起考虑？**

chart、server、controller、execd、egress、gateway/fast-sandbox/node-agent，以及客户端 SDK。它们不必同版本，但必须有明确的兼容矩阵。

**9. 生产就绪的三个一票否决项是什么？**

默认允许出站且无审计、没有 TTL/清理机制、没有回滚方案。

**10. 成本要算哪四本账？**

单沙箱资源、租户配额、Pool 缓冲、时间（TTL/renew/空闲暂停），再叠加存储、流量和 token。

## 关键源码坐标

| 想回答的问题 | 先看 |
| --- | --- |
| 多租户模型与配置 | `docs/guides/multi-tenancy.md` |
| 网络隔离方案 | `docs/guides/network-isolation.md` |
| 遥测与指标 | `docs/guides/telemetry.md`、`docs/sdks/observability.md` |
| 生命周期钩子 | `docs/guides/lifecycle-hooks.md` |
| Pod 供给失败恢复 | `docs/guides/pod-recovery.md` |
| 部署与运维 | `docs/deployment/index.md`、`docs/deployment/ack.md` |
| server 测试 | `server/tests/`、`server/AGENTS.md` |
| 控制器测试与 e2e | `kubernetes/AGENTS.md`、`kubernetes/test/e2e/` |
| 跨语言 e2e | `tests/` |
| CRD 生成约束 | `kubernetes/AGENTS.md` |

## 做完之后

你现在应该能回答“这套东西凭什么敢上线”，并且能拿出一份可检查的清单，而不是一句“测试过了”。

下一阶段是收束：把前面所有能力合成一个完整项目——数据分析与报告 Agent。它会同时用到生命周期、执行、运行时、网络、凭据、SDK 和工程件。你要做的不是再学新 API，而是证明自己能把这些约束组织成一个可交付系统。

带着这个问题进入最后一章：**“如果让你从零交付一个沙箱 Agent，你会怎样证明它是对的？”** 进入[阶段 9](../stage-9/)。
