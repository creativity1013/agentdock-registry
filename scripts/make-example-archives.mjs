/** 生成示例导入文件（zip / tar.gz / 单文件 md），便于演示多样化导入 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, makeTarGz } from '../tests/helpers-archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = path.join(root, 'examples', 'bundles');
fs.mkdirSync(bundleDir, { recursive: true });

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const skillMd = read('examples', 'skill-code-reviewer', 'SKILL.md');
const agentMd = read('examples', 'agent-code-reviewer', 'agent.md');
const pluginJson = read('examples', 'plugin-ops-kit', 'plugin.json');
const checkSkill = read('examples', 'plugin-ops-kit', 'skills', 'incident-checklist', 'SKILL.md');
const releaseSkill = read('examples', 'plugin-ops-kit', 'skills', 'release-checklist', 'SKILL.md');

const zip = makeZip([{ path: 'skill-code-reviewer/SKILL.md', content: skillMd }]);
fs.writeFileSync(path.join(bundleDir, 'skill-code-reviewer.zip'), zip);

const pluginZip = makeZip([
  { path: 'plugin-ops-kit/plugin.json', content: pluginJson },
  { path: 'plugin-ops-kit/skills/incident-checklist/SKILL.md', content: checkSkill },
  { path: 'plugin-ops-kit/skills/release-checklist/SKILL.md', content: releaseSkill },
]);
fs.writeFileSync(path.join(bundleDir, 'plugin-ops-kit.zip'), pluginZip);

const tgz = makeTarGz([
  { path: 'plugin-ops-kit/plugin.json', content: pluginJson },
  { path: 'plugin-ops-kit/skills/incident-checklist/SKILL.md', content: checkSkill },
  { path: 'plugin-ops-kit/skills/release-checklist/SKILL.md', content: releaseSkill },
]);
fs.writeFileSync(path.join(bundleDir, 'plugin-ops-kit.tar.gz'), tgz);

fs.writeFileSync(path.join(bundleDir, 'agent-code-reviewer.md'), agentMd);

console.log(`✓ 已生成示例导入文件：${path.relative(process.cwd(), bundleDir)}/`);
for (const name of ['skill-code-reviewer.zip', 'plugin-ops-kit.zip', 'plugin-ops-kit.tar.gz', 'agent-code-reviewer.md']) {
  const stat = fs.statSync(path.join(bundleDir, name));
  console.log(`  - ${name} (${stat.size} B)`);
}
