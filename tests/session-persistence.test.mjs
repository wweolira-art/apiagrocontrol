import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAuth, hashPassword } from '../auth.ts';

test('sessão sobrevive ao reinício, logout persiste e expiração continua obrigatória', async () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'tests', 'tmp-sessions-'));
  const sessionFile = path.join(directory, 'sessions.json');
  let now = Date.now();
  const row = { id_usuario: 1, nome: 'Teste', email: 'teste@example.com', ativo: 1, senha_hash: await hashPassword('senha-de-teste') };
  const options = { sessionFile, url: 'https://example.test/usuario', token: '', now: () => now,
    fetch: async (url) => Response.json(new URL(url).search ? { items: [row] } : row) };
  try {
    const session = await createAuth(options).login(row.email, 'senha-de-teste', 'test');
    const header = `Bearer ${session.token}`;
    assert.equal(fs.readFileSync(sessionFile, 'utf8').includes(session.token), false);
    assert.equal((await createAuth(options).authenticate(header)).idUsuario, 1);
    createAuth(options).logout(header);
    await assert.rejects(createAuth(options).authenticate(header), { status: 401 });
    const next = await createAuth(options).login(row.email, 'senha-de-teste', 'test');
    now += 8 * 60 * 60 * 1000;
    await assert.rejects(createAuth(options).authenticate(`Bearer ${next.token}`), { status: 401 });
    await assert.rejects(createAuth(options).authenticate(undefined), { codigo: 'AUTH_TOKEN_AUSENTE' });
    await assert.rejects(createAuth(options).authenticate('Bearer invalido'), { codigo: 'AUTH_TOKEN_INVALIDO' });
    fs.writeFileSync(sessionFile, 'invalido');
    assert.throws(() => createAuth(options));
  } finally {
    fs.rmSync(`${sessionFile}.tmp`, { force: true });
    fs.rmSync(sessionFile, { force: true });
    fs.rmdirSync(directory);
  }
});
