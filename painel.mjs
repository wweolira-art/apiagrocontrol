import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

import {
  ARQUIVO_LOG,
  ARQUIVO_PID,
  PASTA,
  PASTA_LOGS,
  configAtual,
  gravarConfig,
} from './env-arquivo.mjs';

const PAINEL_PORTA = Number(process.env.PAINEL_PORTA ?? 3099);

function apiRodando() {
  if (!fs.existsSync(ARQUIVO_PID)) {
    return false;
  }
  const pid = Number(fs.readFileSync(ARQUIVO_PID, 'utf8').trim());
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '').includes(String(pid));
}

function html(cfg, aviso = '', erro = '') {
  const ok = aviso ? `<p class="ok">${aviso}</p>` : '';
  const falha = erro ? `<p class="erro">${erro}</p>` : '';
  const status = apiRodando()
    ? '<span class="badge on">API em segundo plano</span>'
    : '<span class="badge off">API parada</span>';
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgroControl API</title>
  <style>
    body { font-family: Segoe UI, sans-serif; background: #F4F1EA; color: #1A1A1A; margin: 0; }
    main { max-width: 640px; margin: 0 auto; padding: 28px 20px 48px; }
    h1 { color: #0F2E22; margin: 0 0 8px; }
    .sub { color: #5C6B63; margin-bottom: 20px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-weight: 700; font-size: 12px; }
    .on { background: #E8F5E9; color: #2E7D32; }
    .off { background: #E8E2D4; color: #5C6B63; }
    form, .acoes { background: #fff; border: 1px solid #E8E2D4; border-radius: 12px; padding: 18px; margin-top: 16px; }
    label { display: block; font-weight: 700; color: #0F2E22; margin: 12px 0 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #E8E2D4; border-radius: 8px; font-size: 15px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .check { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-weight: 600; }
    .check input { width: auto; }
    button { border: 0; border-radius: 10px; padding: 12px 16px; font-weight: 800; cursor: pointer; margin-right: 8px; margin-top: 8px; }
    .pri { background: #1B5E3B; color: #fff; }
    .sec { background: #C4A35A; color: #0F2E22; }
    .ghost { background: #E8E2D4; color: #0F2E22; }
    .ok { color: #2E7D32; font-weight: 700; }
    .erro { color: #C62828; font-weight: 700; }
    .hint { color: #5C6B63; font-size: 12px; margin-top: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>AgroControl API</h1>
    <p class="sub">Configuração do .env · ${status}</p>
    ${ok}${falha}
    <form method="post" action="/salvar">
      <label>Usuário Oracle</label>
      <input name="usuario" value="${esc(cfg.usuario)}" autocomplete="username" />

      <label>Senha Oracle</label>
      <input name="senha" type="password" value="${esc(cfg.senha)}" autocomplete="current-password" />
      <p class="hint">CONSULTA: leitura. Não usa login da ORDS.</p>

      <label>Usuário de gravação (INSERT)</label>
      <input name="usuarioGravacao" value="${esc(cfg.usuarioGravacao)}" />
      <label>Senha de gravação</label>
      <input name="senhaGravacao" type="password" value="${esc(cfg.senhaGravacao)}" />
      <p class="hint">Apontamento. A API não pede autenticação HTTP.</p>

      <label>Usuário perdas da colheita</label>
      <input name="usuarioPerdas" value="${esc(cfg.usuarioPerdas)}" />
      <label>Senha perdas da colheita</label>
      <input name="senhaPerdas" type="password" value="${esc(cfg.senhaPerdas)}" />
      <p class="hint">Usado somente no envio de perdas. Se deixar vazio, usa o usuário de gravação.</p>

      <label>Host do ngrok (Oracle TCP)</label>
      <input name="hostNgrok" value="${esc(cfg.hostNgrok)}" />
      <p class="hint">Ex.: 0.tcp.sa.ngrok.io</p>

      <div class="grid">
        <div>
          <label>Porta do ngrok (túnel Oracle)</label>
          <input name="portaNgrok" value="${esc(cfg.portaNgrok)}" />
          <p class="hint">A porta que muda quando o túnel TCP sobe de novo.</p>
        </div>
        <div>
          <label>Serviço Oracle</label>
          <input name="servico" value="${esc(cfg.servico)}" />
        </div>
      </div>

      <div class="grid">
        <div>
          <label>Porta do agente ngrok</label>
          <input name="portaAgenteNgrok" value="${esc(cfg.portaAgenteNgrok)}" />
          <p class="hint">API local do ngrok, em geral 4040.</p>
        </div>
        <div>
          <label>Porta da API</label>
          <input name="portaApi" value="${esc(cfg.portaApi)}" />
        </div>
      </div>

      <label>Instant Client</label>
      <input name="instantClient" value="${esc(cfg.instantClient)}" />

      <label>ORDS conexao_banco</label>
      <input name="ordsUrl" value="${esc(cfg.ordsUrl)}" />
      <p class="hint">A nuvem pede autenticação (401). Use o usuário/senha da ORDS que você já tem.</p>

      <div class="grid">
        <div>
          <label>Usuário ORDS</label>
          <input name="ordsUser" value="${esc(cfg.ordsUser)}" autocomplete="off" />
        </div>
        <div>
          <label>Senha ORDS</label>
          <input name="ordsPassword" type="password" value="${esc(cfg.ordsPassword)}" autocomplete="off" />
        </div>
      </div>

      <label>Authtoken ngrok</label>
      <input name="ngrokAuthtoken" type="password" value="${esc(cfg.ngrokAuthtoken)}" autocomplete="off" />
      <p class="hint">Token da conta que reservou o domínio HTTPS (dashboard.ngrok.com). Sem isso a URL antiga não sobe neste PC.</p>

      <label class="check"><input type="checkbox" name="useOracle" ${cfg.useOracle ? 'checked' : ''} /> Usar Oracle na localização</label>
      <label class="check"><input type="checkbox" name="thick" ${cfg.thick ? 'checked' : ''} /> Modo Thick (Instant Client)</label>

      <button class="pri" type="submit">Salvar configurações</button>
    </form>
    <div class="acoes">
      <form method="post" action="/iniciar" style="display:inline">${cfg.publicUrl ? `<p class="hint">Última URL pública: ${esc(cfg.publicUrl)}</p>` : ''}
        <button class="sec" type="submit">Iniciar em segundo plano</button>
      </form>
      <form method="post" action="/parar" style="display:inline">
        <button class="ghost" type="submit">Parar API</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function esc(texto) {
  return String(texto ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function corpoForm(req) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    req.on('data', (p) => pedacos.push(p));
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos).toString('utf8');
      resolve(Object.fromEntries(new URLSearchParams(bruto)));
    });
    req.on('error', reject);
  });
}

function redirecionar(res, aviso, erro) {
  const q = new URLSearchParams();
  if (aviso) q.set('ok', aviso);
  if (erro) q.set('erro', erro);
  res.writeHead(303, { Location: `/?${q.toString()}` });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PAINEL_PORTA}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html(configAtual(), url.searchParams.get('ok') ?? '', url.searchParams.get('erro') ?? ''));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/salvar') {
    try {
      const body = await corpoForm(req);
      gravarConfig({
        usuario: body.usuario,
        senha: body.senha,
        usuarioGravacao: body.usuarioGravacao,
        senhaGravacao: body.senhaGravacao,
        usuarioPerdas: body.usuarioPerdas,
        senhaPerdas: body.senhaPerdas,
        hostNgrok: body.hostNgrok,
        portaNgrok: body.portaNgrok,
        servico: body.servico,
        portaAgenteNgrok: body.portaAgenteNgrok,
        portaApi: body.portaApi,
        instantClient: body.instantClient,
        ordsUrl: body.ordsUrl,
        ordsUser: body.ordsUser,
        ordsPassword: body.ordsPassword,
        ngrokAuthtoken: body.ngrokAuthtoken,
        useOracle: body.useOracle === 'on',
        thick: body.thick === 'on',
      });
      redirecionar(res, 'Configurações gravadas no .env.');
    } catch (erro) {
      redirecionar(res, '', erro instanceof Error ? erro.message : 'Falha ao gravar.');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/iniciar') {
    try {
      spawn(process.execPath, ['iniciar.mjs'], { cwd: PASTA, windowsHide: true, stdio: 'ignore', detached: true }).unref();
      redirecionar(res, 'API iniciada em segundo plano. Veja logs/api-public.log se precisar.');
    } catch (erro) {
      redirecionar(res, '', erro instanceof Error ? erro.message : 'Falha ao iniciar.');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/parar') {
    spawnSync(process.execPath, ['parar.mjs'], { cwd: PASTA, windowsHide: true, stdio: 'ignore' });
    redirecionar(res, 'API parada.');
    return;
  }

  res.writeHead(404);
  res.end('Não encontrado');
});

fs.mkdirSync(PASTA_LOGS, { recursive: true });
void ARQUIVO_LOG;

server.listen(PAINEL_PORTA, '127.0.0.1', () => {
  const endereco = `http://127.0.0.1:${PAINEL_PORTA}`;
  console.log(`Painel AgroControl API em ${endereco}`);
  spawn('cmd', ['/c', 'start', '', endereco], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
});
