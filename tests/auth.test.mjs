import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createAuth, createAuthGuard, hashPassword, verifyPassword } from '../auth.ts';

const password = 'senha-apenas-para-testes';

async function fixture({ legacy = false, allowLegacy = false } = {}) {
  let now = Date.now();
  const rows = [
    { id_usuario: 1, nome: 'ADMIN · Operador', email: 'operador@example.com', perfil: 'operador', ativo: 1 },
    { id_usuario: 2, nome: 'Responsável', email: 'gestor@example.com', perfil: 'admin', ativo: 1 },
  ];
  const hash = legacy ? createHash('sha256').update(password).digest('hex') : await hashPassword(password);
  rows.forEach(row => { row.senha_hash = hash; });
  const auth = createAuth({
    url: 'https://ords.example.test/usuario', token: 'credencial-ficticia-de-teste', allowLegacy,
    now: () => now,
    fetch: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer credencial-ficticia-de-teste');
      assert.equal(options.redirect, 'error');
      const parsed = new URL(url);
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        Object.assign(rows.find(row => row.id_usuario === body.id_usuario), body);
        return Response.json(body);
      }
      if (options.method === 'POST') {
        const row = { ...JSON.parse(options.body), id_usuario: rows.length + 1 };
        rows.push(row);
        return Response.json(row, { status: 201 });
      }
      if (parsed.searchParams.has('q')) {
        const email = JSON.parse(parsed.searchParams.get('q')).email.$eq;
        return Response.json({ items: rows.filter(row => row.email === email) });
      }
      const id = Number(parsed.pathname.split('/').at(-1));
      if (id) return Response.json(rows.find(row => row.id_usuario === id) ?? {});
      return Response.json({ items: rows, hasMore: false });
    },
  });
  return { auth, rows, advance: ms => { now += ms; } };
}

async function route(guard, path, { body, token, method = 'GET' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = { authorization: token && `Bearer ${token}` };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { status: 0, headers: {}, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  const handled = await guard(req, res, path);
  return { ...res, handled, data: res.body ? JSON.parse(res.body) : null };
}

test('scrypt usa salt único, rejeita senha incorreta e nunca aceita texto puro', async () => {
  const first = await hashPassword(password);
  assert.equal(first.length, 62);
  assert.notEqual(first, await hashPassword(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('errada', first), false);
  assert.equal(await verifyPassword(password, password, true), false);
  assert.equal(await verifyPassword(password, 'scrypt$invalido$invalido'), false);
});

test('login retorna sessão sem hash; nome ADMIN não concede privilégio', async () => {
  const { auth } = await fixture();
  const session = await auth.login('OPERADOR@example.com', password, 'test');
  assert.equal(session.perfil, 'operador');
  assert.equal(session.senha_hash, undefined);
  assert.equal(session.token.length, 43);
  assert.equal((await auth.authenticate(`Bearer ${session.token}`)).idUsuario, 1);
  assert.equal((await auth.list()).some(row => 'senha_hash' in row), false);
});

test('sessões expiram, são revogadas no logout e recusam usuário desativado', async () => {
  const { auth, rows, advance } = await fixture();
  const login = () => auth.login(rows[0].email, password, 'test');
  let session = await login();
  auth.logout(`Bearer ${session.token}`);
  await assert.rejects(auth.authenticate(`Bearer ${session.token}`), { status: 401 });
  session = await login();
  advance(8 * 60 * 60 * 1000 + 1);
  await assert.rejects(auth.authenticate(`Bearer ${session.token}`), { status: 401 });
  session = await login();
  rows[0].ativo = 0;
  await assert.rejects(auth.authenticate(`Bearer ${session.token}`), { status: 401 });
});

test('SHA256 legado só é aceito na migração explícita e é convertido para scrypt', async () => {
  const disabled = await fixture({ legacy: true });
  await assert.rejects(disabled.auth.login(disabled.rows[0].email, password, 'test'), { status: 401 });
  const { auth, rows } = await fixture({ legacy: true, allowLegacy: true });
  await auth.login(rows[0].email, password, 'test');
  assert.match(rows[0].senha_hash, /^scrypt\$/);
});

test('limita tentativas sem confiar no IP enviado em headers', async () => {
  const { auth, rows } = await fixture();
  for (let i = 0; i < 10; i++) await assert.rejects(auth.login(rows[0].email, 'errada', 'ip'), { status: 401 });
  await assert.rejects(auth.login(rows[0].email, password, 'outro-ip'), { status: 429 });
});

test('API exige sessão e restringe usuários/configuração a administrador', async () => {
  const { auth, rows } = await fixture();
  const guard = createAuthGuard(auth);
  assert.equal((await route(guard, '/api/apontamento')).status, 401);
  const operator = await auth.login(rows[0].email, password, 'test');
  for (const path of ['/api/usuarios', '/api/oracle-config', '/api/oracle-config/test', '/api/config', '/api/irrigacao/insert-test']) {
    assert.equal((await route(guard, path, { token: operator.token })).status, 403);
  }
  assert.equal((await route(guard, '/api/apontamento', { token: operator.token })).handled, false);
  const admin = await auth.login(rows[1].email, password, 'test');
  const list = await route(guard, '/api/usuarios', { token: admin.token });
  assert.equal(list.status, 200);
  assert.equal(list.headers['Cache-Control'], 'no-store');
  assert.equal(list.body.includes('senha_hash'), false);
  const created = await route(guard, '/api/usuarios', { token: admin.token, method: 'POST', body: JSON.stringify({ nome: 'Novo', email: 'novo@example.com', senha: password, admin: true }) });
  assert.equal(created.status, 201);
  assert.equal(created.data.perfil, 'admin');
  assert.match(rows.at(-1).senha_hash, /^scrypt\$/);
  // Mudança de perfil no banco vale imediatamente, mesmo com sessão existente.
  rows[1].perfil = 'operador';
  assert.equal((await route(guard, '/api/usuarios', { token: admin.token })).status, 403);
});

test('login rejeita JSON inválido e corpo excessivo', async () => {
  const { auth } = await fixture();
  const guard = createAuthGuard(auth);
  assert.equal((await route(guard, '/api/auth/login', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await route(guard, '/api/auth/login', { method: 'POST', body: 'x'.repeat(20_000) })).status, 413);
});

test('sem URL ORDS o login falha fechado e não consulta rede', async () => {
  const auth = createAuth({ url: '', token: '', fetch: () => { throw new Error('não deveria executar'); } });
  await assert.rejects(auth.login('teste@example.com', password, 'test'), { status: 503 });
});

test('login consulta URL pública sem exigir token ORDS e valida a senha', async () => {
  const senha_hash = await hashPassword(password);
  const auth = createAuth({
    url: 'https://ords.example.test/usuario', token: '',
    fetch: async (_url, options) => {
      assert.equal(options.headers.Authorization, undefined);
      return { ok: true, status: 200, json: async () => ({ items: [{ id_usuario: 1, nome: 'Operador', email: 'operador@example.com', ativo: 1, perfil: 'operador', senha_hash }] }) };
    },
  });
  assert.ok((await auth.login('operador@example.com', password, 'public')).token);
  await assert.rejects(auth.login('operador@example.com', 'senha-incorreta', 'public'), { status: 401 });
});

