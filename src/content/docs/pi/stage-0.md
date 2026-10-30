---
title: "阶段 0：把系统跑起来"
description: "搭好环境，跑通最小闭环，并记录第一次成功与失败。"
---

> 对应[学习路线](../learning-path/)阶段 0（准备 · 0.5–1 天）。本文件是配套讲解，不替代清单里的勾选项。
> 源码目录：`$PI_SRC`。下文命令若无特别说明，都先在 PowerShell 里 cd 到这个目录再执行。
> 本机环境已验证：Node v26.11.1、npm 11.20.0（要求 Node ≥ 22.19）。

## 为什么需要这一步

后面的阶段全是动手验证驱动的：跑程序、看事件流、改代码、观察行为。所以阶段 0 的目标只有一个：

**让「源码版 Pi」在你的机器上完整可运行，并建立三个基础概念。**

1. **源码版 vs 安装版**。机器上如果有 `pi` 全局命令，那是打包好的安装版；学习区用的是 `pi-test.ps1`——不经过构建，直接用 Node 运行 TypeScript 源码。两者可能不是同一个版本，本清单所有实验以源码版为准。
2. **为什么锁在 v1.3.0**。学习区是独立的 git worktree，detached HEAD 固定在 v1.3.0（提交 `71023aec`）。清单里的路径与行为都对这个版本负责；开发线还在前进，对比时去主仓库。学习区不要切分支、不要拉更新。
3. **两类本地产物**。`node_modules/`（依赖）和 `packages/ai/src/providers/data/`（模型数据）。两者都在 .gitignore 里——丢了可以随时重装/重生成，不用心疼。

## 步骤 1 · 装依赖：npm install --ignore-scripts

**先检查**：`node --version`，需要 ≥ v22.19.0（仓库的 engines 要求）。

**执行**：

```powershell
npm install --ignore-scripts
```

**发生了什么**：monorepo 依赖安装——11 个包的依赖统一装到根 `node_modules`，各包之间互相链接。首次需要下载较多内容，几分钟属正常。

**为什么必须带 `--ignore-scripts`**：让 npm 不执行依赖包附带的生命周期脚本（postinstall 等）。这是仓库和官方安装流程的既定约定（供应链安全）；Pi 正常使用不需要任何依赖的安装脚本。

**预期结果**：根目录出现 `node_modules/`；git 状态保持干净（node_modules 被 gitignore）。

**如果失败**：

- 超时/下载失败 → 网络或代理问题，配好代理或镜像源后重试
- 报 Node 版本不支持 → 升级 Node 到 22.19+
- 不要用管理员权限硬装，普通用户目录即可

## 步骤 2 · 生成模型数据：npm run hydrate:model-data

这是整个阶段 0 里最容易懵、也最值得弄懂的一步。

**先搞清"模型数据"是什么、为什么不在 git 里**

模型数据 = 每个模型的目录信息：上下文窗口、价格、能力标记等（比如"某模型上下文多长、每百万 token 多少钱"）。

- 生成器（`packages/ai/scripts/generate-models.ts`）负责从上游目录（OpenRouter、Vercel AI Gateway、Radius 等）抓取并计算这批数据；
- 生成结果分两部分：
  - **代码骨架**：`src/models.generated.ts` 和 `providers/*.models.ts`——已提交进 git；
  - **数据文件**：`src/providers/data/*.json`——被 gitignore，不在 git 里。
- 而代码骨架会 `import "./data/anthropic.json"` 这样直接引用数据文件——所以新克隆的源码树**必须先生成数据才能运行**。

为什么不把数据提交进 git（通关自检会考）：

1. 它是派生数据：由生成器从上游抓取计算得到，不是手写源码；
2. 上游变动频繁：新模型、调价很常见，提交进去只会带来噪音 diff 和合并冲突；
3. 可再生：本地一条命令、或构建/发布时重新生成。正式发布的 npm 包里会带上这份数据，所以只有"从源码运行"才需要自己补。

**执行**：

```powershell
npm run hydrate:model-data
```

（实际执行的是 `packages/ai` 下的 `generate-models.ts --strict --data-only`。）

**它做了什么**：按已提交的 provider 清单，联网抓取上游目录 → 在临时目录生成每个 provider 的 JSON + `.manifest.json` → 校验通过后原子替换 `src/providers/data/`（校验失败会回滚，不会留下半成品）。

**预期结果**：输出 `Hydrated JSON model values under src/providers/data/`；打开 `packages/ai/src/providers/data/` 能看到 `anthropic.json`、`openai.json`……和 `.manifest.json`。

**注意**：

- 这一步需要网络；`--strict` 模式下抓取失败会直接报错退出（多为网络/代理问题，重试即可）。
- 别和相近命令混淆：`hydrate:model-data` 只补数据（学习期只用这个）；`generate-models` 连代码骨架一起重新生成；`npm run build` 是全量构建——学习期不需要，也不要随便跑（会让工作区不再是"干净的参考副本"）。

## 步骤 3 · 验证版本

两条命令，确认两件事：

```powershell
git describe --tags        # 应输出 v1.3.0 —— 确认学习区没跑偏
.\pi-test.ps1 --version    # 应输出 1.3.0  —— 确认源码版能启动
```

**`pi-test.ps1` 是什么**：一个很薄的包装器。它用 Node 直接运行 `packages/coding-agent/src/cli.ts`（不先构建），并注入一个源码解析器让包内导入能对上号；命令行参数原样转发给 pi。它从自己的位置取源码，所以**在任何目录运行的都是同一份源码**。

但要记住一个区别：**Pi 的"工作目录"是你执行命令时所在的目录**——工具能碰哪些文件、会话归到哪个项目、上下文文件从哪里发现，都以它为准。所以"让它总结某个仓库"之前，先 cd 到那个仓库。

**如果报"禁止运行脚本"（PowerShell 执行策略）**：

```powershell
powershell -ExecutionPolicy Bypass -File .\pi-test.ps1 --version
```

或只对当前会话放行：`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

**一个小工具**：`pi-test.ps1 --no-env` 会在启动前临时清掉一批 API key 环境变量（模拟干净环境），排查"凭据到底从哪来"时有用。

## 步骤 4 · 跑一次非交互任务（-p）

**执行**（在学习区目录）：

```powershell
.\pi-test.ps1 -p "总结这个仓库的目录结构"
```

**`-p`（--print）**：非交互模式——发一条消息，等它把活干完，输出最终结果后直接退出。适合快速验证与脚本化（阶段 7 会系统讲 print / JSON / RPC / SDK 几种形态）。

**前提：要有模型凭据**。首次使用先在交互模式里 `/login`（选一家 provider 完成登录或填 API key），或配置对应环境变量（`pi-test.ps1` 里列出了一批 `*_API_KEY` 名单，可作为线索）。没有任何凭据时，这一步会直接提示需要认证。

**你会观察到**：它不是"空口总结"——会真的调用工具（列目录、读文件，可能多轮）再给出结论。这顺带预习了后面两个核心概念：阶段 2 的"循环"和阶段 4 的"工具调用"。想看每一步细节，换成 `--mode json` 就有完整事件流（阶段 1 展开）。

**项目信任小提示**：print / JSON / RPC 模式不会弹"信任本项目"的交互提示，默认跳过项目里受保护资源；需要时加 `--approve`。交互模式下相反，会问你。

## 步骤 5 · 进交互模式真实聊一轮

**执行**：

```powershell
.\pi-test.ps1
```

**你会看到**：全屏 TUI。底部有输入框和状态栏；消息发出后回答流式上屏；工具调用以独立块展示。

**第一次进来先做这几件事**：

- 输入 `/`：弹出命令菜单——当前会话可用命令的权威列表
- `/login`：登录 provider（没有凭据时必做）
- `/model`：查看/切换模型
- `/hotkeys`：查看当前生效的快捷键

**几个关键按键**：

- `Esc`：中止当前回合（干活时的"刹车"）
- `Ctrl+C`：第一次清空输入框，再按一次退出
- `Ctrl+D`：输入框为空时直接退出；也可以 `/quit`

**聊点真实的**：比如"读一下这个仓库的 README，用三句话总结"。观察流式输出、工具块，以及它真的读了文件。

**两个小知识**：

- 学习区（pi 仓库自己）带 `.pi/skills/` 这类受保护资源，交互模式第一次会弹项目信任提示——选什么看你想不想加载它们；`/trust` 可以记住决定。（信任机制保护什么、不保护什么，阶段 4 展开。）
- 配置与会话默认写到 `~/.pi/agent`（Windows：`C:\Users\<你>\.pi\agent`）；按工作目录存放的会话 JSONL 在 `sessions/` 下——这是阶段 3 的现成素材，聊完可以去翻翻。

## 步骤 6 · 读 README 两节

**Packages 表**：README 里列了 7 个对外发布的包（chord / telemetry / ai / durable / agent / coding-agent / tui）；仓库实际有 11 个包。现在快速过一眼混个脸熟，"每包一句话职责"的自检见下一节。

**Permissions & Containerization**（务必看，记住结论）：

- Pi **没有**内置的权限沙箱——默认以启动它的用户/进程权限运行，能访问的就是你能访问的；
- 需要更强边界时用容器化，文档给了三种模式：Gondolin 扩展（pi 与凭据留在宿主机，内置工具和 ! 命令路由进本地 Linux 微 VM）、整进程进 Docker、整进程进 OpenShell 策略沙箱。

为什么现在就读：阶段 4 讲工具权限与安全模型时会回扣；更重要的是，你之后让 Pi 在自己的项目里干活前，应该先想清楚它的权限边界。

## 通关自检（对照阶段 0 的三条标准）

**① 两种形态都跑通**

- [ ] `.\pi-test.ps1 --version` 正常输出 1.3.0
- [ ] `-p` 任务真实完成并给出结果
- [ ] 交互模式聊过一轮

**② 能说出每个包的一句话职责**（先自己回忆，再看答案）

| 包 | 一句话职责 |
| --- | --- |
| agent | 通用 Agent 运行时：工具调用循环与状态管理，与 UI/具体模型解耦 |
| ai | 统一多供应商 LLM API：流式事件归一化 + 模型目录 |
| coding-agent | 完整应用：把会话、工具、模式、界面组装成 coding agent CLI |
| tui | 终端 UI 库：差分渲染 |
| mcp | 独立的 MCP 客户端（外部工具协议） |
| codemode | 沙箱 JS 运行时：唯一能力是调用注入的工具 |
| chord | 插件宿主运行时：热重载、契约、复制状态、JSON-RPC |
| durable | 持久化对话/任务/文档运行时 |
| env | 远程执行环境（SSH 部署的守护进程 + 客户端） |
| telemetry | 遥测数据的共同格式：统一事件和指标的结构，不绑定某家厂商 |
| evals | 评测框架 |

“供应商中立”指不依赖某家监控厂商；“类型化 schema”指事件、指标有哪些字段、各是什么类型，有一份统一且可检查的定义。Pi 只按这个格式提供记录接口，接不接 OpenTelemetry、Sentry 或自己的日志，由应用自己决定。

依赖方向与分层（谁是谁的底座）留到阶段 1 的全局地图。

**③ 模型数据为什么不进 git**（用三句话回答）

- 派生数据：由生成器从上游目录抓取计算，不是手写源码；
- 变动频繁：上游常更新，进 git 只有噪音 diff 和冲突；
- 可再生：本地/构建期重新生成，发布包里会带；仓库只提交生成器与代码骨架。

## 常见问题速查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| npm install 超时/失败 | 网络或代理 | 配置代理/镜像源后重试 |
| hydrate 报 fetch 失败 | 抓不到上游目录（--strict 直接报错） | 检查网络/代理，重试 |
| 运行时找不到 `./data/*.json` | 模型数据没生成 | 回到步骤 2 |
| "禁止运行脚本" | PowerShell 执行策略 | `powershell -ExecutionPolicy Bypass -File .\pi-test.ps1 ...` |
| 提示需要认证 | 没有任何凭据 | 交互模式 `/login` 或配置环境变量 |
| 交互模式问"是否信任" | 在含 `.pi/` 的目录运行 | 按需选择；`/trust` 记住决定 |
| 想排查凭据来源 | — | `pi-test.ps1 --no-env` 清空环境变量启动 |

## 做完之后

- 回到[学习路线](../learning-path/)，把阶段 0 的勾选框勾上。
 - 下一站：**阶段 1 · 全局地图**（配套详解：[阶段 1](../stage-1/)）。带着一个具体问题去读 `packages/coding-agent/docs/how-pi-works.md`："一条消息从进来到落盘，到底经过了什么？"

---

*配套[学习路线](../learning-path/)阶段 0 编写 · 2026-10-19 · 基于 v1.3.0（`71023aec`）*
