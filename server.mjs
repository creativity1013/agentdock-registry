
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.mjs';
import { loadConfig } from './src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export function startServer(config = loadConfig()) {
  const app = createApp(config);
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, () => {
      app.server.off('error', reject);
      const address = app.server.address();
      const actualPort = typeof address === 'object' && address ? address.port : config.port;
      const url = config.port === 0 ? `http://${config.host}:${actualPort}` : config.publicUrl;
      resolve({ ...app, url, port: actualPort });
    });
  });
}

async function main() {
  const config = loadConfig();
  const app = await startServer(config);
  console.log('');
  console.log('  AgentDock 已启动');
  console.log(`  市场地址   ${app.url}`);
  console.log(`  API 前缀   ${app.url}/api/v1`);
  console.log(`  数据目录   ${config.dataDir}`);
  console.log(`  元数据后端 ${app.store.backend === 'sqlite' ? `sqlite（${config.files.sqlite}）` : 'json（db.json）'}`);
  console.log(`  初始化令牌 ${config.files.bootstrapTokens}`);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
  if (process.env.AGENTDOCK_LISTEN_JSON === '1') {
    console.log(`AGENTDOCK_LISTENING ${JSON.stringify({ url: app.url, port: app.port })}`);
  }

  const shutdown = () => {
    console.log('\n正在关闭 AgentDock ...');
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('AgentDock 启动失败：', error.message);
    process.exit(1);
  });
}
