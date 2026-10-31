import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PASTA = path.dirname(fileURLToPath(import.meta.url));
export const ARQUIVO_ENV = path.join(PASTA, '.env');
export const ARQUIVO_PID = path.join(PASTA, 'api.pid');
export const PASTA_LOGS = path.join(PASTA, 'logs');
export const ARQUIVO_LOG = path.join(PASTA_LOGS, 'api-public.log');

const CHAVES = [
  'USE_ORACLE',
  'ORACLE_USER',
  'ORACLE_PASSWORD',
  'ORACLE_CONNECT_STRING',
  'ORACLE_GRAVACAO_USER',
  'ORACLE_GRAVACAO_PASSWORD',
  'ORACLE_PERDAS_USER',
  'ORACLE_PERDAS_PASSWORD',
  'ORDS_CONEXAO_BANCO_URL',
  'ORDS_USER',
  'ORDS_PASSWORD',
  'NGROK_AUTHTOKEN',
  'ORACLE_USE_THICK',
  'ORACLE_INSTANT_CLIENT',
  'API_PORT',
  'NGROK_API_PORT',
  'PUBLIC_API_URL',
];

export function carregarEnvNoProcesso() {
  const valores = lerEnv();
  for (const [chave, valor] of Object.entries(valores)) {
    if (!process.env[chave]) {
      process.env[chave] = valor;
    }
  }
}

export function lerEnv() {
  const valores = {};
  if (!fs.existsSync(ARQUIVO_ENV)) {
    return valores;
  }
  for (const linha of fs.readFileSync(ARQUIVO_ENV, 'utf8').split(/\r?\n/)) {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) {
      continue;
    }
    const separador = texto.indexOf('=');
    if (separador <= 0) {
      continue;
    }
    valores[texto.slice(0, separador).trim()] = texto.slice(separador + 1).trim();
  }
  return valores;
}

export function parseConnectString(texto) {
  const bruto = String(texto ?? '').trim();
  const match = bruto.match(/^([^:/]+):(\d+)\/(.+)$/);
  if (!match) {
    return { host: bruto, porta: '', servico: '' };
  }
  return { host: match[1], porta: match[2], servico: match[3] };
}

export function montarConnectString(host, porta, servico) {
  const h = String(host ?? '').trim();
  const p = String(porta ?? '').trim();
  const s = String(servico ?? '').trim();
  if (h && p && s) {
    return `${h}:${p}/${s}`;
  }
  return [h, p, s].filter(Boolean).join('');
}

export function configAtual() {
  const env = lerEnv();
  const conn = parseConnectString(env.ORACLE_CONNECT_STRING ?? '');
  return {
    usuario: env.ORACLE_USER ?? 'CONSULTA',
    senha: env.ORACLE_PASSWORD ?? '',
    usuarioGravacao: env.ORACLE_GRAVACAO_USER ?? env.ORACLE_USER ?? 'CONSULTA',
    senhaGravacao: env.ORACLE_GRAVACAO_PASSWORD ?? env.ORACLE_PASSWORD ?? '',
    usuarioPerdas: env.ORACLE_PERDAS_USER ?? '',
    senhaPerdas: env.ORACLE_PERDAS_PASSWORD ?? '',
    ordsUser: env.ORDS_USER ?? '',
    ordsPassword: env.ORDS_PASSWORD ?? '',
    ngrokAuthtoken: env.NGROK_AUTHTOKEN ?? '',
    hostNgrok: conn.host || '0.tcp.sa.ngrok.io',
    portaNgrok: conn.porta || '10057',
    servico: conn.servico || 'CSORCL',
    portaAgenteNgrok: env.NGROK_API_PORT ?? '4040',
    portaApi: env.API_PORT ?? '3001',
    useOracle: (env.USE_ORACLE ?? 'false') !== 'false',
    thick: (env.ORACLE_USE_THICK ?? 'true') !== 'false',
    instantClient: env.ORACLE_INSTANT_CLIENT ?? '',
    ordsUrl: env.ORDS_CONEXAO_BANCO_URL ?? '',
    publicUrl: env.PUBLIC_API_URL ?? '',
  };
}

export function gravarConfig(entrada) {
  const connectString = montarConnectString(entrada.hostNgrok, entrada.portaNgrok, entrada.servico);
  const patch = {
    USE_ORACLE: entrada.useOracle ? 'true' : 'false',
    ORACLE_USER: String(entrada.usuario ?? '').trim(),
    ORACLE_PASSWORD: String(entrada.senha ?? ''),
    ORACLE_GRAVACAO_USER: String(entrada.usuarioGravacao ?? entrada.usuario ?? '').trim(),
    ORACLE_GRAVACAO_PASSWORD: String(entrada.senhaGravacao ?? entrada.senha ?? ''),
    ORACLE_PERDAS_USER: String(entrada.usuarioPerdas ?? '').trim(),
    ORACLE_PERDAS_PASSWORD: String(entrada.senhaPerdas ?? ''),
    ORACLE_CONNECT_STRING: connectString,
    ORDS_CONEXAO_BANCO_URL: String(entrada.ordsUrl ?? '').trim(),
    ORDS_USER: String(entrada.ordsUser ?? '').trim(),
    ORDS_PASSWORD: String(entrada.ordsPassword ?? ''),
    NGROK_AUTHTOKEN: String(entrada.ngrokAuthtoken ?? '').trim(),
    ORACLE_USE_THICK: entrada.thick ? 'true' : 'false',
    ORACLE_INSTANT_CLIENT: String(entrada.instantClient ?? '').trim(),
    API_PORT: String(entrada.portaApi ?? '3001').trim() || '3001',
    NGROK_API_PORT: String(entrada.portaAgenteNgrok ?? '4040').trim() || '4040',
  };
  gravarEnv(patch);
  return configAtual();
}

function gravarEnv(patch) {
  const linhas = fs.existsSync(ARQUIVO_ENV)
    ? fs.readFileSync(ARQUIVO_ENV, 'utf8').split(/\r?\n/)
    : [
        '# AgroControl API — editável pelo Configurar-API',
        'USE_ORACLE=false',
        'ORACLE_USER=CONSULTA',
        'ORACLE_PASSWORD=',
        'ORACLE_CONNECT_STRING=0.tcp.sa.ngrok.io:10057/CSORCL',
        'ORDS_CONEXAO_BANCO_URL=https://g58645a2c384a96-bd1.adb.sa-saopaulo-1.oraclecloudapps.com/ords/admin/conexao_banco',
        'ORACLE_USE_THICK=true',
        'ORACLE_INSTANT_CLIENT=',
        'API_PORT=3001',
        'NGROK_API_PORT=4040',
      ];

  const usados = new Set();
  const novas = linhas.map((linha) => {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) {
      return linha;
    }
    const separador = texto.indexOf('=');
    if (separador <= 0) {
      return linha;
    }
    const chave = texto.slice(0, separador).trim();
    if (patch[chave] === undefined) {
      return linha;
    }
    usados.add(chave);
    return `${chave}=${patch[chave]}`;
  });

  for (const chave of CHAVES) {
    if (patch[chave] !== undefined && !usados.has(chave) && chave !== 'PUBLIC_API_URL') {
      novas.push(`${chave}=${patch[chave]}`);
    }
  }

  fs.writeFileSync(ARQUIVO_ENV, `${novas.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

export function gravarPublicUrl(url) {
  gravarEnv({ PUBLIC_API_URL: String(url ?? '').replace(/\/$/, '') });
}
