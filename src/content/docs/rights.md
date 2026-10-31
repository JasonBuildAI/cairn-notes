---
title: 来源与版权
description: Cairn Notes 的内容许可、上游项目归属、四套源码课与工程基础的改写范围与纠错方式。
---

## 许可范围

- **Pi、OpenSandbox 与四套源码课学习笔记**：[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。允许分享与改编，需署名并以相同方式共享。
- **工程基础（`engineering/`）**：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)。改编自 EasyVibe，允许非商业分享与改编，需署名并以相同方式共享。
- **站点代码、构建脚本与配置**：[MIT](https://github.com/JasonBuildAI/cairn-notes/blob/main/LICENSE)。可自由使用、修改与分发，保留版权与许可声明。
- **上游项目源码、名称与素材**：各自许可。本站不重新授权，也不代表上游项目。

如果把整站内容一起转载，必须同时满足两种 CC 许可；其中工程基础不能用于商业用途。不要把整站笼统标成一个许可证。

## 上游项目

### Pi

- 学习版本：v1.3.0，`71023aec`
- 上游许可：MIT
- 来源：<https://github.com/earendil-works/pi>

### OpenSandbox

- 学习版本：release-1.1.1，`531700ca`
- 上游许可：Apache-2.0
- 来源：<https://github.com/opensandbox-group/OpenSandbox>

### DeerFlow

- 学习版本：v2.1.0，`345f08be`
- 上游许可：MIT
- 来源：<https://github.com/bytedance/deer-flow>

### LoopX

- 学习版本：v2.1.1，`87e5b4f8`
- 上游许可：Apache-2.0
- 来源：<https://github.com/loopx-project/loopx>

### OpenClaw

- 学习版本：2026.10.9 发布归档
- 上游许可：MIT
- 来源：<https://github.com/openclaw/openclaw>

### Hermes Agent

- 学习版本：v0.22.5 发布归档
- 上游许可：MIT
- 来源：<https://github.com/NousResearch/Hermes-Agent>

### EasyVibe

- 核对版本：`main`，`f2239c67`（2026-10-22）
- 上游许可：CC BY-NC-SA 4.0
- 来源：<https://github.com/DatawhaleChina/easy-vibe>

EasyVibe 的许可声明写在其上游 README 中。工程基础对应其附录第一至第九章的 104 个 Markdown 文件，但不是逐篇翻译或转载。第一章高度压缩；其余章节按通用软件工程的学习路径合并、删减、重排和补充，并改写为静态表格、ASCII 流程图、短示例和检查表。模型、检索与 Agent 作为专门系统放在最后一章，不另立一套工程方法。此外新增《从需求到稳定运行：工程全景》，用自定义案例串联各章，属于本组笔记的再整理。

本站没有复制上游图片、动画、交互组件或完整课程页面。示例和表格由笔记需要重新整理。若发现归属或引用边界有问题，请通过 Issue 联系，我会核实后修正或移除。

相关完整许可文本位于仓库的 [`LICENSES/`](https://github.com/JasonBuildAI/cairn-notes/tree/main/LICENSES) 目录。Cairn Notes 与上述项目的维护者没有隶属或背书关系。

## 引用方式

引用 Pi、OpenSandbox 或四套源码课笔记时，建议写成：

> Cairn Notes，《页面标题》，<https://jasonbuildai.github.io/cairn-notes/>，CC BY-SA 4.0。

引用工程基础时，建议写成：

> Cairn Notes，《页面标题》，adapted from EasyVibe by Datawhale / EasyVibe contributors，CC BY-NC-SA 4.0，有修改。

## 为什么没有上传源码

公开仓库不包含：

- 上游仓库的完整源码或 `.git` 目录；
- 官方 release 压缩包；
- 上游图片、动画和交互组件；
- 本地环境快照、私有配置或凭据。

如果你要运行实验，请从官方仓库检出上面列出的对应版本。笔记中的 `$PI_SRC`、`$OSB_SRC`、`$DEERFLOW_SRC`、`$LOOPX_SRC`、`$OPENCLAW_SRC`、`$HERMES_SRC` 等写法只表示读者自己的本地目录。

## 纠错与下架

如果发现事实错误、版本漂移、遗漏署名，或认为某段内容超出了合理引用范围，请通过 [GitHub Issues](https://github.com/JasonBuildAI/cairn-notes/issues) 联系。我会先核实，再修正、补充署名或移除相关内容。

这个仓库只处理 Issue，不接受 Pull Request。
