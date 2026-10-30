---
title: "选修区：按需深入"
description: "按需深入的扩展路线：多模型、远程会话、插件与更复杂的集成。"
---

> 对应[学习路线](../learning-path/)选修区（按需）。本文件是配套导读，不替代清单里的判断标准。
> 前置：阶段 0–9 走完后效果最好；也可以把它当字典——学到相关模块时跳读对应小节。
> 源码目录：`$PI_SRC`。文中路径都相对于该目录。

## 为什么有选修区

主线的七块（循环 / 上下文 / 工具 / 模型 / 扩展 / 界面 / 工程）学完，你已经能读、能改、能扩；选修区是五张「规模化」的牌，共同点是：**不是做一个 Agent 必需的，而是把 Agent 做成平台/产品时才需要的**。

| 话题 | 一句话 | 解决什么问题 | 与主线接口 | 何时值得深入 |
| --- | --- | --- | --- | --- |
| telemetry | 遥测契约 | 让循环、工具、模型调用可观测（耗时、因果、指标），又不绑定任何监控后端 | 阶段 2 的循环、阶段 7 的事件流 | 要把 Pi 接进公司监控体系时 |
| durable | 持久化运行时 | 进程崩溃后从断点恢复，而不是整轮重跑 | 阶段 2 的循环恢复、阶段 3 的会话落盘 | 做长任务 / 后台代理时 |
| env | 远程执行环境 | 工具在另一台机器上执行（走 SSH），存储与凭据留在本地 | 阶段 4 的工具执行关口 | 本机跑不动或要求隔离时 |
| chord | 插件宿主 | 跨进程对象、热重载、按 principal 分权 | 阶段 6 的扩展宿主、阶段 3 的状态重建 | 要做 IDE 级 / 多端协作应用时 |
| evals | 评测框架 | 用对照实验回答「文档 / 改动让 agent 变好了吗」 | 阶段 8 的测试哲学 | 想量化产品质量时 |

判断标准（沿用清单）：先看目标岗位或项目是否需要，再决定投入；不需要时，记住「是什么 + 入口」即可——本文件就是为这个服务的。如果决定学，推荐的投入顺序是：

```
由浅入深（投入时间）：
telemetry ── evals ── env ── durable ── chord
 契约观察     行为验证    执行位置    崩溃恢复    宿主模型
```

前三块只加「观察与验证」，不动运行时；durable 和 chord 动的是运行时的地基，放后面。

## 五块怎么读

### 1 · telemetry——先读它（30–60 分钟）

**是什么**：一组不绑定监控厂商的遥测接口（`TelemetryContext` / `TelemetrySpan`，回调式 API），加上描述事件数据结构、可序列化的 schema 与推导类型。自带的只有 `NOOP_TELEMETRY_CONTEXT`（什么都不做的默认值）与 `InMemoryTelemetryContext`（参考实现）。**不包含**导出器、全局 span 状态，也不依赖任何后端——接 OpenTelemetry、Sentry 还是自家日志，由应用自己写适配器。

**为什么这样设计**：库作者不替你选后端，也不让「有没有接监控」影响包的行为——观察点做成显式传入的 context：不传就是 NOOP，零成本、零依赖。

**入口与读法**：

- `packages/telemetry/README.md`——按目录顺序读：Concepts → Core Context API → Adapter Contract → No-op → In-Memory；
- 最小验证（建议做，成本最低）：把 NOOP 换成 `InMemoryTelemetryContext`，跑一次阶段 2 的循环，把 span 打印出来——你会看到「一次模型请求」「一次工具执行」的层级结构。

**与主线的关系**：阶段 2 里的「协调者」负责事件传播，telemetry 是同一件事的通用化接口；阶段 9 的 mini agent 也会用到类似的事件观察。想继续深入 telemetry 的传播、span links 和指标，先掌握这层契约。

### 2 · evals——半天到 1 天

**是什么**：Pi coding agent 的行为级评测框架，建立在 `vitest-evals` 之上。两类评测：

- `*.docs.eval.ts`：文档提升实验——同一用例分别在无文档（without_docs）与有文档（with_docs）的隔离容器里跑，报告提升（lift）；
- 其余 `*.eval.ts`：主机评测，在本机用 Vitest 直接跑。

runner 代码在 `src/`：`cli.ts`（协调对照）、`docker.ts`（构建两个镜像、跑隔离的一支）、`plan.ts`（展开任务）、`report.ts`（配对并计算 lift）、`harness.ts`（适配器）。

**为什么有意思**：它把「文档到底有没有用」做成了可测量的对照实验——这是阶段 8「测试怎么写」的上一层：从单元行为升级到系统行为。

**入口与读法**：`packages/evals/README.md` 全文（不长）→ 再读 `src/report.ts` 看 lift 如何配对与计算。`eval:docs` 需要 Docker 且消耗算力/token，第一次建议只读不跑，或挑单个用例。

### 3 · env——半天到 1 天

**是什么**：给 Pi Durable 用的远程执行环境。两块：

- `pi-env`（Rust，`daemon/`）：部署在远端的守护进程，用 stdin/stdout 的说帧协议做文件操作与命令（`docs/protocol.md`）；
- `RemoteExecutionEnv`：本地侧客户端，结果语义与本地 `NodeExecutionEnv` 对齐（`docs/semantics.md`），只有错误文案可能不同。

**安全细节值得看一眼**：首次连接要人工核对主机密钥指纹（host key）并写入 known_hosts；守护进程按 SHA-256 命名、每次启动前校验——「远程执行」这类能力，信任建立本身就是设计的一部分。

**与主线的关系**：阶段 4 的八道关口里有一关「执行」；env 把「在哪执行」变成可替换的一层——又一次印证「引擎只认接口」：换执行位置，不动循环、不动工具定义。

### 4 · durable——1–2 天（标注 Experimental）

**是什么**：持久化 agent 运行时，设计要点一句话：**先提交、再展示**——对话、模型回合、工具调用与自定义状态先落存储，然后才对外可见；进程中途死掉，重开存储就从断点接着干。它构建在 `packages/ai`（模型接入）与 `chord`（文档状态）之上——正好是选修区里的另两块。

**与阶段 2 对照**：你学过循环的重试与恢复边界；durable 是这条线的极限形态——不是「重试当前请求」，而是「重启后继续没做完的回合」。

**入口与读法**：`packages/durable/README.md`（Quick Start → Concepts → Persist and Resume）→ `packages/durable/docs/spec.md` 当参考手册。注意 README 开头的 Experimental 声明：API 会不带通知地变化；源码目录固定在 v1.3.0，读到的是稳定快照。

### 5 · chord——1–2 天（选修区里最深的一块）

**是什么**：把应用拆成「对象」并跨进程运行（server、worker、浏览器标签页），支持热重载。五个概念：

- **对象**：地址上的状态 + 代码，按需创建，被引用则存活；
- **引用**：拿到的是引用而不是对象；跨进程与热重载都有效；
- **principal**：每个对象知道自己的拥有者——owner 与 guest 看到不同的对象、不同的方法；
- **状态**：可观察 JSON，远程观看者先收快照、再收增量；
- **热重载**：在飞的工作跑完旧代码、状态保留、不兼容变更在安全点迁移。

契约是运行时的 TypeBox schema，宿主之间用 JSON 帧走链接（内存 / Node IPC / WebSocket）。

**为什么值得最后读**：它把阶段 6 的「扩展宿主」推进到基础设施级——热重载、跨进程、分权；阶段 3 里「从记录重建状态」的思路，在这里变成通用的快照 + 增量复制机制。

**入口与读法**：`packages/chord/docs/tutorial.md` → `guide.md` → `spec.md`；README 的 Entry points 表当索引用。

## 缓存与诊断（生产化工具箱）

不做平台也该知道这几个名字——它们是「成本」与「稳定性」两类问题的现成抓手：

| 工具 | 位置（v1.3.0） | 做什么 | 什么时候想起它 |
| --- | --- | --- | --- |
| cache warmer | `packages/coding-agent/src/core/cache-warmer.ts` | 为 prompt cache 做续热，降低缓存未命中带来的成本；由 `cacheWarming` 设置控制（off / streaming / idle，idle 还会在两次任务之间续热） | 长会话、反复跑同一项目、成本敏感时 |
| cache stats | `packages/coding-agent/src/core/cache-stats.ts` | 缓存命中 / 未命中的统计与展示；`showCacheMissNotices` 设置控制是否提示未命中 | 想知道「这次为什么贵」时 |
| crash log | `packages/coding-agent/src/core/crash-log.ts` | 记录崩溃（`recordCrash`），支持把崩溃栈片段与已装扩展做匹配（定位可疑扩展）；交互式启动会提示上次未处理的崩溃 | 会话莫名其妙中止时 |
| diagnostics | `packages/coding-agent/src/core/diagnostics.ts` | 资源冲突与诊断的类型定义（`ResourceDiagnostic` / `ResourceCollision`）——同名资源来自不同来源时用来汇报 | 技能 / 命令 / 模板疑似互相覆盖时 |
| settings diagnostics | `packages/coding-agent/src/core/settings-diagnostics.ts` | 汇总并去重设置层面的问题（`collectSettingsDiagnostics` / `deduplicateDiagnostics`） | 怀疑设置写错或被忽略时 |

这些不算「阶段」，不必排学习计划；遇到对应症状时回来查这张表即可。

## 通关自检（选修区版）

- [ ] 能说出五块各自解决什么问题、和主线哪一阶段相接；
- [ ] 至少选一块做出「最小验证」（建议 telemetry 或 evals，成本最低）；
- [ ] 对没选的块，能说出一句「为什么现在不学」。

## 常见问题速查

| 疑问 | 解答 |
| --- | --- |
| 这五块难吗？ | 入口都是各包 README，行文很直；读不懂就退回去只记「是什么 + 入口」，不算失败。 |
| 它们会改变我学过的东西吗？ | 不会，是放大：telemetry / evals 只加观察与验证；env / durable 改的是「跑在哪、怎么恢复」；chord 最深，动的是宿主模型。 |
| 必须先全部学完吗？ | 不。清单的判断标准是「先看需不需要」；本文件的顺序只在你决定学时用来排序。 |
| 版本会变怎么办？ | 以学习区 v1.3.0 快照为准；durable 是 Experimental，升级时对照各包 CHANGELOG。 |

## 做完之后

- 回到[学习路线](../learning-path/)选修区，按判断标准给自己的清单做标记（学 / 暂缓）。
- 到这里，整套教材闭环：**清单（纲）→ 架构总览（全景）→ 阶段 0–9（分层精读）→ 本导读（按需深入）**。之后的学习方式按阶段 9：读源码 → 做实验 → 回读文档 → 再实现。

---

*配套[学习路线](../learning-path/)选修区编写 · 2026-10-19 · 基于 v1.3.0（`71023aec`）*
