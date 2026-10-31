import type { IncomingMessage, ServerResponse } from 'node:http';
import { ABAS_DISPOSITIVO, ABAS_OBRIGATORIAS, type AbaDispositivo, type AcessoUsuario } from './device-tabs.ts';
import { AuthError, readAuthBody } from './auth.ts';

export const DEFAULT_ACCESS_URL = 'https://g58645a2c384a96-bd1.adb.sa-saopaulo-1.oraclecloudapps.com/ords/admin/app_acesso_aba/';
const validTabs = new Set<string>(ABAS_DISPOSITIVO.map(item => item.id));
type Row = { id_usuario: number; aba: string; links?: { rel: string; href: string }[] };

export function normalizeAccessUserId(value: unknown): number {
  const idUsuario = Number(value);
  if (!Number.isSafeInteger(idUsuario) || idUsuario <= 0) throw new AuthError(400, 'Informe um código de usuário válido.');
  return idUsuario;
}

export function createEmailAccessStore(options: { url: string; token?: string; fetch?: typeof fetch }) {
  const base = new URL(options.url.endsWith('/') ? options.url : `${options.url}/`);
  if (base.protocol !== 'https:') throw new Error('A URL de permissões deve usar HTTPS.');
  const fetcher = options.fetch ?? fetch;
  const locks = new Map<number, Promise<void>>();
  function safeUrl(value: string) {
    const url = new URL(value, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new AuthError(502, 'Link inválido retornado pelo cadastro de permissões.');
    return url;
  }
  async function request(url: URL, method = 'GET', body?: unknown) {
    const response = await fetcher(url.href, {
      method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new AuthError(502, `Cadastro de permissões respondeu HTTP ${response.status}. Recarregue as liberações para conferir o estado salvo.`);
    return response;
  }
  async function rows(idUsuario?: number): Promise<Row[]> {
    const result: Row[] = [];
    let offset = 0;
    while (true) {
      const url = new URL(base);
      url.searchParams.set('limit', '500'); url.searchParams.set('offset', String(offset));
      if (idUsuario) url.searchParams.set('q', JSON.stringify({ id_usuario: { $eq: idUsuario } }));
      const data = await (await request(url)).json();
      if (!Array.isArray(data.items)) throw new AuthError(502, 'Formato inválido do cadastro de permissões.');
      for (const row of data.items) {
        if (!Number.isSafeInteger(Number(row.id_usuario)) || Number(row.id_usuario) <= 0 || typeof row.aba !== 'string') throw new AuthError(502, 'A tabela de permissões precisa dos campos id_usuario e aba.');
        if (!idUsuario || Number(row.id_usuario) === idUsuario) result.push(row as Row);
      }
      if (!data.hasMore) break;
      offset += data.items.length;
      if (!data.items.length || offset > 100000) throw new AuthError(502, 'Não foi possível concluir a consulta de permissões.');
    }
    return result;
  }
  const access = (idUsuario: number, list: Row[]): AcessoUsuario => ({ idUsuario,
    abas: [...new Set<AbaDispositivo>([...ABAS_OBRIGATORIAS, ...list.filter(row => validTabs.has(row.aba)).map(row => row.aba as AbaDispositivo)])] });
  return {
    async current(value: unknown) {
      const idUsuario = normalizeAccessUserId(value);
      return access(idUsuario, await rows(idUsuario));
    },
    async list(): Promise<AcessoUsuario[]> {
      const groups = new Map<number, Row[]>();
      for (const row of await rows()) {
        const idUsuario = normalizeAccessUserId(row.id_usuario);
        groups.set(idUsuario, [...(groups.get(idUsuario) ?? []), row]);
      }
      return [...groups].map(([idUsuario, list]) => access(idUsuario, list)).sort((a, b) => a.idUsuario - b.idUsuario);
    },
    async update(value: unknown, body: Record<string, unknown>) {
      const idUsuario = normalizeAccessUserId(value);
      if (!Array.isArray(body.abas) || body.abas.some(tab => typeof tab !== 'string' || !validTabs.has(tab))) throw new AuthError(400, 'Lista de abas inválida.');
      const desired = [...new Set([...ABAS_OBRIGATORIAS, ...body.abas])] as AbaDispositivo[];
      const previous = locks.get(idUsuario) ?? Promise.resolve();
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      locks.set(idUsuario, pending);
      try {
        await previous;
        const existing = await rows(idUsuario);
        // Valida todos os links antes de alterar qualquer linha.
        const removals = existing.filter(row => !desired.includes(row.aba as AbaDispositivo)).map(row => {
          const href = row.links?.find(link => link.rel === 'self')?.href;
          if (!href) throw new AuthError(502, 'A ORDS não retornou o link do registro a remover.');
          const url = safeUrl(href);
          if (url.pathname === base.pathname) throw new AuthError(502, 'Link de exclusão inválido.');
          return url;
        });
        for (const url of removals) await request(url, 'DELETE');
        for (const aba of desired) if (!existing.some(row => row.aba === aba)) await request(base, 'POST', { id_usuario: idUsuario, aba });
        const saved = access(idUsuario, await rows(idUsuario));
        if (saved.abas.length !== desired.length || desired.some(tab => !saved.abas.includes(tab))) throw new AuthError(502, 'As liberações não foram confirmadas. Recarregue e confira o estado salvo.');
        return saved;
      } finally { release(); if (locks.get(idUsuario) === pending) locks.delete(idUsuario); }
    },
  };
}

function requiredTabs(url: string): AbaDispositivo[] | null {
  if (url.startsWith('/api/biometria/')) return ['biometria'];
  if (url.startsWith('/api/irrigacao') && url !== '/api/irrigacao/insert-test') return ['irrigacao'];
  if (url.startsWith('/api/apontamento/mao-de-obra')) return ['mao-de-obra'];
  if (url === '/api/apontamento/cadastros') return ['cadastros', 'insumos', 'mao-de-obra', 'perdas', 'salvos'];
  if (url.startsWith('/api/apontamento')) return ['insumos', 'salvos'];
  if (url.startsWith('/api/perdas')) return ['perdas', 'salvos'];
  if (url === '/api/localizacao' || url.startsWith('/api/talhao/') || url === '/api/assistente') return ['mapa'];
  if (url === '/api/usuarios') return ['usuarios'];
  if (url === '/api/config' || url.startsWith('/api/oracle-config') || url === '/api/irrigacao/insert-test') return ['conexao'];
  return null;
}
export function createEmailAccessGuard(store: ReturnType<typeof createEmailAccessStore>) {
  return async (req: IncomingMessage, res: ServerResponse, pathname: string, user: { perfil: string; idUsuario: number }): Promise<boolean> => {
    const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/acesso/abas' && req.method === 'GET') { json(await store.current(user.idUsuario)); return true; }
    if (pathname === '/api/acessos/abas' || pathname.startsWith('/api/acessos/abas/')) {
      if (user.perfil !== 'admin') throw new AuthError(403, 'Somente o administrador pode liberar abas por usuário.');
      if (pathname === '/api/acessos/abas' && req.method === 'GET') { json(await store.list()); return true; }
      if (pathname !== '/api/acessos/abas') {
        let idUsuario: number;
        try { idUsuario = normalizeAccessUserId(decodeURIComponent(pathname.slice('/api/acessos/abas/'.length))); } catch { throw new AuthError(400, 'Código de usuário inválido.'); }
        if (req.method === 'GET') { json(await store.current(idUsuario)); return true; }
        if (req.method === 'PUT') { json(await store.update(idUsuario, await readAuthBody(req))); return true; }
      }
      throw new AuthError(405, 'Método não permitido.');
    }
    const tabs = requiredTabs(pathname);
    // Importação e envio de apontamentos salvos são básicos para toda conta autenticada.
    if (tabs && !tabs.some(tab => ABAS_OBRIGATORIAS.includes(tab))) {
      if (user.perfil === 'admin') return false;
      const access = await store.current(user.idUsuario);
      if (!tabs.some(tab => access.abas.includes(tab))) throw new AuthError(403, 'Esta aba não foi liberada para este usuário.');
    }
    return false;
  };
}
