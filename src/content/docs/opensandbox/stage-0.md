---
title: "阶段 0：把系统跑起来"
description: "把服务端、Docker 与第一个沙箱跑起来，并记录系统边界。"
---

> 对应[学习路线](../learning-path/)阶段 0（准备 · 0.5–1 天）。本文件是配套讲解，不替代清单里的勾选项。
> 源码目录：`$OSB_SRC`。下文命令若无特别说明，都先 cd 到这个目录再执行。
> 本阶段只做一件事：让“源码版服务端 → Docker → 沙箱 → Python SDK → 命令输出”这条最小链路真实工作。

## 一、这一阶段到底要得到什么

AI 基础设施项目最容易产生一种假学习：看懂架构图，却没有见过一个真实沙箱怎样启动、怎样失败、怎样被清理。

阶段 0 的目标不是“装好环境”，而是建立三个基线：

1. **环境基线**：Docker、Python、服务端和 SDK 的版本与配置明确。
2. **行为基线**：你知道正常创建、执行、销毁分别耗时多久、输出什么。
3. **故障基线**：你见过至少一次鉴权失败或 Docker 未启动的错误，之后不会把环境问题误判成代码问题。

后面所有阶段都以这三个基线为参照。没有真实行为，概念会变成纸上谈兵；没有故障记录，排错会变成猜谜。

## 二、前置条件

| 组件 | 要求 | 检查命令 |
| --- | --- | --- |
| Windows | 建议 Windows 10/11，启用 WSL2 | `wsl --status` |
| Docker | Docker Desktop，Linux containers | `docker version` |
| Python | 3.10+ | `python --version` |
| uv | 最新稳定版 | `uv --version` |
| 磁盘 | 至少预留数 GB 给镜像和容器 | `docker system df` |

> Windows 上请确认 Docker Desktop 使用 **Linux containers**。OpenSandbox 的参考本地运行时面向 Linux 容器；Windows 容器是另一套后端配置，不应混用本阶段命令。

如果 Docker 报 `failed to connect to the docker API` 或 `dockerDesktopLinuxEngine`，先启动 Docker Desktop，等状态变为 Engine running，再继续。**不要在 Docker 没起来时怀疑 Python 代码。**

## 三、步骤 1 · 进入源码并确认版本

```powershell
cd $OSB_SRC
git describe --tags --always
git log -1 --format="%H %ad %s" --date=iso
```

应看到 `release-1.1.1` 和提交 `531700ca...`。这一步很重要：教材中的路径与行为都以这个快照为准，开发线可能已经前进。

再确认 Docker：

```powershell
docker version
docker context show
```

**你要观察**：客户端和服务器两段都出现，说明 Docker daemon 可用；只有客户端信息，通常意味着引擎没启动。

## 四、步骤 2 · 创建隔离的 Python 环境

```powershell
uv venv .venv
.\.venv\Scripts\Activate.ps1
uv pip install -e .\server -e .\sdks\sandbox\python
```

为什么要从源码安装，而不是只用 `uvx`？

- `uvx opensandbox-server` 会拉取已发布包，可能比当前学习快照更新；
- 源码安装让服务端、SDK 和教材完全对齐；
- 后续读源码、改小实验时不需要切换环境。

验证：

```powershell
python -c "import opensandbox; print(opensandbox.__version__)"
opensandbox-server --help
```

如果 PowerShell 拒绝执行激活脚本，可只对当前用户放开：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\.venv\Scripts\Activate.ps1
```

> 如果 `python` 指向 Microsoft Store 的占位程序，先用 `uv python list` 找到真实解释器，再用 `uv venv --python 3.12 .venv` 指定版本。

## 五、步骤 3 · 生成服务端配置

```powershell
opensandbox-server init-config "$HOME\.sandbox.toml" --example docker
```

打开 `$HOME\.sandbox.toml`。示例默认没有启用鉴权；为了练习真实部署，找到 `[server]` 段，加入或取消注释：

```toml
[server]
host = "127.0.0.1"
port = 8080
api_key = "dev-secret"
max_sandbox_timeout_seconds = 86400
```

如果 `api_key` 为空，服务端会在启动时要求你显式确认“不安全模式”（交互式输入 `YES`，或设置 `OPENSANDBOX_INSECURE_SERVER=YES`）。**开发环境也建议设置密钥**，因为你要练习的正是“凭据从哪里来、401 怎么修”。

### 三个配置项分别在做什么

| 配置 | 作用 | 常见错误 |
| --- | --- | --- |
| `host` / `port` | 生命周期 API 监听地址 | 客户端访问错端口 |
| `api_key` | 管理 API 的鉴权密钥 | SDK 未设置同一密钥，得到 401 |
| `max_sandbox_timeout_seconds` | 创建时 TTL 的上限 | 以为它也限制续期或总寿命 |

### 关键运行时配置

同一文件里的 `[runtime]` 决定后端：

```toml
[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.1.0"
```

`execd` 是注入沙箱的执行守护进程。不要把 `execd_image` 和你的业务镜像混淆：前者提供执行 API，后者是模型代码运行的工作环境。

示例里的 `v1.1.0` 是组件级镜像标签，不等于教材的 umbrella 版本 `release-1.1.1`。组件标签、server 配置和 Helm chart 默认值属于不同发布层，部署时应以当前 chart/配置中的标签为准，并在升级时核对兼容性。

`[egress]` 控制出站 sidecar。即使本阶段不用网络策略，也建议保留默认配置，阶段 5 会用到。

## 六、步骤 4 · 启动服务端

在第一个 PowerShell 窗口：

```powershell
cd $OSB_SRC
.\.venv\Scripts\Activate.ps1
opensandbox-server
```

预期看到 Uvicorn 启动日志，监听 `127.0.0.1:8080`。

在第二个窗口验证：

```powershell
curl.exe http://127.0.0.1:8080/health
curl.exe -H "OPEN-SANDBOX-API-KEY: dev-secret" http://127.0.0.1:8080/version
```

预期返回类似：

```json
{"status":"healthy"}
{"version":"1.1.1"}
```

再打开浏览器访问：

- `http://127.0.0.1:8080/docs` — Swagger UI
- `http://127.0.0.1:8080/redoc` — ReDoc

**本步要观察**：`/health` 不需要 API Key，`/version` 需要。这说明鉴权发生在中间件层，而不是每个路由手写一遍。阶段 1 会把这种“横切关注点”放回分层图里。

## 七、步骤 5 · 故意失败一次

先做一次没有 Key 的请求：

```powershell
curl.exe -i http://127.0.0.1:8080/v1/sandboxes
```

预期得到 `401` 或明确的鉴权错误。再加上错误 Key、最后加正确 Key：

```powershell
curl.exe -i -H "OPEN-SANDBOX-API-KEY: wrong" http://127.0.0.1:8080/v1/sandboxes
curl.exe -i -H "OPEN-SANDBOX-API-KEY: dev-secret" http://127.0.0.1:8080/v1/sandboxes
```

这一步建立故障基线：**401 是凭据问题，不是沙箱创建失败。** 两种错误在日志里出现的位置、可采取的动作都不同。

## 八、步骤 6 · 第一个真实沙箱

在第二个窗口设置环境变量：

```powershell
$env:OPEN_SANDBOX_API_KEY = "dev-secret"
$env:OPEN_SANDBOX_DOMAIN = "localhost:8080"
```

创建 `first_sandbox.py`：

```python
import asyncio
from datetime import timedelta

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig


async def main() -> None:
    config = ConnectionConfig(
        domain="localhost:8080",
        api_key="dev-secret",
        request_timeout=timedelta(seconds=60),
    )

    sandbox = await Sandbox.create(
        "alpine:3.20",
        connection_config=config,
        timeout=timedelta(minutes=10),
        resource={"cpu": "500m", "memory": "512Mi"},
        metadata={"lesson": "stage-0"},
    )

    print(f"sandbox id: {sandbox.id}")
    try:
        execution = await sandbox.commands.run(
            "uname -a; echo '---'; id; echo '---'; cat /etc/alpine-release"
        )
        for message in execution.logs.stdout:
            print(message.text, end="")
        for message in execution.logs.stderr:
            print(message.text, end="")
        if execution.error:
            raise RuntimeError(
                f"{execution.error.name}: {execution.error.value}"
            )
        if execution.exit_code != 0:
            raise RuntimeError(f"command exited with {execution.exit_code}")
    finally:
        await sandbox.destroy()


if __name__ == "__main__":
    asyncio.run(main())
```

运行：

```powershell
python .\first_sandbox.py
```

如果镜像首次拉取，创建可能需要几十秒；后续会快很多。预期输出包含 Linux 内核、当前用户和 Alpine 版本。

**这一步其实发生了很多事**：SDK 发出创建请求，服务端调用 Docker 创建容器并注入 execd，SDK 轮询到 `Running`、解析 execd 端点、做健康检查，然后才返回 `sandbox`。你看到的“一行 `Sandbox.create`”，背后是一条完整的控制面 + 数据面链路。阶段 1 会把它拆开。

## 九、步骤 7 · 看见真实容器（可选，但强烈建议）

在 `Sandbox.create` 之后、`destroy` 之前临时加入：

```python
await asyncio.to_thread(input, "Press Enter to destroy the sandbox...")
```

运行后，另开窗口执行：

```powershell
docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}"
```

你会看到一个带 `opensandbox` 标记的容器。按回车后，它应消失。

这一步把“API 调用”与“真实资源”对应起来：**`Sandbox` 对象不是容器本身，而是指向容器的一个客户端句柄。**

## 十、步骤 8 · 观察清理语义

把脚本改成不用 `finally`，在命令执行后直接结束；或者只调用 `sandbox.close()`。然后观察：

```powershell
docker ps
```

你会学到本教材反复强调的一条：

| 操作 | 远端沙箱 | 本地连接 | 什么时候用 |
| --- | --- | --- | --- |
| `close()` | 保留 | 关闭 | 任务结束但希望稍后 `connect()` 或让 TTL 管理 |
| `kill()` | 终止 | 保留 | 已经不需要远端，但仍要复用客户端做收尾 |
| `destroy()` | 终止 | 关闭 | 创建-使用-丢弃的标准退出路径 |
| `async with sandbox` | **不会自动终止** | 退出时 `close()` | 只保证本地资源释放，不能替代 kill |

生产代码应使用 `try/finally` 包住远端资源，或在业务层拥有明确的终止策略。阶段 2 会把这件事写成可复用的封装。

## 十一、步骤 9 · 读两段官方说明

只读以下两段，不展开：

1. [学习区总览](../) 的 **Getting Started**：确认官方最小路径。
2. `docs/getting-started/configuration.md` 的 **Authentication** 与 **Sandbox Expiration**：确认 API Key 与 TTL 语义。

读完后用自己的话写三句话：

```text
服务端负责：
SDK 负责：
我必须在什么时机清理沙箱：
```

参考答案：

- 服务端负责认证、校验、生命周期状态和运行时选择；
- SDK 负责组装请求、等待就绪、解析端点、把执行结果包装成语言对象；
- 只要创建了远端沙箱，就必须在成功、异常、取消三条路径上都安排销毁，TTL 只是最后兜底。

## 十二、通关自检

全部做到才算完成：

- [ ] `git describe` 显示 `release-1.1.1`。
- [ ] Docker Engine running，且为 Linux containers。
- [ ] 服务端 `/health`、`/version` 正常，`/docs` 可访问。
- [ ] 见过一次 401，并知道如何修复。
- [ ] Python 脚本能创建 Alpine 沙箱、运行命令、打印输出、销毁。
- [ ] 能用 `docker ps` 证明沙箱真实存在过。
- [ ] 能解释 `close()`、`kill()`、`destroy()` 的差异。
- [ ] 能说出默认 TTL 与显式 `timeout` 的关系。

### 参考答案

1. **默认 TTL 是多少？** `Sandbox.create` 的默认 `timeout` 是 10 分钟；显式传入会覆盖默认值。
2. **`timeout=None` 是“永不过期”吗？** 不是。它表示进入手动清理模式，没有自动到期删除，泄漏风险更高。
3. **创建返回时沙箱一定可用吗？** SDK 默认会等到可执行，但服务端创建本身是异步的；原始 HTTP 请求可能先看到 `Pending`。
4. **为什么 401 不应该重试？** 凭据问题不会因为重试而变好；应修正 key、domain 或认证配置。

## 十三、常见问题速查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `dockerDesktopLinuxEngine` 找不到 | Docker Desktop 未启动或非 Linux 容器 | 启动 Docker Desktop，确认 Linux containers |
| 服务端启动即退出，要求确认无鉴权风险 | `server.api_key` 为空 | 设置 `api_key`；不要在 CI 里用 `OPENSANDBOX_INSECURE_SERVER=YES` 掩盖配置错误 |
| SDK 返回 401 | 三处密钥不一致 | 核对 `~/.sandbox.toml`、`ConnectionConfig(api_key=...)`、CLI 配置 |
| `Sandbox.create` 一直等不到就绪 | 容器未创建 / 镜像拉取失败 / execd 不可用 / 端口冲突 / 资源太小 | 依次查 `docker ps -a`、服务端日志、execd 镜像、端口和资源限制 |
| 命令成功但看不到输出 | 只取了第一个 stdout 分片 | 遍历 `logs.stdout`，同时检查 `stderr`、`execution.error`、`exit_code` |
| 沙箱到期后连接失败 | TTL 是绝对时间 | 长任务按预算续期；续期是 `now + duration`，不是累加 |
| PowerShell 拒绝激活脚本 | 执行策略 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |

## 十四、做完之后

你已经拿到三个基线。下一阶段不要再重复安装，而是开始建立全局地图：

- 服务端 API 与 SDK 的边界；
- Docker 运行时怎样被选择；
- 为什么执行请求会绕过生命周期服务器；
- 一次创建在源码里经过哪些层。

带着一个具体问题进入下一章：**“我按下 `Sandbox.create` 之后，究竟是哪一层在什么时候做了哪件事？”**

进入[阶段 1](../stage-1/)。

---

*配套[学习路线](../learning-path/)阶段 0 编写 · 2026-10-30 · 基于 release-1.1.1（`531700ca`）*
