---
title: "阶段 1：一次任务怎样穿过平台"
description: "跟随一次任务穿过控制面、数据面与运行时，建立系统地图。"
---

> 对应[学习路线](../learning-path/)阶段 1（核心 · 2–3 天）。本阶段不追求读完源码，而是建立“看到任何一次调用，都知道它属于哪一层”的能力。
> 源码目录：`$OSB_SRC`。所有路径都相对这个目录。
> 核心产出：一张系统图、一张创建时序图、一张执行时序图、一份失败点清单。图要手画，不要收藏现成图。

## 一、这一阶段到底要解决什么

阶段 0 结束时，你已经让一条最小链路真实工作：`Sandbox.create` → 容器启动 → 命令输出 → `destroy`。

但你看到的仍然是一个“能工作的黑盒”。一旦它变慢或失败，问题立刻出现：

- 创建卡住 30 秒，是镜像没拉下来，还是 Pod 没调度，还是 execd 没起来？
- 命令报 `404`，是沙箱没了，还是端口没监听，还是路由走错了入口？
- 服务端日志里一切正常，为什么客户端还是连不上？
- 同事说“加个网络策略”，你不知道该改服务端配置、沙箱请求，还是集群里的 CRD。

这些问题的共同点是：**你不知道一次调用穿过了哪几层，所以不知道去哪一层找答案。**

本阶段要建立的，就是这张地图。学完后你应该能对任意一次调用回答三个问题：

1. 它从哪个入口进来？
2. 它在哪一层被处理，事实记录在哪里？
3. 它的结果通过哪条路径回来，失败时先看哪里？

本阶段不深挖状态机、不展开运行时实现、不设计网络策略——那些分别是阶段 2、4、5。这里只做一件事：**把边界画清楚。**

## 二、先用一个比喻建立骨架

把 OpenSandbox 想成一家“外派工作间”服务：

| 比喻 | 对应部件 | 它负责什么 |
| --- | --- | --- |
| 客户 | 应用 / Agent | 提出“我要执行这个动作” |
| 前台与调度中心 | 生命周期服务器 | 认证、登记、分配工作间、管理期限 |
| 供应商 | Docker / Kubernetes / FastSandbox | 真正把工作间搭出来 |
| 工作间 | 容器 / Pod / 微虚拟机 | 隔离的运行环境 |
| 工作间里的工头 | execd | 接收命令、文件、代码请求并执行 |
| 工作间自带的柜台 | 用户工作负载自己的端口 | 提供业务服务，例如 8080 |
| 大门与门禁 | ingress | 外部流量怎样找到某个工作间 |
| 物流安检 | egress sidecar | 工作间能往外部寄什么、收什么 |
| 合同 | `specs/` | 客户与平台之间固定的接口约定 |
| 监控与台账 | 状态、SSE、日志、指标、审计 | 证明“事情真的发生了” |

这个比喻有一个必须立刻纠正的地方：**调度中心不替你转接工作间的日常电话。**

创建沙箱要经过前台；创建完成后，应用拿到的是工作间的直接联系方式（端点），之后的命令、文件、代码请求直接找 execd，不再回到前台。把这一点想错，后面排错会全错。

## 三、六个实践面，加两个横切面

仓库目录很多，但按“职责面”分只有六类。以后每打开一个文件，先问它属于哪个面：

| 实践面 | 要解决的问题 | 主要目录 | 你会在这里遇到 |
| --- | --- | --- | --- |
| 客户端面 | 应用怎样使用平台 | `sdks/`、`cli/` | `Sandbox`、`osb`、MCP 工具 |
| 契约面 | 客户端和后端靠什么解耦 | `specs/` | 四份 OpenAPI、错误模型 |
| 生命周期控制面 | 环境何时创建、续期、删除 | `server/` | FastAPI 路由、`SandboxService` |
| 运行时后端 | 资源实际出现在哪里 | `server/.../docker`、`server/.../k8s`、FastSandbox 集成 | Container、Pod、微虚拟机 |
| 沙箱数据面 | 动作怎样真正发生 | `components/execd/` | `/command`、`/files`、`/code` |
| 网络与安全面 | 流量怎样进出、怎样受限 | `components/ingress/`、`components/egress/` | 端点、策略、凭据注入 |

再加两个横切面：

- **编排面**：`kubernetes/` 里的 Operator、`BatchSandbox`、`Pool`、`SandboxSnapshot`。它不直接面对 API 客户端，但决定了 Kubernetes 上资源怎样被创建和回收。
- **工程面**：测试、诊断、指标、发布与供应链验证。它不改变功能，但决定系统能不能被信任。

这张表要配合三条纵线使用，它们从阶段 0 一直贯穿到阶段 9：

1. **证据线**：状态、SSE 事件、退出码、日志、指标——成功与否只能由它们证明。
2. **信任线**：用户、模型、工具、沙箱、宿主机、外部网络，各自能控制什么。
3. **条件线**：看到“支持”时，追问哪个后端、什么配置、什么版本、什么镜像。

## 四、三种 API、三个端口、三种身份

平台对外看起来只有一个 URL，实际至少有三套接口。先把它们分开：

| API | 默认位置 | 谁访问 | 管什么 | 鉴权 |
| --- | --- | --- | --- | --- |
| 生命周期 API | `http://localhost:8080/v1` | SDK、CLI、MCP、受信任后端 | 创建、查询、续期、暂停、删除、快照、端点解析 | `OPEN-SANDBOX-API-KEY` |
| execd API | 沙箱端点上的 `44772` 端口 | SDK、受信任后端 | 命令、文件、Shell 会话、代码、PTY、指标 | 端点解析返回的 `X-EXECD-ACCESS-TOKEN`（启用时） |
| egress API | 沙箱端点上的 `18080` 端口 | SDK、受信任后端 | 出站策略与凭据保险箱 | 由端点解析决定 |

注意三件事：

1. **端口是“沙箱内语义端口”，不是固定地址。** Docker 下宿主机会映射到 40000–60000 的随机端口；Kubernetes 下可能是 Pod IP、Ingress 路径或服务器代理。`44772` 只说明“execd 在沙箱里的哪个端口”，不说明“你该连哪个主机”。
2. **鉴权头不是通用的。** 管理请求用 API Key；执行请求用端点解析给的令牌。拿 API Key 去调 execd、或拿 execd 令牌去调生命周期 API，都会失败。
3. **egress API 不是给普通用户直接用的入口。** 它通常由 SDK 或受信任后端在配置网络策略、注入凭据时调用；不要把它当作业务 API。

还有一个容易混淆的角色：**ingress 不是第四种 API。** 它不提供“创建/查询”能力，只是把外部 HTTP/WebSocket 流量路由到某个沙箱端口。同一个 execd 请求，可能直连、可能经 ingress、也可能走服务器代理——端点是同一个语义，地址和请求头由端点解析决定。

### 同一件事，四种地址形态

| 部署形态 | execd 的地址可能长什么样 | 关键点 |
| --- | --- | --- |
| Docker 直连 | `http://127.0.0.1:随机端口` | 端口由运行时映射，不能写死 |
| Kubernetes 直连 | `http://PodIP:44772` | 需要网络可达 |
| Kubernetes + ingress | `https://gateway.example.com/sandboxes/<id>/port/44772` 或带路由头 | 路径/请求头由网关约定 |
| 服务器代理兜底 | `http://server:8080/sandboxes/<id>/proxy/44772` | 兼容性路径，不是默认快路径 |

这张表现在只需记住结论：**不要自己拼地址，向生命周期 API 解析端点。** 阶段 5 会展开每种形态的细节。

## 五、两条路径：安排与使用

现在把主线切成两条路径。这是本阶段最重要的一张图：

```text
管理路径（低频、短请求、小数据）
  应用 / Agent
      │  Sandbox.create / get / renew / pause / kill
      ▼
  Python SDK（或 CLI / MCP）
      │  HTTPS + OPEN-SANDBOX-API-KEY
      ▼
  生命周期服务器 ── 认证、校验、状态机、TTL、端点解析
      │  选择运行时
      ▼
  Docker / Kubernetes / FastSandbox
      │
      ▼
  真实资源：容器 / Pod / 微虚拟机
      │
      └── 状态、端点、过期时间回到控制面，再回到 SDK


使用路径（高频、长连接、大数据）
  应用 / Agent
      │  sandbox.commands.run / files.read / code.run
      ▼
  SDK 服务对象（已绑定端点）
      │  一次端点解析，之后直接请求
      ▼
  execd（44772）或用户工作负载端口
      │  启动进程、读写文件、运行内核
      ▼
  SSE 事件 / 文件内容 / 退出码
      │
      └── 回到 SDK，聚合成 Execution 或文件对象
```

### 为什么要分成两条路径

这不是实现偷懒，而是四个现实约束共同作用的结果：

1. **频率不同。** 创建一个沙箱可能几分钟一次；执行命令可能每秒几次。把高频流量压给控制面，等于让登记处兼做生产线。
2. **连接模型不同。** 管理请求是短请求；命令输出是 SSE 长连接，终端是 WebSocket，可能持续几十分钟。
3. **数据量不同。** 创建请求只有几 KB；一次构建日志、一个文件下载可能是几十 MB。
4. **故障隔离不同。** 控制面挂了，已运行的沙箱仍应可执行；执行路径抖动，也不该让整个平台无法创建新环境。

代价也很明确：客户端必须多一步“解析端点”，并且要正确处理端点里的请求头、协议和过期时间。这个代价换来的是：控制面不必成为全平台带宽和连接数的瓶颈。

> **一句话记住：控制面负责“安排”，数据面负责“发生”。** 服务器代理是兼容性兜底，不是默认数据路径。

## 六、创建链路：从一次 `create` 到可用句柄

打开三个坐标，先只看入口，不读实现细节：

| 位置 | 先找什么 |
| --- | --- |
| `sdks/sandbox/python/src/opensandbox/sandbox.py` | `Sandbox.create`、`Sandbox._launch` |
| `server/opensandbox_server/api/lifecycle.py` | `create_sandbox` |
| `server/opensandbox_server/services/` | `SandboxService` 及各运行时实现 |

### 一次创建的九个步骤

| 步骤 | 发生位置 | 做了什么 | 你能观察到什么 |
| --- | --- | --- | --- |
| 1 | SDK | 校验 `image` 与 `snapshot_id` 二选一；补默认值 | 同时传两个会立刻抛参数错误 |
| 2 | SDK | 默认 `entrypoint=["tail","-f","/dev/null"]`、`timeout=10m`、资源 `1 CPU / 2Gi` | 不传也能创建，但默认值会进入请求 |
| 3 | SDK → 服务器 | `POST /v1/sandboxes`，带 API Key 和 JSON | 原始 HTTP 可见请求体 |
| 4 | 服务器中间件 | 认证、请求 ID、参数校验 | 401/400 在这一步返回 |
| 5 | 服务器服务层 | 按 `runtime.type` 选择 Docker / Kubernetes / FastSandbox | 服务端日志出现运行时选择 |
| 6 | 运行时 | 创建容器 / BatchSandbox / 模板沙箱，注入 execd，发布端点 | `docker ps` 或 `kubectl get` 可见资源 |
| 7 | 服务器 → SDK | 返回 `202 Accepted` 和 `id`、`status`、`createdAt`、`expiresAt`、`entrypoint` | 状态可能仍是 `Pending` |
| 8 | SDK | 轮询 `GET /sandboxes/{id}/endpoints/44772`（非模板沙箱还会解析 `18080`），构建服务对象 | 端点未发布时持续重试 |
| 9 | SDK | 调用 execd `GET /ping` 做健康检查，成功后返回 `Sandbox` | 默认 30 秒就绪预算、200ms 轮询间隔 |

### 三个必须理解的设计

**第一，HTTP 创建是异步的，SDK 的“同步感”是封装出来的。**

服务端返回 `202` 而不是 `200`，因为镜像拉取、Pod 调度、execd 启动都可能很慢。它先登记，再在后台推进。SDK 在 `create()` 内部继续等端点、做健康检查，所以调用者感觉像同步——但看原始 HTTP 响应，你会看到 `Pending`。

如果第一次查询就已经是 `Running`，只说明镜像已缓存、启动很快，不代表接口本身是同步的。

**第二，服务端不保存所有沙箱事实。**

Docker 容器、Kubernetes 的 `BatchSandbox`/Pod、FastSandbox 的 CR 才是运行时事实来源。服务端只持久化自己拥有的记录，例如快照元数据和模板目录。这样存储后端才能替换，故障恢复也才有边界。

直接后果：**服务端的数据库不是沙箱清单。** 查“现在有哪些沙箱”，最终要回到运行时；服务端进程重启后，仍要能通过运行时重建视图。

**第三，端点解析是契约，不是猜地址。**

SDK 不拼容器 IP，也不假设端口映射。它向生命周期 API 查询“这个沙箱的 44772 端口当前怎样访问”，并保留响应里的地址和请求头。换一种部署方式，地址会变，但客户端代码不用变。

### 创建失败时，SDK 会做什么

`_launch` 里有一段很容易被忽略但很重要的逻辑：如果沙箱已经创建出来，但后续端点解析或健康检查失败，SDK 会尝试调用 `kill_sandbox` 清理这个“半成品”，然后才抛出异常。

这解释了一个常见现象：**创建报错后，`docker ps` 里通常不会留下沙箱。** 但这只是 SDK 的尽力清理，不是平台保证；如果进程被强制杀死、或清理请求本身失败，仍可能留下孤儿资源。阶段 2 会把这条清理责任讲透。

## 七、执行链路：命令为什么不回到控制面

创建完成后，`Sandbox` 对象里已经绑定了若干服务对象。执行命令的调用链是：

| 步骤 | 发生位置 | 做了什么 |
| --- | --- | --- |
| 1 | 应用 | `await sandbox.commands.run("...")` |
| 2 | SDK 服务层 | 组装命令、参数、超时、工作目录、环境变量、用户身份 |
| 3 | SDK 适配层 | `POST {execd 端点}/command`，带上端点解析得到的请求头 |
| 4 | execd | 校验参数，启动进程（shell 或原生 argv） |
| 5 | execd → SDK | 通过 SSE 持续发送 stdout、stderr、结果和完成事件 |
| 6 | SDK | 聚合为 `Execution`：输出分片、退出码、错误、命令 ID |
| 7 | 应用 | 自己判断成功：退出码、错误、输出内容共同决定 |

相关源码坐标：

- `sdks/sandbox/python/src/opensandbox/services/command.py`
- `sdks/sandbox/python/src/opensandbox/adapters/command_adapter.py`
- `components/execd/pkg/web/router.go`
- `components/execd/pkg/web/controller/command.go`

### 为什么不让服务器代理所有执行

因为执行路径的三个特征与控制面相反：高频、长连接、大流量。

如果所有命令都经过生命周期服务器：

- 创建/查询的管理流量会和命令流式输出争抢同一批连接和线程；
- 服务器要替每个沙箱转发几十 MB 的日志和文件，成为带宽瓶颈；
- 一个长连接超时策略会同时影响管理和执行，故障域被合并；
- 水平扩展控制面时，还要保证执行连接粘在同一个副本上。

所以默认设计是：控制面只负责“告诉你去哪执行”，执行本身由客户端直连数据面。服务器代理路径仍然保留，用于客户端无法直连沙箱的部署，但它是兼容性兜底。

### 执行链路的一个常见错觉

“HTTP 200 就代表命令成功”是错的。execd 的流式响应返回 200，只说明请求被接受并开始执行；命令可能随后以非零退出码结束，也可能在输出到一半时连接断开。

判断成功至少要同时看：

- `execution.exit_code` 是否为 0；
- `execution.error` 是否为空；
- `execution.logs.stdout` 和 `stderr` 是否完整（是否收到完成事件）。

阶段 3 会把 `Execution` 的每个字段和 SSE 事件逐一对上。

## 八、端点解析：把“地址”变成契约

原始 HTTP 调用端点解析，返回体很小，但信息密度很高：

```json
{
  "endpoint": "http://127.0.0.1:32768",
  "headers": {
    "X-EXECD-ACCESS-TOKEN": "..."
  }
}
```

当前契约里，响应体只有 `endpoint` 和 `headers` 两个字段。几件容易踩错的事：

1. **`headers` 不是装饰。** 启用访问令牌时，不带这些头，execd 会拒绝请求。客户端应把 `headers` 原样附加到后续请求，而不是只取 `endpoint`。
2. **`endpoint` 是基地址。** 命令接口是 `{endpoint}/command`，文件接口是 `{endpoint}/files/...`；不要假设它一定以 `/` 结尾，也不要在它后面再拼 `/v1`。
3. **来源信息在响应头里。** 对 `fsb-` 前缀的模板沙箱，服务端会在端点解析响应中加 `OPEN-SANDBOX-ORIGIN: template`。SDK 用这个信号决定出站策略走沙箱 sidecar 还是控制面。原始 HTTP 里它不在 JSON 体内，容易漏看。
4. **`use_server_proxy=true` 会换一种地址。** 返回的 `endpoint` 变成 `/sandboxes/{id}/proxy/{port}`，请求头可能被调整。它适合客户端无法直连沙箱的环境，但会多一跳。
5. **`expires` 会签发带时效的路由。** 这是 secure access 的入口，阶段 5 展开；现在只需知道端点可以是有期限的。

还有一个边界要提前建立：**端点可达 ≠ 沙箱健康。** 端点解析成功只说明路由存在；execd 可能还没 ready、令牌可能不对、目标端口可能没有监听。健康检查是独立的一步。

## 九、实验：用原始 HTTP 看见两条路径

目标不是“跑通”，而是亲眼看到 `202`、`Pending`、端点响应、SSE 和 `204`。SDK 会把这些细节藏起来，所以本实验全部用 `curl.exe`。

先确保阶段 0 的服务端还在运行，并准备两个变量：

```powershell
$base = "http://127.0.0.1:8080/v1"
$headers = @{ "OPEN-SANDBOX-API-KEY" = "dev-secret" }
```

### 实验 1 · 创建并观察 202 与 Pending

把请求体写进文件，避免 PowerShell 引号把 JSON 弄坏：

```powershell
@'
{
  "image": { "uri": "alpine:3.20" },
  "entrypoint": ["tail", "-f", "/dev/null"],
  "timeout": 600,
  "resourceLimits": { "cpu": "500m", "memory": "512Mi" },
  "metadata": { "lesson": "stage-1" }
}
'@ | Set-Content -Encoding utf8 .\create.json
```

创建并记录 HTTP 状态：

```powershell
$response = curl.exe -s -D .\create.headers -o .\create.body `
    -X POST "$base/sandboxes" `
    -H "OPEN-SANDBOX-API-KEY: dev-secret" `
    -H "Content-Type: application/json" `
    --data-binary "@create.json"

Get-Content .\create.headers | Select-Object -First 1
$created = Get-Content .\create.body -Raw | ConvertFrom-Json
$created | ConvertTo-Json -Depth 8
$id = $created.id
```

**要观察**：

- 第一行状态码是否是 `202`；
- `status.state` 是 `Pending` 还是 `Running`；
- `expiresAt` 是否是“现在 + 10 分钟”；
- `entrypoint` 是否原样回显。

紧接着查一次：

```powershell
Invoke-RestMethod -Uri "$base/sandboxes/$id" -Headers $headers |
    ConvertTo-Json -Depth 8
```

如果第一次就是 `Running`，删掉沙箱、换一个没缓存的镜像再试一次；你要看到的是“创建”和“就绪”在时间上分开，而不是每次都必须看到 `Pending`。

### 实验 2 · 解析端点，直接调用 execd

```powershell
$execd = Invoke-RestMethod -Uri "$base/sandboxes/$id/endpoints/44772" -Headers $headers
$execd | ConvertTo-Json -Depth 6

# 把端点返回的请求头原样带上
$execdHeaders = @()
if ($execd.headers) {
    $execd.headers.PSObject.Properties | ForEach-Object {
        $execdHeaders += @("-H", "$($_.Name): $($_.Value)")
    }
}
curl.exe -i "$($execd.endpoint)/ping" @execdHeaders
```

**要观察**：`ping` 的响应是否来自 `44772` 这一侧，而不是生命周期服务器。此时你已经在走数据面路径。

再解析一次 egress 端口，确认非模板沙箱有两个数据面端点：

```powershell
Invoke-RestMethod -Uri "$base/sandboxes/$id/endpoints/18080" -Headers $headers |
    ConvertTo-Json -Depth 6
```

模板沙箱（`fsb-` 前缀）没有沙箱侧 egress sidecar，这一步会失败或走控制面；当前 Docker 实验环境不会遇到。

### 实验 3 · 用原始 HTTP 跑一条命令，看 SSE

```powershell
@'
{
  "command": "echo out-line; echo err-line 1>&2; exit 3",
  "timeout": 10000
}
'@ | Set-Content -Encoding utf8 .\command.json

curl.exe -N -X POST "$($execd.endpoint)/command" @execdHeaders `
    -H "Content-Type: application/json" `
    --data-binary "@command.json"
```

**要观察**：

- 连接先返回 `200`，随后不断有 `data:` 事件；
- stdout 与 stderr 是不同事件；
- 最后有完成事件，并且退出码是 `3`；
- 尽管命令“失败”，HTTP 层并没有返回 500。

这就是前面说的：**传输成功不等于命令成功。**

### 实验 4 · 换一条路径：服务器代理

```powershell
$proxied = Invoke-RestMethod `
    -Uri "$base/sandboxes/$id/endpoints/44772?use_server_proxy=true" `
    -Headers $headers
$proxied.endpoint
```

对比直连地址和代理地址。两者都能执行，但前者是默认快路径，后者多经过一次服务器转发。这个区别在阶段 5 讨论 ingress 与代理时会再次出现。

### 实验 5 · 清理

```powershell
curl.exe -i -X DELETE "$base/sandboxes/$id" -H "OPEN-SANDBOX-API-KEY: dev-secret"
```

**要观察**：删除返回 `204`，不是 `200`；随后再查同一个 ID，应得到 `404`。如果运行在 Kubernetes 上，删除后可能短暂看到 `Stopping`，阶段 2 会解释。

### 记录表

把观察结果填进自己的笔记：

| 观察项 | 你的记录 |
| --- | --- |
| 创建 HTTP 状态 | |
| 首次查询状态 | |
| 从创建到 `Running` 的耗时 | |
| 端点响应里的字段名 | |
| `ping` 是否需要请求头 | |
| 命令的 HTTP 状态与退出码 | |
| 删除的 HTTP 状态 | |

## 十、失败点清单：把“出错”翻译成“哪一层”

这张表是本阶段最实用的产出。以后遇到问题，先定位层，再决定看哪里：

| 失败点 | 典型现象 | 所在层 | 先看什么 |
| --- | --- | --- | --- |
| 地址或域名错误 | 连接被拒绝 / 超时 | 客户端 | `ConnectionConfig.domain`、端口、代理设置 |
| API Key 错误 | `401` | 控制面入口 | 服务端配置与客户端密钥是否一致 |
| 请求体不合法 | `400` | 契约/校验 | 响应错误码；镜像模式是否漏了 `entrypoint`、资源限制 |
| 镜像拉取失败 | 创建超时或 `Failed` | 运行时 | `docker ps -a`、服务端日志、镜像仓库权限 |
| 池容量耗尽 | `429` + `Retry-After` | 编排层 | Pool 状态、并发预算；阶段 4 展开 |
| 端点迟迟不发布 | SDK 等待超过预算 | 控制面/网络 | 状态是否 `Pending`、端口是否监听、sidecar 是否就绪 |
| 健康检查失败 | `READY_TIMEOUT` / `UNHEALTHY` | 数据面 | execd 日志、`/ping`、端点请求头、网络策略 |
| 命令 `404` | 端点存在但路径错 | 数据面/入口 | 是否把 `/v1` 拼到了 execd 地址上 |
| SSE 中断 | 输出不完整、连接被重置 | 数据面/传输 | 代理超时、命令状态、日志游标 |
| 退出码非零 | 有输出但业务失败 | 用户进程 | `exit_code`、`stderr`、`execution.error` |
| TTL 到期 | 执行中途断开 | 生命周期 | `expiresAt`、续期记录 |
| 删除后仍可见 | 短暂 `Stopping` | 编排层 | Kubernetes 删除与任务清理；不是“没删掉” |
| 文件不存在 | `404` 或空结果 | 数据面 | 路径、工作目录、文件身份（阶段 3） |

### 排查顺序口诀

**先入口，再对象，再端点，再执行，再策略，最后业务。**

1. 入口：域名、端口、密钥——先排除 401 和连接拒绝。
2. 对象：沙箱是否存在、处于什么状态——排除“对象已经没了”。
3. 端点：解析是否成功、请求头是否带上——排除“地址不对”。
4. 执行：execd 是否健康、命令本身是否成功——排除“动作失败”。
5. 策略：网络是否被拒绝、凭据是否注入——排除“环境限制”。
6. 业务：最后才怀疑用户代码或模型输出。

这张表不是错误大全，而是导航。后面每学一个阶段，都往里面补几行。

## 十一、画两张图（本阶段的核心作业）

不要跳过这一步。看懂别人的图和自己画出来，是两种完全不同的掌握程度。

### 图 A · 创建时序图

必须包含这些角色和消息：

```text
应用 → SDK: create(image, timeout, resource)
SDK → 生命周期服务器: POST /v1/sandboxes
生命周期服务器 → 运行时: 创建资源 + 注入 execd
运行时 --> 生命周期服务器: 资源已创建，端点待发布
生命周期服务器 --> SDK: 202 + id + Pending
SDK → 生命周期服务器: GET .../endpoints/44772（轮询）
生命周期服务器 --> SDK: endpoint + headers
SDK → execd: GET /ping
execd --> SDK: 200
SDK --> 应用: 可用的 Sandbox 句柄
```

在图旁标出三个时刻：**登记完成**、**端点发布**、**健康确认**。这三个时刻不是同一件事。

### 图 B · 执行时序图

```text
应用 → SDK: commands.run(command)
SDK → execd: POST /command（带端点请求头）
execd → 用户进程: 启动并执行
用户进程 --> execd: stdout / stderr / 退出码
execd --> SDK: SSE 事件流
SDK --> 应用: Execution（输出 + 退出码 + 错误）
```

在图旁标出：**哪些流量经过控制面，哪些不经过。** 如果两条线画成了一条直线，说明还没有把“安排”和“发生”分开。

## 十二、常见误区

| 误区 | 更准确的理解 |
| --- | --- |
| “`Sandbox.create()` 是同步接口” | 服务端创建是异步的；SDK 替你先等端点、再做健康检查，所以看起来同步。 |
| “所有请求都经过生命周期服务器” | 只有管理请求默认经过；执行走数据面。服务器代理是兜底。 |
| “端点解析成功就说明沙箱可用” | 端点只证明路由存在；健康、鉴权、端口监听都要另行确认。 |
| “execd 就是用户的工作负载” | execd 是与用户负载并行的守护进程，提供执行 API；两者不是一回事。 |
| “服务端数据库里能查到所有沙箱” | 运行时才是事实来源；服务端只持久化自己拥有的记录。 |
| “`specs/` 里有，就代表当前环境能用” | 还要看后端、配置、版本和镜像；阶段 4 会反复训练这一点。 |
| “HTTP 200 就代表命令成功” | 200 只代表请求被接受；成功要看退出码、错误和完整输出。 |

## 十三、通关自检（含参考答案）

先合上文档回答，再对照。

**1. 为什么创建返回 `202`，而 SDK 调用起来像同步？**

`202` 表示“已接受、正在处理”。Pod 调度、镜像拉取、execd 启动都可能耗时，服务端不应把 HTTP 请求挂住。SDK 在返回前继续轮询端点并做健康检查，把异步过程封装成了看似同步的调用。

**2. 为什么命令执行不经过生命周期服务器？**

执行是高频、长连接、大流量的路径。让控制面代理会把管理流量和执行流量耦合在一起，并让服务器成为带宽与连接瓶颈。控制面只负责解析端点，执行由客户端直连数据面。

**3. 端点解析响应里有哪些关键信息？为什么不能只取地址？**

当前响应体包含 `endpoint` 和 `headers`。启用访问令牌时，`headers` 是请求的一部分，漏掉就会 401/403。另外，模板沙箱的来源信息在 `OPEN-SANDBOX-ORIGIN` 响应头里，不在 JSON 体内。

**4. 服务端为什么不保存所有沙箱记录？**

因为容器、Pod、微虚拟机才是运行时的真实状态，服务端如果复制一份，就会面临双写不一致、故障恢复和存储后端绑定问题。服务端只持久化自己拥有的记录（如快照元数据、模板目录），沙箱事实回到运行时查询。

**5. `404`、`503`、`502` 分别可能意味着什么？**

在入口网关的语义里：`404` 通常表示沙箱不存在或已消失；`503` 表示沙箱存在但还没准备好、没有可达端点；`502` 表示基础设施层失败（例如集群 API 出错）。具体到某条链路，还要结合是哪个入口返回的。

**6. 沙箱还在 `Pending` 时，能执行命令吗？**

通常不能。端点还没发布，SDK 的 `create()` 也还没返回。即使强行拿到了某个地址，execd 也未必已经启动或 ready。`Pending` 的含义就是“资源在安排中，尚不可用”。

**7. 命令有输出，但业务判断失败，应该看哪三个字段？**

`exit_code`（是否为 0）、`error`（是否有执行错误）、以及 stdout/stderr 是否完整。只看 `execution.text` 或“有没有输出”都不够。

**8. 为什么模板沙箱的执行链路一样，出站策略却不同？**

模板沙箱（`fsb-` 前缀）运行在预构建镜像上，没有沙箱侧的 egress sidecar，所以策略操作走控制面；SDK 通过端点响应里的 `OPEN-SANDBOX-ORIGIN: template` 识别这一点，并切换 egress 服务实现。执行仍然直连 execd，所以链路看起来一样。

### 完成清单

- [ ] 不看资料画出六面图，并能说出每个面对应哪个目录。
- [ ] 画出创建时序图，标出 `202`、`Pending`、端点发布和健康检查。
- [ ] 画出执行时序图，说明为什么执行默认绕过生命周期服务器。
- [ ] 用原始 HTTP 走通创建、查询、端点解析、命令和删除。
- [ ] 能解释服务端为什么不保存所有沙箱记录。
- [ ] 能解释端点响应为什么必须保留 `headers`。
- [ ] 列出至少 8 个失败点，并说清各自属于哪一层。
- [ ] 能用 10 分钟讲清“控制面安排、数据面执行、网络面治理”。

## 十四、做完之后

现在你有了地图：知道一次调用穿过哪些层，知道创建和执行是两条路径，也知道失败时先看哪里。

但地图还没有回答一个更根本的问题：**这些环境由谁拥有、什么时候算真正结束？**

SDK 返回了句柄，不等于资源归你管；`close()` 了，也不等于远端已经消失；TTL 到期、进程崩溃、用户取消，是三条不同的回收路径。下一阶段专门处理这件事，并把它们写成一个在成功、异常、取消三条路径都能正确清理的封装。

带着这个问题进入下一章：**“我创建了它，但谁保证它一定会被销毁？”**

进入[阶段 2](../stage-2/)。

---

*配套[学习路线](../learning-path/)阶段 1 编写 · 2026-10-30 · 基于 release-1.1.1（`531700ca`）*
