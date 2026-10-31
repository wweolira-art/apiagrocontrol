import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const scrypt = promisify(scryptCallback);
const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

interface Account {
  id_usuario: number;
  cod_funcionario?: number | null;
  nome: string;
  email: string;
  senha_hash?: string;
  perfil?: string;
  ativo?: number | null;
  data_cadastro?: string | null;
  data_ultimo_login?: string | null;
}

export class AuthError extends Error {
  status: number;
  codigo?: string;
  constructor(status: number, message: string, codigo?: string) {
    super(message);
    this.status = status;
    this.codigo = codigo;
  }
}

/** 62 caracteres, compatível com colunas legadas VARCHAR2(64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const key = (await scrypt(password, salt, 24)) as Buffer;
  return `scrypt$${salt}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string, allowLegacy = false): Promise<boolean> {
  if (password.length > 1024) return false;
  if (/^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{32}$/.test(stored)) {
    const [, salt, encoded] = stored.split('$');
    const actual = (await scrypt(password, salt, 24)) as Buffer;
    return timingSafeEqual(actual, Buffer.from(encoded, 'base64url'));
  }
  // Migração temporária de hashes antigos. Senhas em texto puro nunca são aceitas.
  if (allowLegacy && /^[a-f\d]{64}$/i.test(stored)) {
    return timingSafeEqual(createHash('sha256').update(password).digest(), Buffer.from(stored, 'hex'));
  }
  return false;
}

function publicUser(row: Account) {
  return {
    idUsuario: Number(row.id_usuario),
    codFuncionario: Number.isSafeInteger(Number(row.cod_funcionario)) ? Number(row.cod_funcionario) : null,
    nome: row.nome,
    email: row.email,
    perfil: row.perfil === 'admin' ? 'admin' : 'operador',
  };
}

function active(row: Account | undefined): row is Account {
  return Boolean(row && Number.isSafeInteger(Number(row.id_usuario)) && Number(row.id_usuario) > 0 && Number(row.ativo) === 1);
}

/** Credencial ORDS somente no servidor; nunca reutiliza EXPO_PUBLIC_*. */
export function createAuth(options: {
  url: string;
  token: string;
  allowLegacy?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sessionFile?: string;
}) {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { id: number; expires: number }>();
  if (options.sessionFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(options.sessionFile, 'utf8'));
      if (!Array.isArray(saved) || saved.length > 10_000) throw new Error('Arquivo de sessões inválido.');
      for (const entry of saved) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Sessão inválida.');
        const [key, session] = entry;
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(session?.id) || session.id <= 0 || !Number.isFinite(session.expires)) throw new Error('Sessão inválida.');
        if (session.expires > now()) sessions.set(key, { id: session.id, expires: session.expires });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  function persistSessions() {
    if (!options.sessionFile) return;
    fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true, mode: 0o700 });
    const temporary = `${options.sessionFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...sessions]), { mode: 0o600 });
    fs.renameSync(temporary, options.sessionFile);
  }
  const attempts = new Map<string, { count: number; expires: number }>();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');

  async function ords(path = '', method = 'GET', body?: unknown) {
    if (!options.url.startsWith('https://')) {
      throw new AuthError(503, 'Configure ORDS_AUTH_USUARIOS_URL (HTTPS) no servidor.');
    }
    const response = await request(`${options.url.replace(/\/$/, '')}/${path}`, {
      method,
      headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!response.ok) throw new AuthError(502, 'Não foi possível acessar o cadastro protegido de usuários.');
    if (response.status === 204) return {};
    return response.json();
  }

  async function byEmail(email: string): Promise<Account | undefined> {
    const q = encodeURIComponent(JSON.stringify({ email: { $eq: email } }));
    const data = await ords(`?q=${q}&limit=2`);
    const rows = (data.items ?? []) as Account[];
    // E-mails duplicados não podem escolher uma identidade arbitrária.
    return rows.length === 1 && rows[0].email?.toLowerCase() === email ? rows[0] : undefined;
  }

  async function byId(id: number): Promise<Account | undefined> {
    const data = await ords(String(id));
    return Number(data.id_usuario) === id ? data as Account : undefined;
  }

  async function byCodFuncionario(codigo: number): Promise<Account | undefined> {
    const q = encodeURIComponent(JSON.stringify({ cod_funcionario: { $eq: codigo } }));
    const data = await ords(`?q=${q}&limit=2`);
    const rows = (data.items ?? []) as Account[];
    return rows.length === 1 && Number(rows[0].cod_funcionario) === codigo ? rows[0] : undefined;
  }

  function checkRate(key: string, limit: number) {
    for (const [entry, value] of attempts) if (value.expires <= now()) attempts.delete(entry);
    const state = attempts.get(key) ?? { count: 0, expires: now() + WINDOW_MS };
    if (state.count >= limit || attempts.size >= 10_000) throw new AuthError(429, 'Muitas tentativas. Aguarde 15 minutos.');
    state.count += 1;
    attempts.set(key, state);
  }

  async function login(usuarioValue: unknown, passwordValue: unknown, ip: string) {
    const usuario = String(usuarioValue ?? '').trim().toLowerCase();
    const porCodigo = /^\d+$/.test(usuario);
    const codigo = Number(usuario);
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    checkRate(`ip:${ip}`, 50);
    checkRate(`usuario:${digest(usuario)}`, 10);
    const identidadeValida = porCodigo
      ? Number.isSafeInteger(codigo) && codigo > 0
      : usuario.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario);
    if (!identidadeValida || !password || password.length > 1024) throw new AuthError(401, 'Usuário ou senha inválidos.');
    const row = porCodigo ? await byCodFuncionario(codigo) : await byEmail(usuario);
    const valid = await verifyPassword(password, row?.senha_hash ?? '', options.allowLegacy);
    if (!active(row) || !valid) throw new AuthError(401, 'Usuário ou senha inválidos.');
    const hash = row.senha_hash?.startsWith('scrypt$') ? row.senha_hash : await hashPassword(password);
    await ords(String(row.id_usuario), 'PUT', {
      id_usuario: row.id_usuario, cod_funcionario: row.cod_funcionario ?? null, nome: row.nome, email: row.email,
      perfil: row.perfil === 'admin' ? 'admin' : 'operador', ativo: row.ativo,
      data_cadastro: row.data_cadastro,
      senha_hash: hash,
      data_ultimo_login: new Date(now()).toISOString(),
    });
    for (const [key, session] of sessions) if (session.expires <= now()) sessions.delete(key);
    if (sessions.size >= 10_000) throw new AuthError(503, 'Limite de sessões atingido. Tente novamente mais tarde.');
    const token = randomBytes(32).toString('base64url');
    const expires = now() + SESSION_MS;
    sessions.set(digest(token), { id: Number(row.id_usuario), expires });
    try { persistSessions(); } catch (error) { sessions.delete(digest(token)); throw error; }
    attempts.delete(`usuario:${digest(usuario)}`);
    return { ...publicUser(row), token, expiraEm: new Date(expires).toISOString() };
  }

  async function authenticate(header: string | undefined) {
    if (!header) throw new AuthError(401, 'Token de autenticação ausente. Entre novamente no aplicativo e tente reenviar.', 'AUTH_TOKEN_AUSENTE');
    const token = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    if (!token) throw new AuthError(401, 'Token de autenticação inválido. Entre novamente.', 'AUTH_TOKEN_INVALIDO');
    const key = token ? digest(token) : '';
    const session = sessions.get(key);
    if (!session || session.expires <= now()) {
      sessions.delete(key);
      throw new AuthError(401, 'Sessão expirada ou não reconhecida. Entre novamente e reenvie os registros salvos.', 'AUTH_SESSAO_EXPIRADA');
    }
    const row = await byId(session.id);
    if (!active(row)) {
      sessions.delete(key);
      persistSessions();
      throw new AuthError(401, 'Sessão inválida. Entre novamente.', 'AUTH_USUARIO_INATIVO');
    }
    return publicUser(row);
  }

  function logout(header: string | undefined) {
    const token = header?.match(/^Bearer (.+)$/i)?.[1];
    if (token) { sessions.delete(digest(token)); persistSessions(); }
  }

  async function list() {
    const users = [];
    let offset = 0;
    for (;;) {
      const data = await ords(`?limit=200&offset=${offset}`);
      const rows = (data.items ?? []) as Account[];
      users.push(...rows.map((row) => ({
        ...publicUser(row), ativo: Number(row.ativo) === 1,
        dataCadastro: row.data_cadastro ?? null, dataUltimoLogin: row.data_ultimo_login ?? null,
      })));
      if (!data.hasMore || rows.length === 0) break;
      offset += rows.length;
      if (offset > 100_000) throw new AuthError(502, 'Cadastro de usuários excedeu o limite de consulta.');
    }
    return users.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  async function create(body: Record<string, unknown>) {
    const nome = String(body.nome ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = typeof body.senha === 'string' ? body.senha : '';
    if (!nome || nome.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 1024) {
      throw new AuthError(400, 'Informe nome, e-mail válido e senha de pelo menos 12 caracteres.');
    }
    if (await byEmail(email)) throw new AuthError(409, 'Já existe um usuário com este e-mail.');
    const row = await ords('', 'POST', {
      nome, email, senha_hash: await hashPassword(password),
      perfil: body.admin === true ? 'admin' : 'operador', ativo: 1,
      data_cadastro: new Date(now()).toISOString(),
    }) as Account;
    return { ...publicUser(row), ativo: true, dataCadastro: row.data_cadastro ?? null, dataUltimoLogin: null };
  }

  return { login, authenticate, logout, list, create };
}

export function sendAuthError(res: ServerResponse, error: unknown) {
  res.writeHead(error instanceof AuthError ? error.status : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ mensagem: error instanceof AuthError ? error.message : 'Serviço de autenticação indisponível.', ...(error instanceof AuthError && error.codigo ? { codigo: error.codigo } : {}) }));
}

export async function readAuthBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new AuthError(413, 'Requisição muito grande.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new AuthError(400, 'JSON inválido.'); }
}

/** Toda rota /api exige sessão; permissões administrativas são conferidas no servidor. */
export function createAuthGuard(auth: ReturnType<typeof createAuth>, afterAuthentication?: (req: IncomingMessage, res: ServerResponse, pathname: string, user: ReturnType<typeof publicUser>) => Promise<boolean>) {
  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readAuthBody(req);
        json(200, await auth.login(body.codFuncionario ?? body.email, body.senha, req.socket.remoteAddress ?? 'unknown'));
        return true;
      }
      if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;
      const user = await auth.authenticate(req.headers.authorization);
      const adminRoute = pathname === '/api/usuarios' || pathname.startsWith('/api/oracle-config') || pathname === '/api/config' || pathname === '/api/irrigacao/insert-test';
      if (adminRoute && user.perfil !== 'admin') throw new AuthError(403, 'Acesso permitido somente ao administrador.');
      if (afterAuthentication && await afterAuthentication(req, res, pathname, user)) return true;
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        auth.logout(req.headers.authorization);
        json(200, { ok: true });
        return true;
      }
      if (pathname === '/api/auth/me' && req.method === 'GET') {
        json(200, user);
        return true;
      }
      if (pathname === '/api/usuarios' && req.method === 'GET') {
        json(200, await auth.list());
        return true;
      }
      if (pathname === '/api/usuarios' && req.method === 'POST') {
        json(201, await auth.create(await readAuthBody(req)));
        return true;
      }
      return false;
    } catch (error) { sendAuthError(res, error); return true; }
  };
}
