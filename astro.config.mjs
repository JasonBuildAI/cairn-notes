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
			description: '我学习 AI Agent 时整理的笔记，主要包括 Pi 和 OpenSandbox。',
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
			editLink: {
				baseUrl: 'https://github.com/JasonBuildAI/cairn-notes/edit/main/',
			},
			customCss: ['./src/styles/custom.css'],
			head: [
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#203029' } },
				{ tag: 'meta', attrs: { name: 'copyright', content: 'Cairn Notes · CC BY-SA 4.0' } },
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
					label: '关于本站',
					items: [
						{ label: '为什么做 Cairn Notes', slug: 'about' },
						{ label: '来源与版权', slug: 'rights' },
					],
				},
			],
		}),
		sitemap(),
	],
});