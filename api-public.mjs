/**
 * Sobe só a API e publica no ngrok.
 * Pasta copiável: este diretório, sem o app Expo.
 *
 * Clique em AgroControl-API.vbs para rodar em segundo plano,
 * ou Configurar-API.vbs para alterar usuário/porta.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { carregarEnvNoProcesso, gravarPublicUrl, PASTA } from './env-arquivo.mjs';

carregarEnvNoProcesso();

const API_PORT = Number(process.env.API_PORT ?? 3001);
const NGROK_API_PORT = Number(process.env.NGROK_API_PORT ?? 4040);
const NGROK_API = `http://127.0.0.1:${NGROK_API_PORT}/api/tunnels`;
const ORDS =
  process.env.ORDS_CONEXAO_BANCO_URL?.replace(/\/$/, '') ||
  'https://g58645a2c384a96-bd1.adb.sa-saopaulo-1.oraclecloudapps.com/ords/admin/conexao_banco';

function cabecalhosOrds() {
  const user = String(process.env.ORDS_USER ?? '').trim();
  const password = String(process.env.ORDS_PASSWORD ?? '');
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (user && password) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }
  return headers;
}

const filhos = [];

function encerrar(codigo = 0) {
  for (const filho of filhos) {
    if (!filho.killed) {
      filho.kill();
    }
  }
  process.exit(codigo);
}

process.on('SIGINT', () => encerrar(0));
process.on('SIGTERM', () => encerrar(0));
process.on('unhandledRejection', (erro) => {
  console.error(erro);
});

async function apiSaudavel() {
  try {
    const resposta = await fetch(`http://127.0.0.1:${API_PORT}/health`);
    return resposta.ok;
  } catch {
    return false;
  }
}

async function esperarSaude() {
  for (let i = 0; i < 50; i += 1) {
    if (await apiSaudavel()) {
      return;
    }
    await sleep(400);
  }
  throw new Error(`A API local não subiu em http://127.0.0.1:${API_PORT}`);
}

async function lerJsonSeguro(resposta) {
  const texto = await resposta.text();
  if (!texto || texto.trim().startsWith('<')) {
    return null;
  }
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

async function listarTunnels() {
  try {
    const resposta = await fetch(NGROK_API);
    const data = await lerJsonSeguro(resposta);
    return data?.tunnels ?? [];
  } catch {
    return [];
  }
}

function urlHttps(tunnels) {
  const https = tunnels.find((item) => String(item.public_url ?? '').startsWith('https://'));
  return https?.public_url ? String(https.public_url).replace(/\/$/, '') : null;
}

async function criarTunelNoAgente() {
  const resposta = await fetch(NGROK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'agrocontrol-api',
      addr: `localhost:${API_PORT}`,
      proto: 'http',
      pooling_enabled: true,
    }),
  });
  const corpo = await lerJsonSeguro(resposta);
  if (!resposta.ok) {
    const texto = JSON.stringify(corpo ?? {});
    if (/ERR_NGROK_334|already online/i.test(texto)) {
      const atual = urlHttps(await listarTunnels());
      if (atual) {
        return atual;
      }
    }
    throw new Error(texto || `ngrok ${resposta.status}`);
  }
  return String(corpo?.public_url ?? '').replace(/\/$/, '') || urlHttps(await listarTunnels());
}

async function obterUrlNgrok() {
  try {
    const atual = urlHttps(await listarTunnels());
    if (atual) {
      console.log(`Reusando o ngrok do agente na porta ${NGROK_API_PORT}.`);
      return atual;
    }
    const criado = await criarTunelNoAgente();
    if (criado) {
      console.log('Túnel HTTP adicionado no ngrok que já estava no ar (mesmo agente do Oracle).');
      return criado;
    }
  } catch {
    /* não há agente local; sobe um ngrok só da API */
  }

  const urlReservada = String(process.env.PUBLIC_API_URL ?? process.env.NGROK_URL ?? '')
    .trim()
    .replace(/\/$/, '');

  async function subirNgrok(usarUrlReservada) {
    const args = ['http', String(API_PORT), '--pooling-enabled', '--log=stdout'];
    if (usarUrlReservada && /^https:\/\//i.test(urlReservada)) {
      args.push('--url', urlReservada);
      console.log(`Publicando no endereço reservado ${urlReservada}`);
    }
    const ngrok = spawn('ngrok', args, {
      cwd: PASTA,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    filhos.push(ngrok);
    let falha = '';
    ngrok.stderr?.on('data', (buf) => {
      const texto = String(buf);
      falha += texto;
      if (/ERR_|error|failed/i.test(texto)) {
        process.stderr.write(texto);
      }
    });
    ngrok.stdout?.on('data', (buf) => {
      const texto = String(buf);
      falha += texto;
      if (/ERR_NGROK_|failed to start tunnel/i.test(texto)) {
        process.stderr.write(texto);
      }
    });
    for (let i = 0; i < 50; i += 1) {
      const url = urlHttps(await listarTunnels());
      if (url) {
        return { url, falha: '' };
      }
      if (ngrok.exitCode) {
        break;
      }
      await sleep(400);
    }
    return { url: null, falha };
  }

  let resultado = await subirNgrok(Boolean(urlReservada));
  if (!resultado.url && /ERR_NGROK_320|reserved for another account/i.test(resultado.falha)) {
    console.log('Domínio reservado de outra conta. Publicando com URL nova deste ngrok.');
    resultado = await subirNgrok(false);
  }
  if (resultado.url) {
    return resultado.url;
  }
  const falha = resultado.falha;

  if (/ERR_NGROK_320|reserved for another account/i.test(falha)) {
    throw new Error(
      'O domínio HTTPS do PUBLIC_API_URL pertence a outra conta ngrok. No PC do ngrok, use o authtoken certo; neste PC, deixe PUBLIC_API_URL vazio para gerar uma URL nova.',
    );
  }
  if (/ERR_NGROK_334|already online/i.test(falha)) {
    throw new Error(
      'O endereço HTTPS do ngrok já está em uso nesta conta. Finalize ngrok.exe extras (mantenha o túnel TCP do Oracle) e inicie de novo.',
    );
  }
  if (/ERR_NGROK_108|simultaneous ngrok agent/i.test(falha)) {
    throw new Error(
      `Já existe um ngrok neste PC. Ajuste NGROK_API_PORT no Configurar-API (hoje ${NGROK_API_PORT}) para a porta do agente, ou deixe só um ngrok no ar.`,
    );
  }
  throw new Error(
    'O ngrok não publicou a URL. Instale o ngrok neste PC, autentique, e deixe só um ngrok no ar.',
  );
}

function descricaoComApi(descricao, url) {
  const base = String(descricao ?? '')
    .replace(/\s*#API=\S+/gi, '')
    .trim() || 'Conexão de insumos';
  return `${base} #API=${url}`;
}

async function publicarUrl(url) {
  const listaResposta = await fetch(`${ORDS}/?limit=50`, { headers: cabecalhosOrds() });
  const lista = await lerJsonSeguro(listaResposta);
  if (!lista) {
    throw new Error(
      `ORDS conexao_banco respondeu ${listaResposta.status}. Informe ORDS_USER e ORDS_PASSWORD no Configurar-API.`,
    );
  }
  const ativas = (lista.items ?? []).filter((item) => Number(item.ativo ?? 1) === 1);
  const row = ativas.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))[0];
  if (!row) {
    console.log(`Nenhuma conexão em conexao_banco. URL pública: ${url}`);
    return;
  }
  const resposta = await fetch(`${ORDS}/`, {
    method: 'POST',
    headers: cabecalhosOrds(),
    body: JSON.stringify({
      usuario: row.usuario,
      senha: row.senha,
      host: row.host,
      porta: row.porta,
      service_name: row.service_name,
      descricao: descricaoComApi(row.descricao, url),
      ativo: 1,
      data_cadastro: new Date().toISOString(),
    }),
  });
  if (!resposta.ok) {
    throw new Error(await resposta.text());
  }
  const nova = await lerJsonSeguro(resposta);
  if (row.id != null && Number(row.id) !== Number(nova?.id)) {
    await fetch(`${ORDS}/${row.id}`, { method: 'DELETE', headers: cabecalhosOrds() }).catch(() => undefined);
  }
  console.log(`API pública gravada. O APK passa a usar: ${url}`);
}

process.chdir(PASTA);

if (await apiSaudavel()) {
  console.log(`Reusando a API que já está em http://127.0.0.1:${API_PORT}`);
} else {
  const api = spawn(process.execPath, ['index.ts'], {
    cwd: PASTA,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: String(API_PORT) },
  });
  filhos.push(api);
  api.on('exit', (code) => {
    if (code && code !== 0) {
      encerrar(code);
    }
  });
}

await esperarSaude();
const url = await obterUrlNgrok();

const saudePublica = await fetch(`${url}/health`, {
  headers: { 'ngrok-skip-browser-warning': 'true' },
});
if (!saudePublica.ok) {
  throw new Error(`A URL pública respondeu ${saudePublica.status} em ${url}/health`);
}

try {
  await publicarUrl(url);
} catch (erro) {
  console.error('Não foi possível gravar #API= na ORDS:', erro instanceof Error ? erro.message : erro);
  console.log('O celular ainda pode usar PUBLIC_API_URL / EXPO_PUBLIC_API_URL.');
}
gravarPublicUrl(url);
console.log('\nAPI pública no ar. Feche pelo Parar-API.vbs ou deixe em segundo plano.\n');

// Mantém o processo pai vivo para não encerrar o filho do ngrok.
await new Promise(() => setInterval(() => undefined, 60_000));
