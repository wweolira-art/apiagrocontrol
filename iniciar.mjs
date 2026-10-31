import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { ARQUIVO_LOG, ARQUIVO_PID, PASTA, PASTA_LOGS, carregarEnvNoProcesso } from './env-arquivo.mjs';

carregarEnvNoProcesso();
fs.mkdirSync(PASTA_LOGS, { recursive: true });

const log = fs.openSync(ARQUIVO_LOG, 'a');
fs.writeSync(log, `\n----- ${new Date().toISOString()} iniciar -----\n`);

const filho = spawn(process.execPath, ['api-public.mjs'], {
  cwd: PASTA,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', log, log],
  env: process.env,
});

if (!filho.pid) {
  console.error('Nao foi possivel iniciar o processo da API.');
  process.exit(1);
}

fs.writeFileSync(ARQUIVO_PID, String(filho.pid), 'utf8');
filho.unref();
console.log(`AgroControl API em segundo plano (pid ${filho.pid}).`);
