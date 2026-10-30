# Cairn Notes

> 一路学习，一路留标。  
> Notes left along the way.

[Cairn Notes](https://jasonbuildai.github.io/cairn-notes/) 是一个持续生长的公开学习档案。它只收录经过筛选、版本固定、可以复核的系统学习笔记，不发布完整的私人资料库。

## 当前收录

| Collection | Focus | Version | Notes |
| --- | --- | --- | --- |
| Pi | 最小 Agent Harness：循环、上下文、工具、扩展与入口 | v1.3.0 · `71023aec` | 13 |
| OpenSandbox | AI 执行平台：生命周期、运行时、网络、凭据与证据流 | release-1.1.1 · `531700ca` | 14 |

## 这里发布什么

- 原创的学习路线、架构拆解、实验记录与失败边界。
- 与具体 release/commit 绑定的技术笔记。
- 可以迁移到其他 Agent/运行时系统的判断方法。
- 短代码示例、调用链和架构图。

## 这里不发布什么

- 上游项目的完整源码、`.git` 目录或 release 压缩包。
- 本地路径、私有配置、凭据或环境快照。
- 未经核实的第三方素材。
- 为了凑数量而公开的半成品笔记。

源码请始终从上游官方仓库获取。笔记中的 `$PI_SRC`、`$OSB_SRC` 只表示读者自己的本地源码目录。

## 本地开发

要求 Node.js >= 22.23.4。

```bash
npm install
npm run dev
npm run build
npm run preview
```

构建前会自动运行公开内容检查：

```bash
npm run check:content
```

检查会阻止个人绝对路径、常见密钥、上游源码目录和压缩包进入公开站点。

## 仓库结构

```text
.
├── src/content/docs/       # 公开笔记与站点文案
│   ├── pi/
│   └── opensandbox/
├── src/styles/custom.css   # 视觉主题
├── public/                 # favicon、OG 图与静态资产
├── scripts/                # 内容检查与品牌资产生成
└── .github/workflows/      # GitHub Pages 自动部署
```

站点使用 [Astro Starlight](https://starlight.astro.build/) 构建，搜索由 Starlight/Pagefind 提供，部署到 GitHub Pages。

## 许可与版权

- 学习笔记与原创文字：CC BY-SA 4.0。
- 站点代码与构建配置：MIT。
- 上游项目名称、源码和文档：归各自作者，适用各自许可。

本站与 Pi、OpenSandbox 的维护者没有隶属或背书关系。完整说明见 [NOTICE.md](NOTICE.md) 和站点的“来源与版权”页面。

## 纠错

发现事实错误、版本漂移或引用问题时，请开 [GitHub Issue](https://github.com/JasonBuildAI/cairn-notes/issues)。