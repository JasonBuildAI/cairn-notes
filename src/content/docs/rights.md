---
title: 来源与版权
description: Cairn Notes 的内容许可、上游项目归属、源码分发边界与纠错方式。
---

## 许可范围

| 对象 | 许可 | 说明 |
| --- | --- | --- |
| 学习笔记、原创文字与图表 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | 允许分享与改编，需署名并以相同方式共享。 |
| 站点代码、构建脚本与配置 | [MIT](https://github.com/JasonBuildAI/cairn-notes/blob/main/LICENSE) | 可自由使用、修改与分发，保留版权与许可声明。 |
| 上游项目源码与名称 | 各自许可 | 本站不重新授权，也不代表上游项目。 |

建议引用格式：

> Cairn Notes，《页面标题》，<https://jasonbuildai.github.io/cairn-notes/>，CC BY-SA 4.0。

## 上游项目

这两套笔记分别基于以下开源项目整理。版本与提交固定，便于核查：

| 项目 | 学习版本 | 提交 | 上游许可 | 官方来源 |
| --- | --- | --- | --- | --- |
| Pi | v1.3.0 | `71023aec` | MIT | <https://github.com/earendil-works/pi> |
| OpenSandbox | release-1.1.1 | `531700ca` | Apache-2.0 | <https://github.com/opensandbox-group/OpenSandbox> |

相关完整许可文本位于仓库的 [`LICENSES/`](https://github.com/JasonBuildAI/cairn-notes/tree/main/LICENSES) 目录。Cairn Notes 与上述项目的维护者没有隶属或背书关系。

## 为什么没有上传源码

Cairn Notes 只发布学习笔记、架构分析与短代码示例。公开仓库不包含：

- 上游仓库的完整源码或 `.git` 目录；
- 官方 release 压缩包；
- 本地环境快照、私有配置或凭据；
- 可能受第三方条款约束的素材。

如果你要运行实验，请从官方仓库检出上表对应的版本。笔记中的 `$PI_SRC`、`$OSB_SRC` 等写法只表示读者自己的本地源码目录。

## 引用与代码示例

笔记中的少量代码片段用于说明 API 用法、调用链或失败边界。原创示例随笔记按 CC BY-SA 4.0 提供；若片段来自上游项目，其版权与许可仍归原作者，并受相应上游许可约束。

上游名称、商标和产品标识仅用于说明来源与讨论技术问题。本站不声称获得任何官方认证。

## 纠错与下架

如果发现事实错误、版本漂移、遗漏署名，或认为某段内容超出了合理引用范围，请通过 [GitHub Issues](https://github.com/JasonBuildAI/cairn-notes/issues) 联系。我会先核实，再修正、补充署名或移除相关内容。