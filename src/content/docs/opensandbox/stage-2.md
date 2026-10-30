---
title: "阶段 2：生命周期与清理"
description: "生命周期、TTL、暂停恢复、快照与清理：从能创建到能负责。"
---

> 对应[学习路线](../learning-path/)阶段 2（核心 · 2–3 天）。本阶段把沙箱当作一项有成本、有期限、会失败的远端资源来管理。
> 源码目录：`$OSB_SRC`。
> 核心产出：一个在成功、异常、取消三条路径都能释放远端资源的封装，以及一次暂停/恢复实验记录。

## 一、这一阶段到底要解决什么

阶段 0 的脚本能创建和销毁一个沙箱，阶段 1 的地图告诉你创建和执行是两条路径。但生产系统还要回答更难的问题：

- 创建请求已经返回，沙箱为什么还可能不可用？
- 进程崩溃、用户取消、模型超时后，谁来删除远端资源？
- 长任务运行到一半，TTL 到期怎么办？
- “暂停”保存的是内存、磁盘，还是只释放 Pod？
- 我手里的 `Sandbox` 对象是远端资源本身，还是只是一个本地句柄？

这些问题的共同主题是：**所有权。**

只要一个沙箱被创建出来，就必须有一个明确的负责人和退出路径；否则它会继续占用 CPU、内存、磁盘、网络名额和费用。AI 应用尤其容易泄漏资源，因为模型调用、工具调用和用户取消都可能发生在任意时刻。

### 先把三个层次分开

| 层次 | 是什么 | 谁拥有 | 典型动作 |
| --- | --- | --- | --- |
| 远端资源 | 容器、Pod、微虚拟机、快照 | 平台 + 你的清理协议 | `create`、`kill`、`pause`、`resume` |
| 控制面记录 | sandbox ID、状态、过期时间、元数据 | 生命周期服务器 + 运行时 | `get_info`、`renew`、`list` |
| 本地句柄 | HTTP 客户端、连接池、服务适配器 | 你的进程 | `close`、`connect`、`resume` |

把这三层混在一起，就会出现两种典型错误：

- **“代码已经结束，沙箱还在跑”**：只关闭了本地句柄，没有终止远端。
- **“以为关闭了连接，其实删除了远端”**：把 `close()` 当成 `kill()` 用，任务被误杀。

本阶段的目标，就是让你能准确说出：**此刻我操作的是哪一层，失败时哪一层还留着东西。**

## 二、生命周期词汇表

| 术语 | 准确含义 | 容易误解成 |
| --- | --- | --- |
| 绝对过期时间 | `expiresAt` 是一个时间点，到了就终止 | “还剩多少秒” |
| TTL | 创建时指定的存活时长，最终折算成绝对时间 | 空闲超时 |
| Renew | 把过期时间设为“当前时间 + 传入时长” | 在原时间上累加 |
| 手动清理 | `timeout=None`，没有自动到期删除 | 永不过期、无需清理 |
| Pause | 请求暂停；不同后端保留的内容不同 | 一定保存内存 |
| Resume | 恢复暂停的沙箱，返回新句柄 | 在原对象上继续用 |
| Snapshot | 某个时间点的持久化检查点 | 暂停的同义词 |
| Template | FastSandbox 预构建的不可变工作负载定义 | 普通镜像 |
| 终态 | `Terminated` / `Failed`，不会自己回到 `Running` | 可以重试恢复 |

有一条总原则：**生命周期 API 是异步的，任何“请求已接受”都不等于“状态已完成”。** 看到 `202`，下一步永远是查状态，而不是假设成功。

## 三、状态机：先认识“中间态”

公开契约里的状态与迁移大致如下：

```text
                 ┌──────────────┐
                 │   Pending    │
                 └──────┬───────┘
                        │ 资源就绪
                        ▼
   ┌──────────────► Running ◄──────────────┐
   │                │     │                │
   │        pause   │     │ kill / TTL     │
   │                ▼     ▼                │
   │            Pausing  Stopping          │
   │                │        │             │
   │                ▼        ▼             │
   │             Paused   Terminated       │
   │                │                      │
   │      resume    ▼                      │
   └──────────── Resuming ─────────────────┘

任意非终态在关键错误下可进入 Failed
```

| 状态 | 含义 | 你该做什么 |
| --- | --- | --- |
| `Pending` | 已受理，资源尚未就绪 | 等待或轮询；不要发业务请求 |
| `Running` | 可用 | 执行命令、访问文件或服务 |
| `Pausing` | 暂停处理中 | 不要假设已经暂停 |
| `Paused` | 已暂停 | 可恢复；保留范围取决于后端 |
| `Resuming` | 恢复处理中 | 等待回到 `Running`，不要复用旧端点 |
| `Stopping` | 终止处理中 | 不要再发起新业务操作 |
| `Terminated` | 已正常终止 | 做最终清理和审计 |
| `Failed` | 终态故障 | 读 `reason` / `message`，不要盲目重试 |

两个实现细节：

1. **SDK 常量里没有 `Resuming`。** `SandboxState` 定义了 `Pending`、`Running`、`Pausing`、`Paused`、`Stopping`、`Terminated`、`Failed`、`Unknown`，但公开契约明确把 `Resuming` 列为合法状态。客户端应把状态当作可扩展字符串，遇到未知值记录日志并继续轮询，而不是写死一组 `if state == ...`。
2. **`Stopping` 是真实存在的观察窗口。** 在 Kubernetes 上删除 `BatchSandbox` 后，对象可能短暂保留，等待任务清理和池释放；这期间查询会看到 `Stopping`，不是“删除失败”。阶段 4 会解释背后的控制器行为。

状态机之外，还有一个状态字段常被忽略：

```python
info.status.reason    # 机器可读原因，如 user_delete、ttl_expiry、provision_timeout
info.status.message   # 人类可读说明
info.last_transition_at
```

排错时先读 `reason`，再读日志；不要只看 `state` 是 `Failed` 就开始猜。

## 四、创建：从“请求成功”到“可以负责”

阶段 1 已经拆过创建链路，这里只补生命周期视角的三个关键点。

### 1. `create()` 返回时，你拿到的是“可用句柄”，不是“所有权证明”

SDK 默认会等到端点发布并完成健康检查才返回。但这只说明“现在能用”，不说明：

- 你已经记录了 sandbox ID；
- 你的进程退出时它会被清理；
- 它的 TTL 足够覆盖任务；
- 后续另一个 worker 不会把它杀掉。

句柄是能力，所有权是协议。生产系统必须显式设计后者。

### 2. 创建失败时，SDK 会尽力清理“半成品”

`Sandbox._launch` 在端点解析或健康检查失败时，会尝试 `kill_sandbox` 清理已经创建出来的远端沙箱，然后抛出异常。这能减少孤儿，但不是保证：

- 进程被 `SIGKILL`、机器断电，清理代码不会执行；
- 清理请求本身可能失败；
- 服务端可能在返回 ID 之前就失败，客户端根本不知道远端是否已创建。

所以仍需要 TTL 兜底和孤儿扫描，不能把 SDK 的尽力清理当成事务。

### 3. 就绪预算和健康检查是两件事

`ready_timeout`（默认 30 秒）是“等端点发布 + 健康检查”的总预算；`skip_health_check=True` 只是跳过健康探测，**仍然会等端点发布**。这意味着：

- 跳过健康检查不等于不等待；
- 自定义 `health_check` 可能比 `/ping` 更严格，也更适合业务服务；
- 预算耗尽应被视为可诊断的失败，而不是“再试一次就好”。

## 五、TTL：绝对时间，不是倒计时

### 创建时的 TTL

`Sandbox.create` 的默认 `timeout` 是 10 分钟，最终由服务端折算成 `expiresAt` 这个绝对时间点。服务端配置里的 `max_sandbox_timeout_seconds` 限制的是**创建时**能申请的最大时长。

`timeout=None` 表示手动清理模式：没有自动到期删除。它不意味着免费、安全或永久；它只意味着**泄漏风险完全转移到你的代码身上**。Kubernetes 的某些工作负载提供方甚至可能拒绝“不设过期时间”的请求。

### 续期的真实语义

源码写得很直接：

```python
new_expiration = datetime.now(timezone.utc) + timeout
```

所以 `renew(timedelta(minutes=5))` 的含义是“从现在起再活 5 分钟”，不是“在原过期时间上加 5 分钟”。它可能延长，也可能**缩短**剩余寿命。

一个实用预算是：

```text
任务预估时长 + 排队等待 + 工具重试预算 < TTL
```

不要把续期当成无限保活；也不要在每个工具调用前无脑续期，否则一个卡死的 Agent 可以永久占用资源。

### 为什么绝对时间更可靠

绝对过期时间有一个重要好处：**服务重启不会重置寿命。**

- Docker 运行时把过期时间写进容器标签；服务端启动时会扫描已有沙箱并恢复定时器。
- Kubernetes 把过期时间写进 `BatchSandbox` 的 `expireTime`，由控制器执行。

这就是“绝对 TTL 而不是空闲超时”的价值：沙箱的寿命可以从创建时间审计，不会因为一次重启、一次空闲、一次重连而悄悄延长。

### TTL 到期的表现

TTL 到期不是“优雅地通知你的代码”，而是资源被终止：

- 正在执行的命令会断开；
- 后续请求可能得到 `404` 或连接失败；
- 状态最终进入 `Terminated`，`reason` 可能是 `ttl_expiry`。

应用应把“执行中途断开”与“命令本身失败”分开处理；前者是生命周期事件，后者是业务事件。

## 六、暂停与恢复：同一个接口，不同的保留范围

这是全课程最容易被“接口相似”误导的地方之一。

### 共同点

- `sandbox.pause()` 只负责**发起**暂停，不等待完成；要轮询到 `Paused` 才算完成。
- 暂停后旧端点可能失效；SDK 在 `pause()` 时会清空端点缓存。
- 恢复用类方法 `Sandbox.resume(id, ...)`，它会重新解析端点、重建服务对象、做健康检查，返回**新的句柄**。
- 暂停中的沙箱仍可能按原 TTL 到期；暂停不是“冻结计费”。

### 不同点：Docker 与 Kubernetes 的“暂停”不是一回事

| 维度 | Docker 运行时 | Kubernetes（BatchSandbox rootfs 模式） |
| --- | --- | --- |
| 实现方式 | 暂停容器进程（freeze） | 提交根文件系统快照，释放 Pod 与池名额 |
| 运行内存 | 保留在内存中 | 默认不保留 |
| 资源占用 | 容器仍存在，仍占资源 | Pod 被释放，主要留镜像/快照 |
| 恢复速度 | 快，解冻即可 | 需要从快照重建工作负载 |
| 端点 | 通常不变，但不应缓存 | 可能变化，必须重新解析 |
| Credential Vault | sidecar 仍在，秘密可能保留 | sidecar 随运行时释放，秘密丢失，需要重新注入 |
| 适用场景 | 短暂中断、保留进程状态 | 长时间停用、释放集群容量 |

这张表要带进阶段 4：**同一个 `pause()`，不同后端提供的是不同保证。** 看到“支持暂停”，必须追问“保留了哪些状态、释放了哪些资源”。

### 暂停/恢复实验的注意事项

- 暂停前先确认状态是 `Running`；对 `Paused` 再暂停通常得到 `409`。
- 恢复后不要复用旧 `Sandbox` 对象；用 `resume()` 返回的新句柄。
- 如果任务依赖进程内存（例如一个正在训练的 Python 进程），在 Kubernetes rootfs 模式下恢复后不会从原内存继续。
- 如果启用了 Credential Vault，恢复后要重新注入凭据；不要假设秘密会跟着快照回来。

## 七、快照：持久化检查点，不是“暂停的别名”

快照和暂停解决不同问题：

- **暂停**：让一个沙箱暂时不可用，之后恢复**同一个沙箱 ID**。
- **快照**：把某个时刻的状态持久化，之后可以创建**新的沙箱**，也可以长期保留。

### 公开状态

生命周期 API 暴露的快照状态是：

| 状态 | 含义 |
| --- | --- |
| `Creating` | 已接受，正在捕获 |
| `Ready` | 可用于恢复 |
| `Failed` | 创建失败，读原因 |
| `Deleting` | 删除处理中 |

创建接口返回时通常还是 `Creating`，必须轮询到 `Ready` 才能用于 `Sandbox.create(snapshot_id=...)`。

在 Kubernetes 内部，控制器还会经历 `Pending → Committing → Succeed / Failed` 的阶段；这是实现层的阶段，不要和公开状态混用。你通过 API 看到的是公开状态。

### 边界

- 默认保存根文件系统；运行内存默认不保存。可选的 QEMU VMState 能保存虚拟机内存状态，但属于特定后端和特定配置。
- 暂停/恢复和快照通常只支持单副本沙箱（`replicas=1`）。
- 删除快照记录不等于删除已经推送的镜像；镜像保留策略是运维问题。
- 快照的 registry、凭据、保留策略由部署配置决定，不是每个请求都能覆盖。

### 恢复时的参数约束

`Sandbox.create` 要求 `image` 和 `snapshot_id` **恰好提供一个**。同时传两个会立刻失败；两个都不传也会失败。恢复出来的沙箱是一个新 ID，不是原沙箱的“复活”。

## 八、模板：创建前就固定了形状

FastSandbox 模板是另一类生命周期对象，容易和快照混淆：

| 维度 | 快照 | 模板 |
| --- | --- | --- |
| 来源 | 某个沙箱的运行结果 | 预构建的黄金镜像 |
| 用途 | 恢复该沙箱的状态 | 快速创建同形状的新沙箱 |
| 状态 | `Creating` / `Ready` / `Failed` / `Deleting` | `Pending` / `Building` / `Succeeded` / `Failed` |
| 创建入口 | `Sandbox.create(snapshot_id=...)` | `Sandbox.create_from_template(template_id, timeout=...)` |
| 可覆盖字段 | 部分创建参数 | 几乎不可覆盖：入口、环境、资源、卷、平台、生命周期都来自模板 |

模板模式有三个硬约束：

1. `timeout` 是**必需参数**；
2. 只有 `Succeeded` 的模板能创建沙箱；
3. 不能用每请求的 `image`、`env`、`resource`、`entrypoint` 覆盖模板形状。

如果业务需要“每个任务不同镜像、不同资源”，模板不是合适的选择；它适合“形状稳定、启动要快”的场景。

## 九、四个清理动作：`close`、`kill`、`destroy`、`async with`

先看源码语义，再看使用场景。

| 操作 | 远端沙箱 | 本地连接 | 典型用途 |
| --- | --- | --- | --- |
| `close()` | **保留** | 关闭 | 任务结束，但希望稍后 `connect()` 或交给 TTL |
| `kill()` | **终止** | 保留 | 不再需要远端，但仍要用客户端做收尾 |
| `destroy()` | **终止** | 关闭 | 创建—使用—丢弃的标准退出路径 |
| `async with sandbox` | **不会自动终止** | 退出时 `close()` | 只保证本地资源释放 |
| `connect()` | 连接已有 | 新建句柄 | 跨进程接手、断线重连 |
| `resume()` | 恢复暂停沙箱 | 新句柄 | 暂停后继续任务 |

几个实现细节值得记住：

- `destroy()` 先 `kill()`，再在 `finally` 里 `close()`；**即使终止失败，本地资源也会关闭，然后异常继续抛出。**
- `close()` 只记录错误、不抛出，避免清理路径二次爆炸。
- `pause()` 和 `kill()` 都会清空端点缓存，防止继续使用旧地址。
- `async with` 的 `__aexit__` 只调用 `close()`，所以“上下文退出后沙箱还在”是设计行为，不是 bug。

### 一个最小但可靠的封装

```python
import asyncio
from datetime import timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig


async def run_in_sandbox(work):
    config = ConnectionConfig(domain="localhost:8080", api_key="dev-secret")
    sandbox = await Sandbox.create(
        "python:3.12",
        connection_config=config,
        timeout=timedelta(minutes=15),
    )
    try:
        return await work(sandbox)
    finally:
        # 用 shield 防止当前任务被取消时清理也被打断；
        # 它挡不住第二次取消或进程退出，所以 TTL 仍是兜底。
        await asyncio.shield(sandbox.destroy())
```

这段代码解决了“成功”和“异常”两条路径，但还没有解决：

- 清理失败如何告警；
- 清理超时如何处理；
- 取消发生时如何确保清理任务真的跑完；
- 如何记录 sandbox ID 以便事后审计。

生产封装至少应补上结构化日志、销毁失败告警和 sandbox ID 记录。不要在 `finally` 里静默吞掉销毁异常，否则泄漏会被伪装成成功。

### 三条路径都要想清楚

| 路径 | 典型场景 | 你要保证 |
| --- | --- | --- |
| 成功 | 任务正常完成 | 显式 `destroy()`，不要只依赖 GC |
| 异常 | 命令失败、解析失败、业务抛错 | `finally` 中仍执行销毁 |
| 取消 | 用户中断、上层超时、进程关闭 | 清理不被同一次取消打断；有 TTL 和孤儿扫描兜底 |

## 十、实验：看见“句柄”和“远端”的差别

### 实验 1 · 生命周期观察器

```python
import asyncio
from datetime import datetime, timezone, timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig


def connection() -> ConnectionConfig:
    return ConnectionConfig(
        domain="localhost:8080",
        api_key="dev-secret",
        request_timeout=timedelta(seconds=60),
    )


async def wait_for_state(sandbox, wanted: str, timeout_seconds: float = 120) -> str:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    while True:
        info = await sandbox.get_info()
        state = info.status.state
        print(f"state={state} reason={info.status.reason}")
        if state == wanted:
            return state
        if state in {"Failed", "Terminated"}:
            raise RuntimeError(f"sandbox reached {state}: {info.status.reason}")
        if loop.time() >= deadline:
            raise TimeoutError(f"state did not become {wanted}")
        await asyncio.sleep(1)


async def main() -> None:
    sandbox = await Sandbox.create(
        "python:3.12",
        connection_config=connection(),
        timeout=timedelta(minutes=10),
        resource={"cpu": "500m", "memory": "512Mi"},
        metadata={"lesson": "stage-2"},
    )
    print("sandbox id:", sandbox.id)
    try:
        info = await sandbox.get_info()
        print("expires_at:", info.expires_at)
        print("now       :", datetime.now(timezone.utc))

        await wait_for_state(sandbox, "Running")

        await sandbox.renew(timedelta(minutes=3))
        new_info = await sandbox.get_info()
        print("after renew:", new_info.expires_at)
    finally:
        await sandbox.destroy()


if __name__ == "__main__":
    asyncio.run(main())
```

**观察三件事**：

1. `expires_at` 是绝对时间，和 `now` 的差值接近你传入的 TTL；
2. `renew(3m)` 后新的 `expires_at` 接近“现在 + 3 分钟”，而不是“原时间 + 3 分钟”；
3. 脚本结束后远端资源才由 `destroy()` 终止；`finally` 是资源安全的关键。

### 实验 2 · `close()` 之后，远端还在吗

把 `finally` 里的 `destroy()` 换成 `close()`，运行后在另一个窗口执行：

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}"
```

你会看到沙箱容器仍然存在。然后手动终止它：

```python
await sandbox.kill()
```

再用 `docker ps` 确认消失。这个实验把“本地句柄”和“远端资源”彻底分开。

### 实验 3 · 暂停与恢复（Docker）

```python
async def pause_and_resume() -> None:
    config = connection()
    sandbox = await Sandbox.create(
        "python:3.12",
        connection_config=config,
        timeout=timedelta(minutes=30),
    )
    sandbox_id = sandbox.id
    try:
        await sandbox.pause()
        await wait_for_state(sandbox, "Paused")
        print("paused; check `docker ps` for (Paused)")

        resumed = await Sandbox.resume(
            sandbox_id,
            connection_config=config,
            resume_timeout=timedelta(seconds=60),
        )
        try:
            execution = await resumed.commands.run("echo resumed")
            print(execution.text)
        finally:
            await resumed.destroy()
    finally:
        try:
            await sandbox.close()
        except Exception as exc:
            print("close failed:", exc)
```

在暂停后、恢复前执行 `docker ps`，观察容器状态；恢复后再执行一次命令。**注意**：Docker 的暂停保留进程内存，Kubernetes rootfs 暂停不保留；换后端重做这个实验，结论会不同。

### 实验 4 · 快照（需要 Kubernetes 后端）

如果当前只有 Docker，跳过执行，但仍要读懂代码：

```python
from opensandbox import Sandbox, SandboxManager


async def snapshot_lab(sandbox: Sandbox) -> None:
    created = await sandbox.create_snapshot(name="stage-2-checkpoint")
    manager = await SandboxManager.create(connection_config=connection())
    try:
        deadline = asyncio.get_running_loop().time() + 300
        while True:
            current = await manager.get_snapshot(created.id)
            state = current.status.state
            print("snapshot state:", state)
            if state == "Ready":
                break
            if state == "Failed":
                raise RuntimeError(current.status.message or "snapshot failed")
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError("snapshot did not become Ready")
            await asyncio.sleep(2)

        restored = await Sandbox.create(
            snapshot_id=created.id,
            connection_config=connection(),
            timeout=timedelta(minutes=10),
        )
        try:
            print((await restored.get_info()).id)
        finally:
            await restored.destroy()
    finally:
        await manager.close()
```

**要观察**：快照 ID 和恢复出的 sandbox ID 不同；`create(snapshot_id=...)` 不能再传 `image`。

### 实验 5 · 取消路径

```python
async def cancelled_work() -> None:
    try:
        await asyncio.sleep(60)
    finally:
        print("work cancelled; cleanup still runs")
```

用一个外层 `asyncio.timeout(2)` 包住整个 `run_in_sandbox(cancelled_work)`，观察：

- `CancelledError` 会传播；
- `finally` 中的 `destroy()` 仍应执行；
- 如果清理没有完成，`docker ps` 会留下证据。

这一步是为阶段 7 的 Agent 预算和阶段 8 的泄漏排查做铺垫。

## 十一、失败模式表

| 现象 | 可能原因 | 先查什么 | 处理 |
| --- | --- | --- | --- |
| 创建超时 | 镜像拉取慢、调度失败、execd 未就绪 | 服务端日志、`docker ps -a`、状态 `reason` | 区分“慢”和“死”；不要无脑重试 |
| 创建失败后仍残留容器 | 清理请求失败、进程被杀 | sandbox ID、容器标签 | 依赖 TTL + 孤儿扫描，不假设 SDK 清理可靠 |
| `401` | API Key 不一致 | 服务端配置、客户端配置 | 修密钥，不要重试 |
| 暂停返回 `409` | 沙箱不在 `Running` | 当前状态 | 先等到稳定状态 |
| 恢复失败 | 快照未 `Ready`、后端不支持、资源不足 | 快照状态、事件 | 等 `Ready` 再恢复；读 `reason` |
| 恢复后命令连接失败 | 端点已变化、旧句柄被复用 | 是否用 `resume()` 新句柄 | 重新解析端点，不缓存旧地址 |
| 长任务中途断开 | TTL 到期 | `expiresAt`、`reason` | 在预算内续期；把 TTL 事件与业务失败分开 |
| 快照一直 `Creating` | 镜像推送慢、registry 不可达 | 快照状态、控制器事件、registry | 设超时并告警，不要无限轮询 |
| 删除后仍能查到 | Kubernetes `Stopping` 窗口 | `status.reason` 是否为 `DELETING` | 等待对象真正消失 |
| 清理失败但业务成功 | `destroy()` 抛错被吞 | 日志级别、异常处理 | 记录 ID 并告警，不要伪装成功 |

## 十二、常见误区

| 误区 | 更准确的理解 |
| --- | --- |
| “`create()` 返回了，资源就归我管了” | 返回的是可用句柄；所有权要靠清理协议、TTL 和审计来建立。 |
| “`renew(30m)` 是在原过期时间上加 30 分钟” | 是 `now + 30m`，可能延长也可能缩短。 |
| “`timeout=None` 就是永久沙箱” | 是没有自动到期删除，泄漏风险更高。 |
| “`close()` 会删除沙箱” | 只关闭本地连接，远端仍在。 |
| “`async with` 会自动销毁” | 只调用 `close()`，不会终止远端。 |
| “暂停一定保存内存” | Docker freeze 保留内存；Kubernetes rootfs 快照默认不保留。 |
| “恢复后还能用旧 `Sandbox` 对象” | 端点可能变化；用 `resume()` 的新句柄。 |
| “快照创建返回成功就能恢复” | 要轮询到 `Ready`；`Creating` 不是可用。 |
| “模板和快照都是保存状态” | 模板是预构建形状，快照是某个沙箱的检查点。 |

## 十三、通关自检（含参考答案）

**1. 为什么说生命周期管理的本质是所有权管理？**

因为资源一旦创建就持续占用成本，而“创建成功”只证明它现在存在，不证明有人会在成功、异常、取消三条路径上负责释放它。所有权意味着明确的负责人、期限和退出路径。

**2. `renew(5m)` 到底做了什么？**

把过期时间设为“当前 UTC 时间 + 5 分钟”。它不是累加，也不是保活；如果原剩余时间更长，这次调用会缩短寿命。

**3. `close()`、`kill()`、`destroy()` 的区别是什么？**

`close()` 只释放本地连接；`kill()` 终止远端但保留本地客户端；`destroy()` 先终止远端，再无条件关闭本地资源，是标准的创建—使用—丢弃退出路径。

**4. 为什么 `async with` 不能替代清理？**

它的 `__aexit__` 只调用 `close()`，不会调用 `kill()` 或 `destroy()`。远端沙箱会继续运行，直到 TTL 到期或被其他机制清理。

**5. Kubernetes 上暂停后，进程内存还在吗？**

默认不在。rootfs 模式提交文件系统并释放 Pod，恢复时从快照重建；运行内存默认不保留。需要保留内存时要使用特定的快照/VMState 模式，并确认后端支持。

**6. 为什么暂停后要重新解析端点？**

暂停/恢复可能改变工作负载的地址（尤其在 Kubernetes 上）。SDK 的 `pause()` 会清空端点缓存，`resume()` 会重新解析并返回新句柄；业务代码不应缓存旧地址。

**7. 快照的公开状态和内部阶段为什么不一样？**

公开 API 面向客户端，使用 `Creating` / `Ready` / `Failed` / `Deleting`；Kubernetes 控制器内部还有 `Pending → Committing → Succeed / Failed`。前者是契约，后者是实现阶段，客户端只应依赖公开状态。

**8. 创建失败后一定没有残留吗？**

不一定。SDK 会尽力清理已经拿到 ID 的沙箱，但进程被杀、清理请求失败、服务端提前失败都可能留下资源。TTL 和独立的孤儿扫描仍是必要的兜底。

### 完成清单

- [ ] 能画出 `Pending → Running → Pausing → Paused → Resuming → Running` 和终止分支。
- [ ] 能解释 `resume` 为什么返回新句柄，以及为什么不能缓存旧端点。
- [ ] 能说出默认 TTL、`timeout=None` 和 `renew` 的实际语义。
- [ ] 写出一个在成功、异常、取消三条路径都能清理的封装。
- [ ] 能区分 `close`、`kill`、`destroy` 和 `async with`。
- [ ] 在 Docker 上完成一次暂停、轮询到 `Paused`、恢复并执行命令。
- [ ] 能解释 Docker 与 Kubernetes 暂停保留内容的差异。
- [ ] 能说明快照 `Ready` 和模板 `Succeeded` 为什么都必须轮询。

## 十四、做完之后

现在你能把一个沙箱从“会跑代码的东西”变成“有所有者、期限和退出路径的资源”。

下一阶段进入数据面：命令、流式输出、文件读写、终端和代码上下文。你会看到 `Execution` 对象里到底有什么、SSE 事件怎样变成证据，以及为什么“传输成功”和“命令成功”是两件事。

带着这个问题进入下一章：**“模型说‘运行这段代码’之后，系统凭什么让应用相信它真的运行了、真的成功了？”**

进入[阶段 3](../stage-3/)。

---

*配套[学习路线](../learning-path/)阶段 2 编写 · 2026-10-30 · 基于 release-1.1.1（`531700ca`）*
