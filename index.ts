import { buscarFuncionarioUsuario } from './usuario-funcionario.ts';
import { listarEquipamentosEmLote } from './irrigacao-lote.ts';
import { incluirParametrosFixos, validarParametrosFixos } from './irrigacao-parametros.ts';
import { atenderBiometriaLocal, registrarUsuarioBiometria } from './biometria-local.ts';
/**
 * API REST do AgroControl.
 *
 * Execute: npm run api:mock
 *
 * O admin grava usuário/senha do Oracle no celular. Esta API no PC usa
 * X-Oracle-User / X-Oracle-Password para abrir o banco (host no .env).
 */

import fs from 'node:fs';
import { gravarIrrigacao, listarTiposIrrigacao, listarEquipamentosIrrigacao, planejarImportacaoEquipamentos, consultarEquipamentoIrrigacao, listarEspacamentosIrrigacao, listarMotivosParadaIrrigacao } from './irrigacao.ts';
import type { IrrigacaoEntrada } from './irrigacao-types.ts';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, createAuthGuard } from './auth.ts';
import { createEmailAccessGuard, createEmailAccessStore, DEFAULT_ACCESS_URL } from './email-access.ts';
import { createAcessoAbasSqlite } from './acesso-abas-sqlite.ts';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

import { gravarApontamentoTmp, listarCadastrosApontamento, listarPaginaCadastros } from './apontamento.ts';
import { gravarMaoDeObra, listarServicosMaoDeObra, listarTurmasMaoDeObra } from './mao-de-obra.ts';
import { consultarCustosTalhao, limparCacheCustos } from './custo-talhao.ts';
import { gravarPerdaColheita, listarCadastrosPerda } from './perdas.ts';
import { carregarMapaOrds as buscarTalhoesOrds } from './mapa-ords.ts';
import {
  comCredenciaisOracle,
  consultarTalhaoPorPonto,
  mensagemErroOracle,
  obterConfigPublicaOracle,
  oracleConfigurado,
  oracleCredenciaisPreenchidas,
  salvarConfigOracle,
  sincronizarConexaoBancoOrds,
  testarConexaoOracle,
  withOracleGravacao,
  type OracleConfigEntrada,
} from './oracle.ts';

carregarEnv(path.join(SERVER_DIR, '.env'));

const acessoAbasOrds = createEmailAccessStore({ url: process.env.ORDS_ACESSO_ABA_URL || DEFAULT_ACCESS_URL, token: process.env.ORDS_ACESSO_ABA_TOKEN || '' });
const acessoAbasLocal = createAcessoAbasSqlite(path.join(SERVER_DIR, 'data', 'acesso-abas.sqlite'));
const importarAcessosIniciais = acessoAbasLocal.importarOrdsSeVazio(acessoAbasOrds)
  .then((usuarios) => { if (usuarios) console.log(`Liberações importadas da ORDS para SQLite: ${usuarios} usuários.`); })
  .catch((erro: unknown) => console.warn(`Não foi possível importar liberações da ORDS: ${erro instanceof Error ? erro.message : String(erro)}`));
const verificarAcessoAba = createEmailAccessGuard(acessoAbasLocal);
const authGuard = createAuthGuard(createAuth({
  buscarFuncionario: buscarFuncionarioUsuario,
  sessionFile: path.join(SERVER_DIR, 'data', 'sessoes.json'),
  url: process.env.ORDS_AUTH_USUARIOS_URL ?? '',
  token: process.env.ORDS_AUTH_TOKEN ?? '',
  allowLegacy: process.env.AUTH_ALLOW_LEGACY_SHA256 === 'true',
}), async (req, res, pathname, usuario) => {
  const atendeu = await verificarAcessoAba(req, res, pathname, usuario);
  if (!atendeu && pathname.startsWith('/api/biometria/')) registrarUsuarioBiometria(req, usuario);
  return atendeu;
});

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const ORDS_MAPA_TALHAO_URL = (
  process.env.ORDS_MAPA_TALHAO_URL ??
  process.env.EXPO_PUBLIC_ORDS_MAPA_TALHAO_URL ??
  'https://g58645a2c384a96-bd1.adb.sa-saopaulo-1.oraclecloudapps.com/ords/admin/mapa_talhao'
).replace(/\/$/, '');

const TABELAS_TESTE_INSERT_IRRIGACAO = [
  'agricola.tmp_irrigacaoapontitem',
  'agricola.tmp_irrigacaoapontinsumo',
  'agricola.tmp_irrig_fazenda',
] as const;

async function testarInsertZeroLinhasIrrigacao() {
  await sincronizarConexaoBancoOrds();
  return withOracleGravacao(async (connection) => {
    const resultados: Array<{ tabela: string; ok: boolean; mensagem: string }> = [];
    for (const tabela of TABELAS_TESTE_INSERT_IRRIGACAO) {
      try {
        await connection.execute(`INSERT INTO ${tabela} SELECT * FROM ${tabela} WHERE 1 = 0`, {}, { autoCommit: false });
        await connection.rollback();
        resultados.push({ tabela, ok: true, mensagem: 'INSERT permitido; nenhuma linha gravada.' });
      } catch (erro) {
        await connection.rollback().catch(() => undefined);
        resultados.push({ tabela, ok: false, mensagem: mensagemErroOracle(erro) });
      }
    }
    return resultados;
  });
}

interface Feature {
  type: string;
  geometry?: {
    type: string;
    coordinates: unknown;
  };
  properties?: Record<string, unknown> | null;
}

interface Collection {
  features: Feature[];
}

function carregarEnv(arquivo: string) {
  if (!fs.existsSync(arquivo)) {
    return;
  }
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) {
      continue;
    }
    const separador = texto.indexOf('=');
    if (separador <= 0) {
      continue;
    }
    const chave = texto.slice(0, separador).trim();
    const valor = texto.slice(separador + 1).trim();
    if (!process.env[chave]) {
      process.env[chave] = valor;
    }
  }
}

/** Lê PUBLIC_API_URL do .env (atualizado pelo npm run public). */
function lerPublicApiUrlDoArquivo(): string {
  const arquivo = path.join(SERVER_DIR, '.env');
  if (!fs.existsSync(arquivo)) {
    return '';
  }
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) {
      continue;
    }
    const separador = texto.indexOf('=');
    if (separador <= 0) {
      continue;
    }
    const chave = texto.slice(0, separador).trim();
    if (chave === 'PUBLIC_API_URL') {
      return texto.slice(separador + 1).trim().replace(/\/$/, '');
    }
  }
  return '';
}

function obterPublicApiUrl(): string {
  return (
    lerPublicApiUrlDoArquivo() ||
    (process.env.PUBLIC_API_URL ?? process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '')
  );
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0];
    const yi = ring[i]?.[1];
    const xj = ring[j]?.[0];
    const yj = ring[j]?.[1];
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) {
      continue;
    }
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function contains(feature: Feature, lng: number, lat: number): boolean {
  const geometry = feature.geometry;
  if (!geometry) {
    return false;
  }
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as number[][][];
    const outer = rings[0];
    if (!outer || !pointInRing(lng, lat, outer)) {
      return false;
    }
    return !rings.slice(1).some((hole) => pointInRing(lng, lat, hole));
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).some((polygon) => {
      const outer = polygon[0];
      if (!outer || !pointInRing(lng, lat, outer)) {
        return false;
      }
      return !polygon.slice(1).some((hole) => pointInRing(lng, lat, hole));
    });
  }
  return false;
}

function localizarMock(collection: Collection, latitude: number, longitude: number) {
  const match = collection.features.find((feature) => contains(feature, longitude, latitude));
  if (!match?.properties) {
    return {
      encontrado: false,
      mensagem: 'Localização fora dos talhões cadastrados',
      latitude,
      longitude,
      origem: 'mock',
    };
  }

  const p = match.properties;
  return {
    encontrado: true,
    fazenda: {
      codigo: Number(p.Cod_fazend ?? 0),
      nome: String(p.Fazenda ?? 'Desconhecida'),
    },
    talhao: {
      codigo: Number(p.Lote ?? 0),
    },
    latitude,
    longitude,
    origem: 'mock',
  };
}

async function localizar(latitude: number, longitude: number) {
  if (oracleConfigurado()) {
    return consultarTalhaoPorPonto(latitude, longitude);
  }
  const mapa = await carregarMapaOrds();
  return localizarMock(mapa, latitude, longitude);
}

let collection: Collection = { features: [] };
let mapaCarregadoEm = 0;
let mapaCarregando: Promise<Collection> | null = null;

async function carregarMapaOrds(force = false): Promise<Collection> {
  if (!force && Date.now() - mapaCarregadoEm < 10 * 60_000 && collection.features.length > 0) {
    return collection;
  }
  if (!force && mapaCarregando) {
    return mapaCarregando;
  }

  mapaCarregando = (async () => {
    const features = await buscarTalhoesOrds(ORDS_MAPA_TALHAO_URL);
    collection = { features };
    mapaCarregadoEm = Date.now();
    return collection;
  })().finally(() => {
    mapaCarregando = null;
  });

  return mapaCarregando;
}

function lerJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const pedacos: Buffer[] = [];
    req.on('data', (pedaco: Buffer) => {
      pedacos.push(pedaco);
    });
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos).toString('utf8');
      if (!bruto.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(bruto) as Record<string, unknown>);
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function headerTexto(req: http.IncomingMessage, nome: string): string {
  const bruto = req.headers[nome];
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  if (!valor) {
    return '';
  }
  try {
    return decodeURIComponent(String(valor));
  } catch {
    return String(valor);
  }
}

function comOracleDoPedido<T>(
  req: http.IncomingMessage,
  fn: () => Promise<T>,
  corpo?: Record<string, unknown>,
): Promise<T> {
  const usuario =
    headerTexto(req, 'x-oracle-user') ||
    (typeof corpo?.oracleUsuario === 'string' ? corpo.oracleUsuario.trim() : '');
  const senha =
    headerTexto(req, 'x-oracle-password') ||
    (typeof corpo?.oracleSenha === 'string' ? corpo.oracleSenha : '');
  return comCredenciaisOracle(usuario, senha, fn);
}

function entradaOracleDoCorpo(corpo: Record<string, unknown>): OracleConfigEntrada {
  const senha = typeof corpo.senha === 'string' ? corpo.senha : undefined;
  return {
    usuario: typeof corpo.usuario === 'string' ? corpo.usuario : '',
    ...(senha !== undefined ? { senha } : {}),
    host: typeof corpo.host === 'string' ? corpo.host : undefined,
    porta: typeof corpo.porta === 'string' || typeof corpo.porta === 'number' ? String(corpo.porta) : undefined,
    servico: typeof corpo.servico === 'string' ? corpo.servico : undefined,
    connectString: typeof corpo.connectString === 'string' ? corpo.connectString : undefined,
    instantClientDir: typeof corpo.instantClientDir === 'string' ? corpo.instantClientDir : undefined,
    useOracle: typeof corpo.useOracle === 'boolean' ? corpo.useOracle : undefined,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning, X-Device-ID, X-Oracle-User, X-Oracle-Password, X-Envio-Lote');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (await authGuard(req, res, url.pathname)) return;
  if (await atenderBiometriaLocal(req, res, url, SERVER_DIR)) return;

  if (req.method === 'GET' && url.pathname === '/api/localizacao') {
    const latitude = Number(url.searchParams.get('latitude'));
    const longitude = Number(url.searchParams.get('longitude'));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ encontrado: false, mensagem: 'latitude e longitude são obrigatórios' }));
      return;
    }

    void localizar(latitude, longitude)
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        const mensagem = erro instanceof Error ? erro.message : 'Erro ao consultar localização';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ encontrado: false, mensagem }));
      });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/talhao/custos') {
    const codigoFazenda = Number(url.searchParams.get('codigoFazenda'));
    const talhao = Number(url.searchParams.get('talhao'));
    const areaHaRaw = Number(url.searchParams.get('areaHa'));
    if (!Number.isFinite(codigoFazenda) || !Number.isFinite(talhao)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: 'codigoFazenda e talhao são obrigatórios' }));
      return;
    }

    void comOracleDoPedido(req, () =>
      consultarCustosTalhao({
        codigoFazenda,
        talhao,
        anomesInicio: url.searchParams.get('anomesInicio') ?? undefined,
        anomesFim: url.searchParams.get('anomesFim') ?? undefined,
        areaHa: Number.isFinite(areaHaRaw) && areaHaRaw > 0 ? areaHaRaw : null,
      }),
    )
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        const mensagem = mensagemErroOracle(erro);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem }));
      });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/assistente') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        resposta:
          'TODO GPT: integrar OpenAI neste endpoint do backend. A localização já deve vir no contexto (fazenda/talhão).',
      }),
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/oracle-config') {
    void sincronizarConexaoBancoOrds()
      .then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obterConfigPublicaOracle()));
      })
      .catch((erro: unknown) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
      });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/oracle-config') {
    void lerJson(req)
      .then((corpo) => {
        const salva = salvarConfigOracle(entradaOracleDoCorpo(corpo));
        limparCacheCustos();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(salva));
      })
      .catch((erro: unknown) => {
        const mensagem = mensagemErroOracle(erro);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem }));
      });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/oracle-config/test') {
    void lerJson(req)
      .then((corpo) => testarConexaoOracle(entradaOracleDoCorpo(corpo)))
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        const mensagem = mensagemErroOracle(erro);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, mensagem }));
      });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/irrigacao/motivos-parada') {
    try {
      const resultado = await listarMotivosParadaIrrigacao(Number(url.searchParams.get('codFazenda')), Number(url.searchParams.get('codOperacao')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/irrigacao/espacamentos') {
    try {
      const resultado = await listarEspacamentosIrrigacao();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/irrigacao/equipamento') {
    try {
      const resultado = incluirParametrosFixos(await consultarEquipamentoIrrigacao(Number(url.searchParams.get('codigo')), url.searchParams.get('data') ?? ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/irrigacao/equipamentos/lote') {
    try {
      const corpo = await lerJson(req);
      const resultado = await comOracleDoPedido(req, () => listarEquipamentosEmLote(corpo.contextos), corpo);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/irrigacao/equipamentos/contextos') {
    try {
      const corpo = await lerJson(req);
      const resultado = await comOracleDoPedido(req, () => planejarImportacaoEquipamentos(corpo.contextos), corpo);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/irrigacao/equipamentos') {
    try {
      const resultado = incluirParametrosFixos(await listarEquipamentosIrrigacao(Number(url.searchParams.get('codFazenda')), Number(url.searchParams.get('codOperacao')), url.searchParams.get('data') ?? ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/irrigacao/tipos') {
    try {
      const resultado = await listarTiposIrrigacao();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/irrigacao') {
    try {
      const resultado = await gravarIrrigacao(validarParametrosFixos(await lerJson(req) as unknown as IrrigacaoEntrada));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultado));
    } catch (erro) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/irrigacao/insert-test') {
    void testarInsertZeroLinhasIrrigacao()
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: resultado.every((item) => item.ok), resultados: resultado }));
      })
      .catch((erro: unknown) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, mensagem: mensagemErroOracle(erro) }));
      });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/apontamento/cadastros') {
    void comOracleDoPedido(req, async () => url.searchParams.has('grupo')
      ? listarPaginaCadastros(url.searchParams.get('grupo') ?? '', url.searchParams.get('token') ?? undefined, Number(url.searchParams.get('offset') ?? 0))
      : listarCadastrosApontamento())
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        const mensagem = mensagemErroOracle(erro);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem }));
      });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/apontamento') {
    void lerJson(req)
      .then((corpo) =>
        comOracleDoPedido(
          req,
          () =>
            gravarApontamentoTmp({
              codFazenda: Number(corpo.codFazenda),
              codTalhao: Number(corpo.codTalhao),
              zona: corpo.zona != null ? Number(corpo.zona) : undefined,
              codSafra: corpo.codSafra != null ? Number(corpo.codSafra) : null,
              codOperacao: Number(corpo.codOperacao),
              tipoOperacao:
                typeof corpo.tipoOperacao === 'string' && corpo.tipoOperacao.trim()
                  ? corpo.tipoOperacao.trim().toUpperCase().slice(0, 1)
                  : 'M',
              codFuncionario: Number(corpo.codFuncionario),
              codObjetocusto: corpo.codObjetocusto != null ? Number(corpo.codObjetocusto) : null,
              areaAplicada: Number(corpo.areaAplicada),
              codMeioaplicacao: Number(corpo.codMeioaplicacao),
              codMaterial: corpo.codMaterial != null ? Number(corpo.codMaterial) : undefined,
              dose: corpo.dose != null ? Number(corpo.dose) : 0,
              quantidade: corpo.quantidade != null ? Number(corpo.quantidade) : undefined,
              materiais: Array.isArray(corpo.materiais)
                ? corpo.materiais.map((item: { codMaterial?: unknown; quantidade?: unknown; dose?: unknown }) => ({
                    codMaterial: Number(item.codMaterial),
                    quantidade: Number(item.quantidade),
                    dose: Number(item.dose) || 0,
                  }))
                : undefined,
              dataApontamento: typeof corpo.dataApontamento === 'string' ? corpo.dataApontamento : undefined,
              logon: typeof corpo.logon === 'string' ? corpo.logon : undefined,
            }),
          corpo,
        ),
      )
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        const mensagem = mensagemErroOracle(erro);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem }));
      });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/apontamento/mao-de-obra/turmas') {
    try {
      const turmas = await listarTurmasMaoDeObra();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(turmas));
    } catch (erro) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/apontamento/mao-de-obra/servicos') {
    void listarServicosMaoDeObra(Number(url.searchParams.get('codFazenda')), url.searchParams.get('data') ?? '')
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
      });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/apontamento/mao-de-obra') {
    void lerJson(req)
      .then((corpo) => comOracleDoPedido(req, () => gravarMaoDeObra({
        codAgenciador: Number(corpo.codAgenciador), codGrupoempresaTurma: Number(corpo.codGrupoempresaTurma),
        codFuncionario: Number(corpo.codFuncionario),
        codFazenda: Number(corpo.codFazenda),
        codTalhao: Number(corpo.codTalhao),
        codOperacao: Number(corpo.codOperacao),
        dataApontamento: typeof corpo.dataApontamento === 'string' ? corpo.dataApontamento : '',
        quantidade: Number(corpo.quantidade),
        observacao: typeof corpo.observacao === 'string' ? corpo.observacao : undefined,
        logon: typeof corpo.logon === 'string' ? corpo.logon : undefined,
      }), corpo))
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem: mensagemErroOracle(erro) }));
      });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/perdas/cadastros') {
    void comOracleDoPedido(req, () => listarCadastrosPerda())
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        const mensagem = mensagemErroOracle(erro);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem }));
      });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/perdas') {
    void lerJson(req)
      .then((corpo) => {
        const itensBrutos = Array.isArray(corpo.itens) ? corpo.itens : [];
        return comOracleDoPedido(
          req,
          () =>
            gravarPerdaColheita({
              codTipocorte: Number(corpo.codTipocorte),
              codFazenda: Number(corpo.codFazenda),
              codTalhao: Number(corpo.codTalhao),
              zona: corpo.zona != null ? Number(corpo.zona) : undefined,
              codSafra: corpo.codSafra != null ? Number(corpo.codSafra) : undefined,
              codSafradetalhe: corpo.codSafradetalhe != null ? Number(corpo.codSafradetalhe) : undefined,
              dataAmostra: typeof corpo.dataAmostra === 'string' ? corpo.dataAmostra : undefined,
              turno: typeof corpo.turno === 'string' ? corpo.turno : undefined,
              codFrente: corpo.codFrente != null ? Number(corpo.codFrente) : null,
              codEquipamento: corpo.codEquipamento != null ? Number(corpo.codEquipamento) : null,
              codOperador: corpo.codOperador != null ? Number(corpo.codOperador) : null,
              tipoOperador: typeof corpo.tipoOperador === 'string' ? corpo.tipoOperador : undefined,
              bituca: typeof corpo.bituca === 'string' ? corpo.bituca : undefined,
              latitude: typeof corpo.latitude === 'string' ? corpo.latitude : null,
              longitude: typeof corpo.longitude === 'string' ? corpo.longitude : null,
              itens: itensBrutos.map((item) => {
                const linha = item as Record<string, unknown>;
                return {
                  codTipoperda: Number(linha.codTipoperda),
                  quantidade: Number(linha.quantidade) || 0,
                };
              }),
            }),
          corpo,
        );
      })
      .then((resultado) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch((erro: unknown) => {
        const mensagem = erro instanceof Error ? erro.message : 'Erro ao gravar perda de colheita';
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensagem }));
      });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const publicUrl = obterPublicApiUrl();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        servico: 'AgroControl API',
        publicUrl,
        ngrok: Boolean(publicUrl && /^https:\/\//i.test(publicUrl)),
      }),
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const publicUrl = obterPublicApiUrl();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        servico: 'AgroControl API',
        versao: '2026-10-20-auth',
        publicUrl,
        oracle: oracleConfigurado(),
        rotas: [
          'POST /api/auth/login',
          'GET /api/auth/me',
          'POST /api/auth/logout',
          'GET /api/usuarios',
          'POST /api/usuarios',
          'GET /api/config',
          'GET /api/apontamento/cadastros',
          'POST /api/apontamento',
          'GET /api/apontamento/mao-de-obra/servicos',
          'POST /api/apontamento/mao-de-obra',
          'GET /api/perdas/cadastros',
          'POST /api/perdas',
          'GET /api/talhao/custos',
          'GET /api/localizacao',
        ],
      }),
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ mensagem: 'Rota não encontrada' }));
});

void importarAcessosIniciais.finally(() => server.listen(PORT, '0.0.0.0', () => {
  console.log(`AgroControl API em http://0.0.0.0:${PORT}`);
  console.log(
    oracleConfigurado()
      ? 'Localização Oracle: LIGADA (agricola.fazenda / agricola.talhao)'
      : 'Localização: API mapa_talhao (ORDS). Custos do talhão usam Oracle se as credenciais estiverem preenchidas.',
  );
  console.log(
    oracleCredenciaisPreenchidas()
      ? 'Custos: Oracle (abastecimento → fazenda/talhão; operações em consulta separada)'
      : 'Custos: credenciais Oracle ausentes em server/.env',
  );
  console.log('GET /api/oracle-config  PUT /api/oracle-config  POST /api/oracle-config/test');
  console.log('GET /api/apontamento/cadastros  POST /api/apontamento  POST /api/apontamento/mao-de-obra  GET /api/apontamento/mao-de-obra/servicos');
  console.log('GET /api/perdas/cadastros  POST /api/perdas');
  console.log('GET /api/talhao/custos?codigoFazenda=40800&talhao=1&anomesInicio=202508&anomesFim=202608');
}));
