// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

const site = 'https://jasonbuildai.github.io';
const base = '/cairn-notes';

const stages = (prefix, labels) =>
	labels.map((label, index) => ({
		label: `${index} · ${label}`,
		slug: `${prefix}/stage-${index}`,
	}));

export default defineConfig({
	site,
	base,
	trailingSlash: 'always',
	integrations: [
		starlight({
			title: 'Cairn Notes',
			description: '我学习 AI Agent 时整理的笔记，包括 Pi、OpenSandbox 和通用软件工程基础。',
			logo: {
				src: './src/assets/cairn-mark.svg',
				alt: 'Cairn Notes',
				replacesTitle: false,
			},
			favicon: '/favicon.svg',
			locales: {
				root: { label: '简体中文', lang: 'zh-CN' },
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/JasonBuildAI/cairn-notes',
				},
			],
			customCss: ['./src/styles/custom.css'],
			head: [
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#203029' } },
				{ tag: 'meta', attrs: { name: 'copyright', content: 'Cairn Notes · CC BY-SA 4.0 / CC BY-NC-SA 4.0' } },
				{ tag: 'link', attrs: { rel: 'license', href: 'https://github.com/JasonBuildAI/cairn-notes/blob/main/CONTENT-LICENSE.md' } },
				{ tag: 'meta', attrs: { property: 'og:image', content: `${site}${base}/og-image.png` } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
				{ tag: 'link', attrs: { rel: 'manifest', href: `${base}/site.webmanifest` } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}/apple-touch-icon.png` } },
			],
			sidebar: [
				{
					label: 'Pi 1.3.0',
					items: [
						{ label: '总览与架构', slug: 'pi' },
						{ label: '学习路线', slug: 'pi/learning-path' },
						{
							label: '十个阶段',
							items: stages('pi', [
								'跑起来',
								'系统地图',
								'Agent 循环',
								'上下文',
								'工具',
								'模型接入',
								'扩展与技能',
								'界面与集成',
								'工程化',
								'重建 mini agent',
							]),
						},
						{ label: '选修区', slug: 'pi/electives' },
					],
				},
				{
					label: 'OpenSandbox 1.1.1',
					items: [
						{ label: '学习区总览', slug: 'opensandbox' },
						{ label: '整体架构', slug: 'opensandbox/architecture' },
						{ label: '学习路线', slug: 'opensandbox/learning-path' },
						{
							label: '十个阶段',
							items: stages('opensandbox', [
								'跑起来',
								'系统地图',
								'生命周期',
								'执行与文件',
								'运行时',
								'网络与凭据',
								'接口与契约',
								'Agent 集成',
								'工程与生产',
								'毕业设计',
							]),
						},
						{ label: '选修区', slug: 'opensandbox/electives' },
					],
				},
				{
					label: '工程基础',
					items: [
						{ label: '学习说明', slug: 'engineering' },
						{ label: '工程全景与实例', slug: 'engineering/end-to-end' },
						{ label: '计算机系统一页通', slug: 'engineering/computer-systems' },
						{
							label: '开发环境与工具',
							items: [
								{ label: '可复现环境', slug: 'engineering/reproducible-environment' },
								{ label: 'Git 与调试', slug: 'engineering/git-and-debugging' },
							],
						},
						{
							label: '浏览器与前端',
							items: [
								{ label: '浏览器运行模型', slug: 'engineering/browser-model' },
								{ label: '前端工程与应用设计', slug: 'engineering/frontend-for-ai' },
							],
						},
						{
							label: '服务器与后端',
							items: [
								{ label: '请求与 API', slug: 'engineering/backend-requests' },
								{ label: '并发与缓存', slug: 'engineering/backend-scale' },
								{ label: '语言与结构', slug: 'engineering/backend-structure' },
							],
						},
						{
							label: '数据',
							items: [
								{ label: '数据库与存储', slug: 'engineering/data-storage' },
								{ label: '指标与治理', slug: 'engineering/data-products' },
							],
						},
						{
							label: '架构与系统设计',
							items: [
								{ label: '分布式与高可用', slug: 'engineering/architecture-reliability' },
								{ label: '系统设计方法', slug: 'engineering/system-design' },
							],
						},
						{
							label: '基础设施与运维',
							items: [
								{ label: 'Linux 与部署', slug: 'engineering/linux-containers-deploy' },
								{ label: '网络与云安全', slug: 'engineering/network-cloud-security' },
								{ label: '可观测性', slug: 'engineering/observability-incidents' },
							],
						},
						{
							label: '模型系统',
							items: [
								{ label: '大模型与多模态', slug: 'engineering/llm-foundations' },
								{ label: 'RAG 与 Agent', slug: 'engineering/rag-and-agents' },
								{ label: '模型生命周期', slug: 'engineering/model-lifecycle' },
							],
						},
						{
							label: '工程素养',
							items: [
								{ label: '代码与测试', slug: 'engineering/code-testing-design' },
								{ label: '安全与交付', slug: 'engineering/security-and-delivery' },
							],
						},
					],
				},
				{
					label: '关于本站',
					items: [
						{ label: '关于这里', slug: 'about' },
						{ label: '来源与版权', slug: 'rights' },
					],
				},
			],
		}),
		sitemap(),
	],
});
