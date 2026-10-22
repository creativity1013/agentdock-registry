#!/usr/bin/env node
/**
 * 把 examples/ 下的三种能力包目录导出为「导入 JSON 包」格式，
 * 可直接在 Web 市场点「导入 JSON 包」上传，或 POST /api/v1/packages。
 *
 * 用法：node scripts/make-example-bundles.mjs [--out examples/bundles]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundleFromDirectory } from '../src/bundle.mjs';
import { parseFrontmatter } from '../src/yaml.mjs';
import { analyzeInput } from '../src/pipeline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'examples', 'bundles');

const specs = [
  { dir: 'skill-code-reviewer', kind: 'skill', manifest: 'SKILL.md' },
  { dir: 'agent-code-reviewer', kind: 'agent', manifest: 'agent.md' },
  { dir: 'plugin-ops-kit', kind: 'plugin', manifest: 'plugin.json' },
];

fs.mkdirSync(outDir, { recursive: true });
const report = [];

for (const spec of specs) {
  const { files } = readBundleFromDirectory(path.join(root, 'examples', spec.dir));
  const manifestFile = files.find((file) => file.path === spec.manifest);
  if (!manifestFile) throw new Error(`${spec.dir} 缺少 ${spec.manifest}`);

  let meta;
  if (spec.kind === 'plugin') {
    meta = JSON.parse(manifestFile.content);
  } else {
    const { data } = parseFrontmatter(manifestFile.content);
    meta = { name: data.name, version: data.version || '0.1.0', description: data.description, tags: data.tags || [] };
  }

  const payload = {
    kind: spec.kind,
    name: meta.name,
    version: meta.version || '0.1.0',
    description: meta.description || '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    files: files.map((file) => (file.encoding === 'base64'
      ? { path: file.path, content: file.content, encoding: 'base64' }
      : { path: file.path, content: file.content })),
  };

  const result = analyzeInput(payload);
  if (!result.valid) {
    throw new Error(`${spec.dir} 校验失败：${JSON.stringify(result.errors)}`);
  }

  const outFile = path.join(outDir, `${spec.kind}-${meta.name}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
  report.push({
    file: path.relative(root, outFile),
    kind: spec.kind,
    name: meta.name,
    version: payload.version,
    files: files.length,
    warnings: result.warnings.length,
    scan: result.scan.summary,
  });
}

console.log('已导出导入用 JSON 包：');
for (const item of report) {
  console.log(`- ${item.file}  (${item.kind}/${item.name}@${item.version}, ${item.files} 个文件, 扫描 高${item.scan.high}/中${item.scan.medium}/低${item.scan.low})`);
}
console.log('\n在 Web 市场点「导入 JSON 包」上传即可；导入后进入「待审核」，审核通过后上架。');
