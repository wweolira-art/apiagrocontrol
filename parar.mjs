import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { ARQUIVO_PID } from './env-arquivo.mjs';

if (fs.existsSync(ARQUIVO_PID)) {
  const pid = Number(fs.readFileSync(ARQUIVO_PID, 'utf8').trim());
  if (Number.isFinite(pid) && pid > 0) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  }
  fs.unlinkSync(ARQUIVO_PID);
}

console.log('AgroControl API encerrada. O ngrok do Oracle (túnel TCP) foi mantido.');
