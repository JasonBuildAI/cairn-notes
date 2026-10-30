---
title: "阶段 5：网络与凭据"
description: "端点、ingress、egress 与 Vault：默认关闭的三道门。"
---

> 本阶段回答：外部怎样访问沙箱？沙箱可以访问谁？密钥怎样做到“用了但拿不到”？
> 预计 3–4 天。核心产出是一页**网络策略设计**（默认动作、允许目标、凭据绑定、失败策略、审计项），而不是只会写一条 allow 规则。

## 为什么需要这一步

阶段 4 结束时，沙箱已经能跑起来，execd 也能执行命令。但“能跑”离“能安全地联网”还有三道门：

```text
第一道：谁能进来找到它？        -> ingress
第二道：它能出去找谁？          -> egress
第三道：它出门办事，钥匙给谁？  -> Credential Vault
```

这三道门如果只做对一道，另外两道就会成为漏洞：

- 只做 ingress：沙箱可以自由访问外网，模型一条 `curl` 就能把数据发走。
- 只做 egress：外部无法访问沙箱里的服务，Agent 做不了 Web 应用预览。
- 两道都做但不做凭据代理：为了调 API，只能把真实密钥塞进环境变量，沙箱里的任何进程都能读走。

更麻烦的是，这三道门都**不是“配置了就有”**，而是带条件的：运行时、网络模式、创建时是否声明策略、服务端是否启用代理、版本是否够。阶段 4 建立的“能力条件”意识，在这里会第一次真正派上用场。

先记住一张总表：

| 能力 | 解决的问题 | 不是万能的 |
| --- | --- | --- |
| Ingress | 外部怎样访问沙箱内的端口 | 不负责出站安全 |
| Egress | 沙箱能访问哪些外部目标 | 需要正确模式，且创建时就要附加 sidecar |
| Credential Vault | 密钥怎样不进入沙箱 | 不是加密文件柜，也不覆盖所有后端 |

## 一个比喻：三道门与一个前台

把沙箱想成一间外派工作间：

```text
访客门（ingress）：客户要进来谈事，需要有门牌号，还要前台带路
货运门（egress） ：工作间要收快递、发快递，但只能走白名单的地址
前台代刷（vault） ：要调用外部服务时，由前台拿真门卡去刷
                   工作间里的人只拿到一张写着“已授权”的纸条
```

这个比喻能解释几个真实行为：

- 门牌号不是固定的：端点要**解析**，不能写死。
- 访客进不来时，要分清是“没这间房”（404）、“房间还没准备好”（503）还是“大楼基础设施坏了”（502）。
- 货运门是默认关的：不加策略，不代表“什么都允许”，而代表“没有这条通道”。
- 前台代刷的前提是“访客门已经按规矩登记过”，所以 Vault 要求创建时就带网络策略。

## 步骤 1 · 先画清四条链路

### 入站

```text
客户端
  -> ingress gateway（或 server 代理）
  -> 沙箱内目标端口
```

Kubernetes 沙箱通常是 ClusterIP-only，客户端不能假设能直连 Pod IP。网关负责把“沙箱 ID + 端口”翻译成真实后端。

### 出站

```text
沙箱进程 -> DNS / 网络栈 -> egress sidecar -> 目标服务
```

egress sidecar 与沙箱**共享网络命名空间**，在数据路径上执行策略。它不是“另一个容器帮你转发”，而是“你所有出站流量的必经之门”。

### 凭据代理

```text
可信控制面 -> 真实凭据写入 egress sidecar 内存
沙箱进程   -> 只看到 fake/empty 值或占位符
出站 HTTPS -> sidecar 匹配绑定并注入认证头
上游服务   -> 收到真实认证信息
```

### 端点解析

```text
sandbox.get_endpoint(port)
  -> {"endpoint": "...", "headers": {...}}
  -> 客户端按返回的地址和头访问
```

四条链路合起来才是“能联网”的完整定义。任何一条缺失，都要在文档里写成条件，而不是写成“支持”。

## 步骤 2 · 端点解析：不要写死地址

很多“本地能跑、集群里 404”的问题，根因是把地址写死了。Docker 是端口映射，Kubernetes 是 Service/网关，FastSandbox 又走另一套入口；同一个端口号在不同拓扑下含义不同。

正确顺序：

```text
1. 调 get_endpoint(port)
2. 用返回的 endpoint 和 headers
3. 需要长连接时确认协议与超时
4. 需要对外分享时用限时签名路由，而不是长期 token
```

### 返回结构

1.1.1 的端点响应是：

```json
{
  "endpoint": "http://...",
  "headers": {
    "OpenSandbox-Ingress-To": "..."
  }
}
```

要点：

- **`endpoint` 和 `headers` 要一起用。** 只拿 URL、不带头，网关可能不知道该路由到哪个沙箱端口。
- 不同部署下 `headers` 可能为空；不要假设一定有某个头。
- 同一个沙箱的不同端口要分别解析，不能拿 44772 的地址去访问 8000。

### server 代理模式

请求端点解析时可以要求走 server 代理（`use_server_proxy=true`）。此时服务端会把端点改写为：

```text
/sandboxes/{id}/proxy/{port}
```

并去掉 ingress 路由头。这条路径的好处是客户端不需要理解网关拓扑；代价是流量多经过一跳 server，容量和超时都受 server 约束。

### 模板沙箱的来源标记

`fsb-` 开头的沙箱在端点响应里会带 `OPEN-SANDBOX-ORIGIN: template` 这样的来源头。它不是装饰：客户端和运维要靠它区分“这条沙箱走的是模板/FastSandbox 路径”，从而知道哪些能力（例如沙箱侧 Vault）不适用。

### 签名路由

开启 secure access 后（Kubernetes + gateway 模式），端点可以带过期时间，换取一条限时签名路由。它适合“把这个服务临时分享给浏览器或第三方”，不适合当作长期 API 地址。签名过期后要重新解析，而不是重用旧 URL。

## 步骤 3 · 入站：路由模式与三种错误

### 三种路由模式

`[ingress.gateway].route.mode` 支持：

| 模式 | 怎么找到目标 | 适合 |
| --- | --- | --- |
| `header` | 请求头携带 sandbox+port | 能自定义 header 的 SDK/客户端 |
| `uri` | 路径前两段是 `/<sandbox-id>/<port>/...` | 不能改 header 的浏览器/简单客户端 |
| `wildcard` | 主机名编码 sandbox+port，需要通配域名 | 每个沙箱一个子域名的部署 |

header 模式的取值形如：

```text
OpenSandbox-Ingress-To: <sandbox-id>-<port>
```

但**不要假设默认模式**。它由服务端配置决定，客户端应该以 `get_endpoint()` 返回的 `endpoint + headers` 为准。写死“一定是 header 模式”的代码，换一个部署就会坏。

### 三种错误，三条排查路径

| 状态 | 含义 | 先查 |
| --- | --- | --- |
| `404` | 沙箱不存在或已删除 | ID、TTL 是否过期、是否走了错误命名空间 |
| `503` | 沙箱存在，但还没有可用端点 | Pod/容器是否 Ready、execd 端口是否监听 |
| `502` | 基础设施或集群 API 层失败 | 网关到后端的连接、Service/Endpoint、网关日志 |

三者不能统一重试：404 重试没有意义，503 应该退避等待，502 要查基础设施。

### WebSocket

WebSocket 是一等能力，但有边界：

- 单条消息上限 64 MiB。
- 升级走 HTTP/1.1。
- 如果前置 TLS 代理只支持 HTTP/2，升级可能到不了 ingress。

这也是“端点解析”要带上协议信息的原因：不是所有端点都适合同一种客户端。

## 步骤 4 · 出站：默认拒绝，显式允许

### 先确认 sidecar 在不在

这是本阶段最重要的一句话：

> **只有创建请求带 `networkPolicy`（或模板/Pool 在预创建时固定了策略）时，平台才会为该沙箱准备出站控制。**

所以下面这条路径通常是走不通的：

```text
先创建一个完全开放网络的沙箱
  -> 再想 patch 一条 egress 规则
  -> 发现没有执行面
```

egress 不是“运行中的开关”，而是“创建时的附加物”。需要出站治理，就在创建时声明。

### 策略模型

Python SDK 的模型是 `NetworkPolicy(default_action=..., egress=[NetworkRule(...)])`，默认动作是 `deny`：

```python
from datetime import timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig
from opensandbox.models.sandboxes import NetworkPolicy, NetworkRule

config = ConnectionConfig(
    domain="localhost:8080",
    api_key="dev-secret",
    request_timeout=timedelta(seconds=60),
)

policy = NetworkPolicy(
    default_action="deny",
    egress=[
        NetworkRule(action="allow", target="pypi.org"),
        NetworkRule(action="allow", target="*.pythonhosted.org"),
    ],
)

sandbox = await Sandbox.create(
    "python:3.12",
    connection_config=config,
    timeout=timedelta(minutes=15),
    network_policy=policy,
)
```

### 验证要正反都做

先验证允许路径：

```python
allowed = await sandbox.commands.run(
    ["python3", "-c",
     "import urllib.request; print(urllib.request.urlopen('https://pypi.org', timeout=5).status)"]
)
print(allowed.exit_code, allowed.text, allowed.error)
```

再验证拒绝路径：

```python
blocked = await sandbox.commands.run(
    ["python3", "-c",
     "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)"]
)
print(blocked.exit_code, blocked.text, blocked.error)
```

不要只看 `execution.text`：它不包含 stderr。退出码和 `error` 才是判断依据（阶段 3 已经讲过这套语义）。

### 优先级：平台的 deny 永远压过你的 allow

官方文档给出的匹配顺序：

```text
平台 deny.always
  -> 平台 allow.always
    -> 用户规则
```

含义很直接：

- 管理员禁止的目标，你写 allow 也覆盖不了。
- 管理员强制允许的目标，可能在你默认拒绝时仍然可通。
- 运维 overlay 可能热更新，所以你看到的“生效策略”不一定等于你提交的那份 JSON。

这解释了一个常见困惑：“我明明只允许了 A，为什么 B 也能通？”先查平台级 allow，而不是怀疑自己的规则写错。

## 步骤 5 · `dns` 与 `dns+nft`：强度不同，边界不同

| 模式 | 做什么 | 能防什么 | 防不住什么 |
| --- | --- | --- | --- |
| `dns`（默认） | 拦截/解析 DNS，未允许的域名返回 NXDOMAIN | 普通按域名访问 | 应用直接使用 IP、绕过 DNS 的路径；CIDR/IP 规则不生效 |
| `dns+nft` | DNS 过滤 + nftables 默认丢弃，按解析结果临时放行 | 更严格的包级默认拒绝，支持 CIDR/IP 约束 | 配置错误的放行、应用层数据外泄、所有非网络风险 |

一句话记住：

> **只限制 DNS，不等于只允许某个域名。** 如果代码直接连 `203.0.113.10`，DNS 层根本没有参与。

选择建议：

- 只关心“能不能解析并访问这些域名” → `dns` 够用。
- 需要静态 IP/CIDR 约束，或要做凭据代理 → `dns+nft`。
- 使用 `dns+nft` 前确认后端、内核与运行时支持。

`[egress]` 还有几个与条件相关的配置：

- `image`：客户端发送 `networkPolicy` 时**必需**。
- `mode`：默认 `dns`；凭据代理要求 `dns+nft`。
- `disable_ipv6`：默认 `true`，因为 IPv6 出站（尤其 Kubernetes）还不完整。
- `upstream_proxy`：让 egress 链到上游 HTTP(S) CONNECT 代理，要求 `dns+nft`。
- `readiness_timeout_seconds`：Docker 下等待 sidecar 健康的时长。

## 步骤 6 · 运行时修改：合并，不是替换

创建后可以增量修改规则：

```python
await sandbox.patch_egress_rules([
    NetworkRule(action="allow", target="files.pythonhosted.org"),
])

current = await sandbox.get_egress_policy()
print(current.default_action, current.egress)
```

必须理解语义：

- **patch 是合并。** 新规则覆盖相同 target 的旧规则，其他 target 保留。
- **patch 不改 `default_action`。** 不要以为打一条 allow 就把默认拒绝变成了允许。
- **删除是幂等的。** `delete_egress_rules(targets)` 对不存在的 target 不报错。

运行时 mutation 适合短期、受控的放行，不适合让模型“给自己开网”。如果模型能调用 patch 工具，仍然需要服务端审批、目标白名单和审计记录。

## 步骤 7 · Credential Vault：让秘密留在 sidecar

### 目标不是“加密后塞进去”

Vault 的目标是让沙箱里的进程**根本拿不到真实秘密**：

```text
沙箱进程看到：fake/empty 值或占位符
出站请求到达 sidecar：匹配绑定，注入真实认证头
上游服务收到：真实凭据
```

所以判断一个实现对不对，只看一个问题：**真实值有没有进入沙箱的文件、环境变量或进程内存？** 如果进了，就绕开了这层保护。

### 前置条件（缺一不可）

- 服务端 `[egress].mode = "dns+nft"`；
- 创建时带出站 `networkPolicy`；
- 创建时启用 `credential_proxy=CredentialProxyConfig(enabled=True)`；
- 网络策略推荐默认拒绝，并显式允许绑定目标主机；
- 沙箱 Pod 不能同时有透明 service mesh sidecar；
- 后端与 SDK 版本达到文档要求（egress >= 1.1.1；示例配置使用 `opensandbox/egress:v1.1.7`，组件标签与 umbrella 版本不是同一层概念）。

创建示例：

```python
from opensandbox.models.sandboxes import CredentialProxyConfig

sandbox = await Sandbox.create(
    "python:3.12",
    connection_config=config,
    timeout=timedelta(minutes=15),
    network_policy=NetworkPolicy(
        default_action="deny",
        egress=[NetworkRule(action="allow", target="api.example.com")],
    ),
    credential_proxy=CredentialProxyConfig(enabled=True),
)
```

写入凭据与绑定：

```python
from opensandbox.models.sandboxes import Credential, CredentialBinding

await sandbox.credential_vault.create(
    credentials=[
        Credential(name="api-token", source={"value": "REAL_SECRET_VALUE"})
    ],
    bindings=[
        CredentialBinding(
            name="example-api",
            match={
                "schemes": ["https"],
                "hosts": ["api.example.com"],
                "methods": ["GET", "POST"],
                "paths": ["/v1/*"],
            },
            auth={"type": "bearer", "credential": "api-token"},
        )
    ],
)
```

真实值只应在可信后端读取和写入；不要打印到日志、放进模型上下文或写进沙箱文件。保险箱 API 返回的是脱敏元数据，不要期待它回显 secret。

### 绑定匹配与替换

绑定可以匹配 scheme、host、method、path，认证类型支持 `bearer`、`basic`、`apiKey`、`customHeaders`、`passthrough` 等。

`passthrough` 可以配合 `substitutions` 在 path/query/header/body 中替换占位符，解决“某些 API 只在 URL 或表单里接收凭据”的问题。但替换是**精确、区分大小写、有作用域**的，不要把它当成任意模板引擎。

### 三个失败边界

1. **暂停/恢复后要重新注入。** 秘密只在 sidecar 内存，恢复成功不等于 secret 自动回来。恢复后 401，优先怀疑这一条。
2. **模板沙箱没有沙箱侧 Vault。** 对 `template` 来源访问 `sandbox.credential_vault` 会显式抛异常；不要把平台级 egress 和沙箱侧 Vault 混写。
3. **sidecar、控制面、日志仍是信任边界。** “密钥没进沙箱环境变量”不等于“系统没有密钥风险”。

## 步骤 8 · 网络隔离与运行时条件

### 这里说的 `networkPolicy` 不是 Kubernetes NetworkPolicy

OpenSandbox 的 `networkPolicy` 是**发给出站 sidecar 的策略模型**，不是 Kubernetes 原生的 `NetworkPolicy` 资源。两者名字相同，作用层不同：

| | OpenSandbox `networkPolicy` | Kubernetes `NetworkPolicy` |
| --- | --- | --- |
| 作用 | 沙箱出站目标与凭据注入 | Pod 间/命名空间网络访问控制 |
| 执行者 | egress sidecar | CNI 插件 |
| 声明时机 | 创建请求 / 模板 / Pool | 集群资源，独立于沙箱 API |

混淆会导致错误的排查方向：你在创建请求里写了 `networkPolicy`，不会自动生成一个 K8s NetworkPolicy；反过来，集群管理员配的 K8s 策略也不会出现在 `get_egress_policy()` 里。

### 与运行时/隔离层的冲突

- **透明 service mesh sidecar** 与 egress 在同一网络命名空间会发生重写冲突，不能当成可叠加的默认组合。
- **gVisor 的 netstack** 不支持 egress 的重定向机制；选择 gVisor 时要重新验证网络方案，而不是假设“换个隔离运行时，其余不变”。
- **Docker** 要使用 egress，必须 `network_mode = "bridge"`；`host` 模式没有独立网络命名空间可插入。
- **Pool** 的 Pod 在请求前已存在，网络策略必须随模板固定，不能按请求注入。

### 失败要 fail-closed

设计中要明确回答：如果 egress sidecar 崩溃，是拒绝还是放行？正确答案是**安全失败**，而不是静默直通。同理，策略解析失败、上游不可达、DNS 超时，都应该让请求失败得可解释，而不是悄悄放宽。

## 步骤 9 · 实验

> 说明：本环境没有运行中的 Docker daemon、egress 镜像和 Kubernetes 集群，D 系列需要可运行的 Docker 服务端；K 系列需要真实集群。未执行的实验请标注“未验证”，不要把接口存在写成已验证。

### 实验 D1 · 端点是解析出来的，不是猜出来的

创建沙箱后，分别解析两个端口：

```python
ep_exec = await sandbox.get_endpoint(44772)
ep_app = await sandbox.get_endpoint(8000)
print(ep_exec.endpoint, ep_exec.headers)
print(ep_app.endpoint, ep_app.headers)
```

比较两次返回：地址是否相同、headers 是否相同。然后尝试用 `ep_exec` 的地址访问 8000 端口，观察失败形态。结论应该是：**端口不是路径参数，是独立的端点。**

### 实验 D2 · 默认拒绝的正面与反面

用步骤 4 的策略创建沙箱，分别访问 `pypi.org` 和 `example.com`，记录退出码、stderr 和耗时。

再做一次对照：把 `default_action` 改成 `allow`，只保留同一个 allow 规则，观察未列出的目标是否可通。这个对照能让你体会“默认动作”才是策略的主开关。

### 实验 D3 · 用 IP 绕过 DNS（只读推演）

在 `dns` 模式下，策略允许 `pypi.org`，然后执行：

```bash
python3 -c "import socket; print(socket.gethostbyname('pypi.org'))"
```

拿到 IP 后，直接连接该 IP（例如用 `curl --resolve` 或直接 URL）。观察在 `dns` 模式下是否仍然可通，再切到 `dns+nft` 对比。

如果环境不具备 nftables 条件，就写一段推演：DNS 层看到的是什么、包级层看到的是什么、为什么两者结论不同。**这个实验的价值在于打破“域名白名单 = 网络安全”的错觉。**

### 实验 D4 · patch 的合并语义

创建时允许 A、B，patch 一条新的 A 规则（改成 deny），然后 `get_egress_policy()`。预期：A 被覆盖，B 保留，`default_action` 不变。

再删除一个不存在的 target，确认是幂等而不是报错。

### 实验 V1 · 证明真实密钥没有进入沙箱

在启用 Vault 的沙箱里执行：

```bash
env | grep -i token
cat /proc/1/environ | tr '\0' '\n' | grep -i token
```

再发起一次绑定目标请求并观察成功，然后检查沙箱内是否有任何地方出现真实值。你要能回答：请求成功靠的是哪一层注入？沙箱里看到的是什么？

### 实验 I1 · 三种 ingress 错误

分别制造：删除后的沙箱（404）、刚创建但未 Ready 的沙箱（503）、把 gateway 后端指向错误 Service（502）。记录响应体和日志位置。

## 故障速查

| 现象 | 先查什么 | 常见根因 |
| --- | --- | --- |
| 入站 404 | sandbox ID、TTL | 已过期/已删除、路由到了错误命名空间 |
| 入站 503 | Pod/容器 Ready、execd 端口 | 端点未发布、进程未监听 |
| 入站 502 | gateway 到后端连接 | Service/Endpoint 异常、网关配置错误 |
| 创建带策略被拒 | `docker.network_mode` | 非 `bridge`，无法附加 egress |
| sidecar 没起来 | `[egress].image`、readiness | 镜像缺失、启动超时 |
| 允许域名仍不通 | 平台 deny overlay、DNS | 管理员禁止、解析失败、应用用了 IP |
| patch 后默认仍拒绝 | `default_action` | patch 不修改默认动作 |
| 恢复后 401 | Vault 是否重新注入 | secret 只在 sidecar 内存 |
| `credential_vault` 抛异常 | 沙箱来源 | 模板沙箱没有沙箱侧 Vault |
| 策略“时好时坏” | overlay 是否热更新 | 平台级规则变化 |

## 常见误区

| 误区 | 纠正 |
| --- | --- |
| “创建后 patch 就能开启 egress” | sidecar 是创建/预创建路径的一部分，没有执行面就无从 patch |
| “允许了域名就挡住了 IP” | `dns` 只作用于名称解析；包级约束要 `dns+nft` |
| “我的 allow 一定生效” | 平台 deny 永远优先，overlay 还可能热更新 |
| “Vault 会把真密钥放进环境变量” | 真值只在 sidecar，沙箱只看到 fake/empty 或占位符 |
| “恢复后密钥会自动回来” | 需要可信控制面重新注入 |
| “模板沙箱也能用 Vault” | 模板来源会显式抛异常 |
| “`networkPolicy` 就是 K8s NetworkPolicy” | 前者是 egress sidecar 的策略模型 |
| “egress 崩了应该放行以免影响业务” | 应 fail-closed，静默直通等于取消治理 |

## 自检与参考答案

**1. 为什么端点必须解析而不能写死？**

因为不同运行时和部署的拓扑不同：Docker 是端口映射，Kubernetes 经 Service/网关，FastSandbox 走 FastPath。地址和路由头由服务端按当前拓扑生成，写死会在换环境时失效。

**2. `endpoint` 和 `headers` 为什么要一起用？**

网关可能依赖请求头识别“沙箱 ID + 端口”。只拿 URL 不带头，路由信息不完整。不同部署下 headers 可能为空，所以要以解析结果为准，而不是假设固定头。

**3. 入站 404、503、502 分别说明什么？**

404：沙箱不存在或已删除；503：存在但端点未就绪；502：基础设施/集群 API 层失败。三者对应不同排查路径，不能统一重试。

**4. 为什么说“只限制 DNS 不等于只允许某个域名”？**

DNS 模式只影响名称解析。应用可以直接用 IP、自己实现解析、或走不经过该 DNS 的路径。需要包级保证就要 `dns+nft`。

**5. 平台 deny 和用户 allow 谁优先？**

平台 deny 优先于平台 allow，平台 allow 优先于用户规则。用户规则不能覆盖管理员禁止的目标。

**6. patch 会改变默认动作吗？**

不会。patch 只合并规则，相同 target 覆盖、其他保留；`default_action` 保持不变。要改默认动作必须重新声明策略。

**7. Credential Vault 解决了什么问题，没解决什么问题？**

解决“沙箱进程拿到真实密钥”的问题：真值只在 sidecar，注入发生在出站路径。没解决 sidecar 被攻破、控制面被攻破、日志泄漏、应用层数据外泄等问题。

**8. 为什么 Vault 要求创建时就带网络策略和 `dns+nft`？**

因为代理必须在明确的目标集合上工作。默认允许会让未匹配绑定的请求照样出站，扩大外泄面；`dns+nft` 提供包级默认拒绝，才能让“只允许绑定目标”成立。

**9. 暂停恢复后 401，最可能的原因是什么？**

Vault 的秘密只在 sidecar 内存，暂停/恢复后没有自动恢复。需要从可信控制面重新注入，而不是把 secret 写进快照。

**10. 为什么 Pool 模式不能按请求传 `networkPolicy`？**

Pool Pod 在请求前已创建，网络命名空间和 sidecar 配置已经固定。要按请求区分策略，应该用直接创建，或为不同策略准备不同 Pool。

## 关键源码坐标

| 想回答的问题 | 先看 |
| --- | --- |
| 客户端网络模型 | `sdks/sandbox/python/src/opensandbox/models/sandboxes.py` 的 `NetworkPolicy`、`NetworkRule` |
| egress 与凭据 API | `sdks/sandbox/python/src/opensandbox/services/egress.py` |
| 服务端 egress/ingress 配置 | `server/configuration.md` 的 `[ingress]`、`[egress]`、`docker.network_mode` |
| 端点解析与代理改写 | `server/opensandbox_server/api/lifecycle.py` |
| 出站架构与限制 | `docs/architecture/network/egress.md` |
| 入站路由与错误语义 | `docs/architecture/network/ingress.md` |
| 凭据保险箱 | `docs/guides/credential-vault.md` |
| 安全端点 | `docs/guides/secure-access.md` |
| egress 契约 | `specs/egress-api.yaml` |

## 做完之后

你现在应该能把“联网”拆成四件事：解析端点、放进站、管出站、代持凭据；并且每件事都能说出一条前置条件和一条失败边界。这比“会写 allow 规则”重要得多。

下一阶段换到开发者视角：同一套能力，五种语言 SDK、`osb` CLI、MCP 和公开契约分别扮演什么角色？哪些是生成的，哪些是手写的？改一个字段，应该按什么顺序动？

带着这个问题进入下一章：**“同一份契约，为什么在不同语言里长得不一样？”** 进入[阶段 6](../stage-6/)。
