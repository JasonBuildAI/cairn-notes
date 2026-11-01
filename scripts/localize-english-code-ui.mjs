import fs from 'node:fs';
import path from 'node:path';

const distRoot = path.resolve('dist', 'en');
const replacements = new Map([
	['title="复制到剪贴板"', 'title="Copy to clipboard"'],
	['data-copied="复制成功！"', 'data-copied="Copied!"'],
	['<span class="sr-only">终端窗口</span>', '<span class="sr-only">Terminal window</span>'],
]);
const forbidden = [...replacements.keys()];

function htmlFiles(directory) {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const target = path.join(directory, entry.name);
		return entry.isDirectory()
			? htmlFiles(target)
			: target.endsWith('.html')
				? [target]
				: [];
	});
}

if (!fs.existsSync(distRoot)) {
	console.error(`English build output not found: ${distRoot}`);
	process.exit(1);
}

let changedFiles = 0;
let replacementCount = 0;
const failures = [];

for (const file of htmlFiles(distRoot)) {
	const original = fs.readFileSync(file, 'utf8');
	let html = original;
	for (const [from, to] of replacements) {
		const count = html.split(from).length - 1;
		if (count > 0) {
			html = html.replaceAll(from, to);
			replacementCount += count;
		}
	}
	if (html !== original) {
		fs.writeFileSync(file, html);
		changedFiles += 1;
	}
	for (const text of forbidden) {
		if (html.includes(text)) failures.push(`${path.relative(distRoot, file)}: ${text}`);
	}
}

if (failures.length > 0) {
	console.error('English code UI localization failed:');
	for (const failure of failures.slice(0, 20)) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(`English code UI localized: ${replacementCount} labels in ${changedFiles} files.`);
