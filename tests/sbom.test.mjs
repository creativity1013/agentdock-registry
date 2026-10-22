import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBundle } from '../src/bundle.mjs';
import { validateBundle } from '../src/validate.mjs';
import { buildSbom, sbomDigest, SBOM_SCHEMA } from '../src/sbom.mjs';

function makeBundle({ kind, name, version = '1.0.0', files }) {
  const normalized = normalizeBundle({ kind, name, version, description: '演示', files });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  const validation = validateBundle(normalized.bundle);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  return { bundle: normalized.bundle, manifest: validation.manifest };
}

const agentFiles = [
  {
    path: 'agent.md',
    encoding: 'utf8',
    content:
      '---\nname: demo-agent\ndescription: 演示 agent\ntools:\n  - read\n  - bash\nskills:\n  - reviewer\nmcp:\n  - weather\n---\n\n你是演示 agent。\n',
  },
];

test('buildSbom：agent 包生成文件哈希、工具与 MCP 组件', () => {
  const { bundle, manifest } = makeBundle({ kind: 'agent', name: 'demo-agent', files: agentFiles });
  const sbom = buildSbom(bundle, manifest, { generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(sbom.schema, SBOM_SCHEMA);
  assert.deepEqual(sbom.subject, {
    kind: 'agent',
    name: 'demo-agent',
    version: '1.0.0',
    contentHash: bundle.contentHash,
  });
  assert.equal(sbom.files.length, 1);
  assert.equal(sbom.files[0].path, 'agent.md');
  assert.match(sbom.files[0].sha256, /^[a-f0-9]{64}$/);
  const names = sbom.components.map((component) => `${component.type}:${component.name}`).sort();
  assert.deepEqual(names, ['mcp-server:weather', 'skill:reviewer', 'tool:bash', 'tool:read']);
  assert.equal(sbom.summary.fileCount, 1);
  assert.equal(sbom.summary.componentCount, 4);
  assert.deepEqual(sbom.summary.counts, { tool: 2, 'mcp-server': 1, skill: 1 });
  assert.match(sbom.digest, /^[a-f0-9]{64}$/);
});

test('buildSbom：plugin 的 MCP server 带 command/url', () => {
  const files = [
    {
      path: 'plugin.json',
      encoding: 'utf8',
      content: JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        description: '演示 plugin',
        skills: ['skills/checklist'],
        mcp: [
          { name: 'local-tool', command: 'npx local-tool' },
          { name: 'remote-tool', url: 'https://example.com/mcp' },
        ],
      }),
    },
    { path: 'skills/checklist/SKILL.md', encoding: 'utf8', content: '---\nname: checklist\ndescription: 检查清单\n---\n\n逐项检查。\n' },
  ];
  const { bundle, manifest } = makeBundle({ kind: 'plugin', name: 'demo-plugin', files });
  const sbom = buildSbom(bundle, manifest);
  const mcp = sbom.components.filter((component) => component.type === 'mcp-server');
  assert.deepEqual(
    mcp.map((component) => ({ name: component.name, command: component.command, url: component.url })),
    [
      { name: 'local-tool', command: 'npx local-tool', url: undefined },
      { name: 'remote-tool', command: undefined, url: 'https://example.com/mcp' },
    ],
  );
  assert.ok(sbom.components.some((component) => component.type === 'skill' && component.name === 'checklist'));
});

test('buildSbom：skill 包自身作为 skill 组件，可复现且 generatedAt 不影响 digest', () => {
  const files = [
    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: demo-skill\ndescription: 演示技能\n---\n\n做演示。\n' },
  ];
  const { bundle, manifest } = makeBundle({ kind: 'skill', name: 'demo-skill', files });
  const first = buildSbom(bundle, manifest, { generatedAt: '2026-01-01T00:00:00.000Z' });
  const second = buildSbom(bundle, manifest, { generatedAt: '2026-02-02T00:00:00.000Z' });
  assert.equal(first.digest, second.digest);
  assert.equal(sbomDigest(first), first.digest);
  assert.deepEqual(first.components, [{ type: 'skill', name: 'demo-skill' }]);
});

test('buildSbom：文件列表按路径排序，保证摘要稳定', () => {
  const files = [
    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: demo-skill\ndescription: 演示技能\n---\n\n主文件。\n' },
    { path: 'notes/b.md', encoding: 'utf8', content: 'B\n' },
    { path: 'notes/a.md', encoding: 'utf8', content: 'A\n' },
  ];
  const { bundle, manifest } = makeBundle({ kind: 'skill', name: 'demo-skill', files });
  const sbom = buildSbom(bundle, manifest);
  assert.deepEqual(
    sbom.files.map((file) => file.path),
    ['SKILL.md', 'notes/a.md', 'notes/b.md'],
  );
});
