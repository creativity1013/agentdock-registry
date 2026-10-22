import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_CONFIG_FILE = path.join(os.homedir(), '.agentdock', 'config.json');

export function resolveHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/**
 * 读取运行时配置。所有项都可用环境变量覆盖，方便测试与部署。
 */
export function loadConfig(env = process.env, overrides = {}) {
  const port = Number(overrides.port ?? env.AGENTDOCK_PORT ?? 7788);
  const host = overrides.host ?? env.AGENTDOCK_HOST ?? '127.0.0.1';
  const dataDir = path.resolve(overrides.dataDir ?? env.AGENTDOCK_DATA ?? path.join(PKG_ROOT, 'data'));
  const home = overrides.home ?? resolveHome(env);
  const webDir = overrides.webDir ?? path.join(PKG_ROOT, 'web');

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENTDOCK_PORT 不合法：${port}`);
  }

  const config = {
    host,
    port,
    dataDir,
    home,
    webDir,
    publicUrl: overrides.publicUrl ?? env.AGENTDOCK_PUBLIC_URL ?? `http://${host}:${port}`,
    scanBlock: overrides.scanBlock ?? env.AGENTDOCK_SCAN_BLOCK ?? 'high',
    dev: overrides.dev ?? env.AGENTDOCK_DEV === '1',
    version: readOwnVersion(),
    files: {
      db: path.join(dataDir, 'db.json'),
      users: path.join(dataDir, 'users.json'),
      bootstrapTokens: path.join(dataDir, 'BOOTSTRAP-TOKENS.txt'),
      audit: path.join(dataDir, 'audit.log'),
      packages: path.join(dataDir, 'packages'),
      signingKey: path.join(dataDir, 'signing-key.json'),
      transparency: path.join(dataDir, 'transparency.log'),
    },
  };
  return config;
}

export function ensureDataLayout(config) {
  for (const dir of [config.dataDir, config.files.packages]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readOwnVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
