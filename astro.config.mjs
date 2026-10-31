// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

const site = 'https://jasonbuildai.github.io';
const base = '/cairn-notes';

const enLabels = {
	'DeerFlow 2.1': 'DeerFlow 2.1',
	'Git 与调试': 'Git and Debugging',
	GitHub: 'GitHub',
	'Hermes Agent 0.22.5': 'Hermes Agent 0.22.5',
	'Linux 与部署': 'Linux and Deployment',
	'LoopX 2.1.1': 'LoopX 2.1.1',
	'OpenClaw 2026.10.9': 'OpenClaw 2026.10.9',
	'OpenSandbox 1.1.1': 'OpenSandbox 1.1.1',
	'Pi 1.3.0': 'Pi 1.3.0',
	'RAG 与 Agent': 'RAG and Agents',
	'一条消息的一生': 'Life of a Message',
	'一次 Run 的一生': 'Life of a Run',
	'一次 Turn 的一生': 'Life of a Turn',
	'代码与测试': 'Code and Testing',
	'全局地图': 'Global Map',
	'关于本站': 'About This Site',
	'关于这里': 'About',
	'分布式与高可用': 'Distributed Systems and High Availability',
	'前端工程与应用设计': 'Frontend Engineering and Application Design',
	'十个阶段': 'Ten Stages',
	'可复现环境': 'Reproducible Environments',
	'可观测性': 'Observability',
	'基础设施与运维': 'Infrastructure and Operations',
	'大模型与多模态': 'Large Models and Multimodality',
	'学习区总览': 'Course Overview',
	'学习说明': 'How to Use These Notes',
	'学习路线': 'Learning Path',
	'安全与交付': 'Security and Delivery',
	'工程全景与实例': 'Engineering End to End',
	'工程基础': 'Engineering Fundamentals',
	'工程实战': 'Engineering in Practice',
	'工程素养': 'Engineering Craft',
	'并发与缓存': 'Concurrency and Caching',
	'开发环境与工具': 'Development Environment and Tools',
	'总览与架构': 'Overview and Architecture',
	'指标与治理': 'Metrics and Governance',
	'数据': 'Data',
	'数据库与存储': 'Databases and Storage',
	'整体架构': 'Architecture',
	'服务器与后端': 'Servers and Backends',
	'来源与版权': 'Sources and Copyright',
	'架构与系统设计': 'Architecture and System Design',
	'核心机制': 'Core Mechanisms',
	'模型生命周期': 'Model Lifecycle',
	'模型系统': 'Model Systems',
	'浏览器与前端': 'Browsers and Frontend',
	'浏览器运行模型': 'Browser Runtime Model',
	'简体中文': '简体中文',
	'系统设计方法': 'System Design',
	'网络与云安全': 'Networking and Cloud Security',
	'计算机系统一页通': 'Computer Systems in One Page',
	'语言与结构': 'Languages and Structure',
	'请求与 API': 'Requests and APIs',
	'课程导读': 'Course Introduction',
	'选修区': 'Electives',
	'阶段导读': 'Stage Guide',
};

const enStageLabels = {
	'环境与源码地图': 'Environment and Source Map',
	'入口与 Run 生命周期': 'Entry and Run Lifecycle',
	'Agent 装配与 LangGraph 循环': 'Agent Assembly and the LangGraph Loop',
	'上下文与记忆': 'Context and Memory',
	'工具与 Sandbox': 'Tools and Sandbox',
	'模型接入与 Provider 适配': 'Model Access and Provider Adaptation',
	'持久化与恢复': 'Persistence and Recovery',
	'扩展渠道与多 Agent': 'Extended Channels and Multi-Agent',
	'工程化与故障排查': 'Engineering and Troubleshooting',
	'毕业设计': 'Capstone Project',
	'对象模型与控制面': 'Object Model and Control Plane',
	'ShouldRun 与 Quota': 'ShouldRun and Quota',
	'Turn 计划与事务': 'Turn Planning and Transactions',
	'Capability、Provider 与 Host': 'Capability, Provider, and Host',
	'验证、写回、配额与调度': 'Validation, Writeback, Quota, and Scheduling',
	'上下文投影与长期状态': 'Context Projection and Long-Term State',
	'CLI、Dashboard 与扩展': 'CLI, Dashboard, and Extensions',
	'工程化、测试与恢复': 'Engineering, Testing, and Recovery',
	'Gateway、Session 与 Run': 'Gateway, Session, and Run',
	'入口与 Agent Loop': 'Entry and Agent Loop',
	'上下文压缩与 Pruning': 'Context Compression and Pruning',
	'工具审批与 Sandbox': 'Tool Approval and Sandbox',
	'模型认证、Fallback 与 Harness': 'Model Auth, Fallback, and Harness',
	'Session、Transcript 与 Writer': 'Session, Transcript, and Writer',
	'插件、渠道、协议与 UI': 'Plugins, Channels, Protocols, and UI',
	'工程化、测试与运维': 'Engineering, Testing, and Operations',
	'跑起来': 'Get It Running',
	'系统地图': 'System Map',
	'Agent 循环': 'Agent Loop',
	'上下文': 'Context',
	'工具': 'Tools',
	'模型接入': 'Model Access',
	'扩展与技能': 'Extensions and Skills',
	'界面与集成': 'Interfaces and Integrations',
	'工程化': 'Engineering',
	'重建 mini agent': 'Rebuild a Mini Agent',
	'生命周期': 'Lifecycle',
	'执行与文件': 'Execution and Files',
	'运行时': 'Runtime',
	'网络与凭据': 'Networking and Credentials',
	'接口与契约': 'Interfaces and Contracts',
	'Agent 集成': 'Agent Integration',
	'工程与生产': 'Engineering and Production',
	'前端 Admission 与 Lease': 'Frontend Admission and Lease',
	'Conversation Loop': 'Conversation Loop',
	'Prompt、上下文与压缩': 'Prompt, Context, and Compression',
	'工具与 Persist Before Execute': 'Tools and Persist Before Execute',
	'Provider、凭据与 Fallback': 'Provider, Credentials, and Fallback',
	'SessionDB 与恢复': 'SessionDB and Recovery',
	'扩展平台与多 Agent': 'Extension Platforms and Multi-Agent',
	'工程化测试与排障': 'Engineering, Testing, and Troubleshooting',
};

const stages = (prefix, labels) =>
	labels.map((label, index) => ({
		label: `${index} · ${label}`,
		translations: { en: `${index} · ${enStageLabels[label] ?? label}` },
		slug: `${prefix}/stage-${index}`,
	}));

const courses = [
	{
		label: 'DeerFlow 2.1',
		prefix: 'deerflow',
		overviews: [
			{ label: '全局地图', slug: 'overview' },
			{ label: '一次 Run 的一生', slug: 'run-lifecycle' },
			{ label: '核心机制', slug: 'core-mechanisms' },
			{ label: '工程实战', slug: 'engineering' },
		],
		stages: ['环境与源码地图', '入口与 Run 生命周期', 'Agent 装配与 LangGraph 循环', '上下文与记忆', '工具与 Sandbox', '模型接入与 Provider 适配', '持久化与恢复', '扩展渠道与多 Agent', '工程化与故障排查', '毕业设计'],
	},
	{
		label: 'LoopX 2.1.1',
		prefix: 'loopx',
		overviews: [
			{ label: '全局地图', slug: 'overview' },
			{ label: '一次 Turn 的一生', slug: 'turn-lifecycle' },
			{ label: '核心机制', slug: 'core-mechanisms' },
			{ label: '工程实战', slug: 'engineering' },
		],
		stages: ['环境与源码地图', '对象模型与控制面', 'ShouldRun 与 Quota', 'Turn 计划与事务', 'Capability、Provider 与 Host', '验证、写回、配额与调度', '上下文投影与长期状态', 'CLI、Dashboard 与扩展', '工程化、测试与恢复', '毕业设计'],
	},
	{
		label: 'OpenClaw 2026.10.9',
		prefix: 'openclaw',
		overviews: [
			{ label: '全局地图', slug: 'overview' },
			{ label: '一条消息的一生', slug: 'message-lifecycle' },
			{ label: '核心机制', slug: 'core-mechanisms' },
			{ label: '工程实战', slug: 'engineering' },
		],
		stages: ['环境与源码地图', 'Gateway、Session 与 Run', '入口与 Agent Loop', '上下文压缩与 Pruning', '工具审批与 Sandbox', '模型认证、Fallback 与 Harness', 'Session、Transcript 与 Writer', '插件、渠道、协议与 UI', '工程化、测试与运维', '毕业设计'],
	},
	{
		label: 'Hermes Agent 0.22.5',
		prefix: 'hermes',
		overviews: [
			{ label: '全局地图', slug: 'overview' },
			{ label: '一次 Turn 的一生', slug: 'turn-lifecycle' },
			{ label: '核心机制', slug: 'core-mechanisms' },
			{ label: '工程实战', slug: 'engineering' },
		],
		stages: ['环境与源码地图', '前端 Admission 与 Lease', 'Conversation Loop', 'Prompt、上下文与压缩', '工具与 Persist Before Execute', 'Provider、凭据与 Fallback', 'SessionDB 与恢复', '扩展平台与多 Agent', '工程化测试与排障', '毕业设计'],
	},
];

const courseSections = courses.map(({ label, prefix, overviews, stages: stageLabels }) => ({
	label,
	items: [
		{ label: '课程导读', slug: prefix },
		...overviews.map((page) => ({ label: page.label, slug: `${prefix}/${page.slug}` })),
		{ label: '阶段导读', slug: `${prefix}/learning-path` },
		{ label: '十个阶段', items: stages(prefix, stageLabels) },
	],
}));

const localizeSidebar = (items) =>
	items.map((item) => ({
		...item,
		...(item.label
			? { translations: { en: enLabels[item.label] ?? item.label, ...(item.translations ?? {}) } }
			: {}),
		...(item.items ? { items: localizeSidebar(item.items) } : {}),
	}));

export default defineConfig({
	site,
	base,
	trailingSlash: 'always',
	integrations: [
		starlight({
			title: 'Cairn Notes',
			description: '我学习 AI Agent 时整理的笔记，包括 Pi、OpenSandbox、DeerFlow、LoopX、OpenClaw、Hermes 与通用软件工程基础。',
			logo: {
				src: './src/assets/cairn-mark.svg',
				alt: 'Cairn Notes',
				replacesTitle: false,
			},
			favicon: '/favicon.svg',
			locales: {
				root: { label: '简体中文', lang: 'zh-CN' },
				en: { label: 'English', lang: 'en' },
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
			sidebar: localizeSidebar([
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
				...courseSections,
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
			]),
		}),
		sitemap(),
	],
});
