import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', '.astro', 'dist', 'node_modules']);
const errors = [];
const stats = [];

const privatePatterns = [
	['个人 Windows 目录', /D:\\UserFolders\\/i],
	['个人 Windows 用户目录', /C:\\Users\\Jason\\/i],
	['个人开发目录', /D:\\App\\AgentProjects\\/i],
	['SSH 私钥', /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/],
	['GitHub Token', /gh[pousr]_[A-Za-z0-9]{20,}/],
	['OpenAI API Key', /sk-[A-Za-z0-9_-]{20,}/],
	['AWS Access Key', /AKIA[0-9A-Z]{16}/],
];

function walk(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const fullPath = path.join(directory, entry.name);
		const relativePath = path.relative(root, fullPath);
		if (entry.isDirectory()) {
			if (/^pi-1\.3\.0$|^opensandbox-1\.1\.1$|^legacy-\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
				errors.push(`禁止公开的上游源码或备份目录：${relativePath}`);
			}
			walk(fullPath);
			continue;
		}
		if (/\.(zip|tar|tgz|gz|7z|rar)$/i.test(entry.name)) {
			errors.push(`禁止公开的压缩包：${relativePath}`);
		}
		if (/\.(md|mdx|txt|json|mjs|js|yml|yaml)$/i.test(entry.name)) {
			const text = fs.readFileSync(fullPath, 'utf8');
			for (const [label, pattern] of privatePatterns) {
				if (pattern.test(text)) errors.push(`${relativePath} 含有${label}`);
			}
		}
	}
}

function inspectDocs(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			inspectDocs(fullPath);
			continue;
		}
		if (!/\.(md|mdx)$/.test(entry.name)) continue;
		const text = fs.readFileSync(fullPath, 'utf8');
		stats.push({
			route: path.relative(path.join(root, 'src/content/docs'), fullPath).replaceAll(path.sep, '/'),
			chars: text.length,
		});
	}
}

function pageUrlFor(file) {
	let slug = path
		.relative(docsRoot, file)
		.replaceAll(path.sep, '/')
		.replace(/\.mdx?$/, '');
	if (slug === 'index') slug = '';
	else if (slug.endsWith('/index')) slug = slug.slice(0, -'/index'.length);
	return slug ? `/${slug}/` : '/';
}

function readBasePath() {
	const config = fs.readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');
	const match = config.match(/const base = '([^']*)'/);
	return match ? match[1].replace(/\/$/, '') : '';
}

function inspectLinks(directory, basePath) {
	const files = [];
	const collect = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) collect(fullPath);
			else if (/\.(md|mdx)$/.test(entry.name)) files.push(fullPath);
		}
	};
	collect(directory);

	const urls = new Set();
	for (const file of files) urls.add(pageUrlFor(file));

	for (const file of files) {
		const relativePath = path.relative(root, file).replaceAll(path.sep, '/');
		const pageUrl = new URL(`https://example.invalid${pageUrlFor(file)}`);
		const text = fs.readFileSync(file, 'utf8');
		text.split(/\r?\n/).forEach((line, index) => {
			for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
				let target = match[1];
				if (/^(https?:|mailto:|tel:|#)/.test(target)) continue;
				if (basePath && (target === basePath || target.startsWith(`${basePath}/`))) {
					target = target.slice(basePath.length) || '/';
				}
				const url = target.startsWith('/') ? new URL(target, 'https://example.invalid') : new URL(target, pageUrl);
				const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
				if (!urls.has(pathname)) {
					errors.push(`内部链接失效：${relativePath}:${index + 1} → ${match[1]}`);
				}
			}
		});
	}
}

const docsRoot = path.join(root, 'src/content/docs');
if (!fs.existsSync(docsRoot)) {
	console.error('找不到 src/content/docs。请从仓库根目录运行。');
	process.exit(1);
}

inspectDocs(docsRoot);
walk(root);

const expected = [
	'pi/index.md',
	'opensandbox/index.md',
	'engineering/index.md',
	'engineering/computer-systems.md',
	'engineering/reproducible-environment.md',
	'engineering/git-and-debugging.md',
	'engineering/browser-model.md',
	'engineering/frontend-for-ai.md',
	'engineering/backend-requests.md',
	'engineering/backend-scale.md',
	'engineering/backend-structure.md',
	'engineering/data-storage.md',
	'engineering/data-products.md',
	'engineering/architecture-reliability.md',
	'engineering/system-design.md',
	'engineering/linux-containers-deploy.md',
	'engineering/network-cloud-security.md',
	'engineering/observability-incidents.md',
	'engineering/llm-foundations.md',
	'engineering/rag-and-agents.md',
	'engineering/model-lifecycle.md',
	'engineering/code-testing-design.md',
	'engineering/security-and-delivery.md',
	'rights.md',
	'about.md',
];

const coursePages = [
	'index.md',
	'overview.md',
	'core-mechanisms.md',
	'engineering.md',
	'learning-path.md',
	...Array.from({ length: 10 }, (_, index) => `stage-${index}.md`),
];
const lifecyclePages = {
	deerflow: 'run-lifecycle.md',
	loopx: 'turn-lifecycle.md',
	openclaw: 'message-lifecycle.md',
	hermes: 'turn-lifecycle.md',
};
for (const [course, lifecyclePage] of Object.entries(lifecyclePages)) {
	for (const page of [...coursePages, lifecyclePage]) expected.push(`${course}/${page}`);
}

for (const file of expected) {
	if (!fs.existsSync(path.join(docsRoot, file))) errors.push(`缺少必要页面：src/content/docs/${file}`);
}

inspectLinks(docsRoot, readBasePath());

if (errors.length > 0) {
	console.error('公开内容检查失败：');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

stats.sort((a, b) => a.route.localeCompare(b.route));
const totalChars = stats.reduce((sum, item) => sum + item.chars, 0);
console.log(`公开内容检查通过：${stats.length} 个页面，约 ${(totalChars / 10000).toFixed(1)} 万字符。`);
console.log('未发现个人绝对路径、常见密钥、上游源码目录或压缩包。');
