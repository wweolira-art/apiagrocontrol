import path from 'node:path';
import {abrirRepositorioBiometria,ErroBiometriaLocal} from './biometria-repositorio.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
type Usuario={idUsuario:number;nome:string;perfil:string};
const usuarios=new WeakMap<IncomingMessage,Usuario>();
export function registrarUsuarioBiometria(req:IncomingMessage,usuario:Usuario):void{usuarios.set(req,usuario);}
class ErroEncaminhamento extends Error {status:number;constructor(status:number,mensagem:string){super(mensagem);this.status=status;}}
function configuracao(){
  const endereco=process.env.CONTROLE_AGRICOLA_URL?.trim();const token=process.env.CONTROLE_AGRICOLA_INTEGRACAO_TOKEN?.trim();
  if(!endereco||!token||token.length<32)throw new ErroEncaminhamento(503,'Configure CONTROLE_AGRICOLA_URL e CONTROLE_AGRICOLA_INTEGRACAO_TOKEN no .env da API.');
  let url:URL;try{url=new URL(endereco);}catch{throw new ErroEncaminhamento(503,'Endereço do ControleAgricola inválido. Informe a URL de rede, por exemplo http://IP-DO-PC:5173.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ErroEncaminhamento(503,'URL do ControleAgricola inválida.');
  const caminho=url.pathname.replace(/\/$/,'');
  if(caminho&&caminho!=='/api/integracoes/agrocontrol/biometria')throw new ErroEncaminhamento(503,'Configure a URL base do ControleAgricola sem caminho de página.');
  url.pathname='/api/integracoes/agrocontrol/biometria';return {url,token};
}
const bancos=new Map<string,ReturnType<typeof abrirRepositorioBiometria>>();
export function fecharRepositoriosBiometria():void{for(const banco of bancos.values())banco.fechar();bancos.clear();}
function bancoArquivo(serverDir:string){
  const configurado=process.env.CONTROLE_AGRICOLA_DB_PATH?.trim();
  if(!configurado)throw new ErroEncaminhamento(503,'Configure CONTROLE_AGRICOLA_DB_PATH com o arquivo do ControleAgricola no computador da API.');
  const arquivo=path.resolve(serverDir,configurado);
  let banco=bancos.get(arquivo);if(!banco){banco=abrirRepositorioBiometria(arquivo);bancos.set(arquivo,banco);}return banco;
}
async function corpo(req:IncomingMessage){let tamanho=0;const partes:Buffer[]=[];for await(const parte of req){const b=Buffer.isBuffer(parte)?parte:Buffer.from(parte);tamanho+=b.length;if(tamanho>262144)throw new ErroEncaminhamento(413,'Lote biométrico muito grande.');partes.push(b);}try{return JSON.parse(Buffer.concat(partes).toString('utf8'));}catch{throw new ErroEncaminhamento(400,'JSON biométrico inválido.');}}
/** Usa o arquivo explicitamente configurado; HTTP só é usado quando selecionado no .env. */
export async function atenderBiometriaLocal(req:IncomingMessage,res:ServerResponse,url:URL,serverDir:string):Promise<boolean>{
  if(!url.pathname.startsWith('/api/biometria/'))return false;
  const json=(status:number,dados:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(dados));};
  try{
    const usuario=usuarios.get(req);if(!usuario)throw new ErroEncaminhamento(401,'Entre novamente no aplicativo.');
    const rota=url.pathname.slice('/api/biometria'.length);
    const valida=rota==='/lancamentos'&&['GET','POST'].includes(req.method??'')||rota==='/motivos-talhao'&&req.method==='GET'||/^\/lancamentos\/\d+$/.test(rota)&&req.method==='DELETE';
    if(!valida)throw new ErroEncaminhamento(404,'Rota biométrica não encontrada.');
    const transporte=process.env.CONTROLE_AGRICOLA_TRANSPORTE?.trim() || (process.env.CONTROLE_AGRICOLA_DB_PATH?.trim()?'arquivo':'http');
    if(transporte==='arquivo'){
      const banco=bancoArquivo(serverDir);
      if(rota==='/lancamentos'&&req.method==='POST'){const dados=await corpo(req);json(200,banco.gravar(dados?.entradas,usuario));}
      else if(rota==='/lancamentos'&&req.method==='GET')json(200,banco.listar());
      else if(rota==='/motivos-talhao')json(200,banco.motivos({data:url.searchParams.get('data')??undefined,codFazenda:url.searchParams.get('codFazenda')??undefined,codTalhao:url.searchParams.get('codTalhao')??undefined}));
      else{banco.excluir(Number(rota.split('/').at(-1)),usuario);json(200,{ok:true});}
      return true;
    }
    if(transporte!=='http')throw new ErroEncaminhamento(503,'CONTROLE_AGRICOLA_TRANSPORTE deve ser arquivo ou http.');
    const cfg=configuracao();const destino=new URL(cfg.url.href+rota);destino.search=url.search;
    const dados=req.method==='POST'?await corpo(req):undefined;
    let resposta:Response;
    try{resposta=await fetch(destino,{method:req.method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${cfg.token}`,'X-AgroControl-Actor':Buffer.from(JSON.stringify(usuario)).toString('base64url')},...(dados===undefined?{}:{body:JSON.stringify(dados)}),signal:AbortSignal.timeout(30000),redirect:'error'});}
    catch{throw new ErroEncaminhamento(502,'Não foi possível alcançar o ControleAgricola. Confira o endereço de rede, a porta 5173 e se o projeto está aberto. O apontamento deve permanecer no aparelho.');}
    let resultado:unknown;try{resultado=await resposta.json();}catch{throw new ErroEncaminhamento(502,'O endereço configurado não respondeu como API do ControleAgricola.');}
    if([401,403].includes(resposta.status))throw new ErroEncaminhamento(502,'A integração com o ControleAgricola foi recusada. Confira se a chave configurada nos dois dispositivos é a mesma.');
    if(resposta.status>=300&&resposta.status<400)throw new ErroEncaminhamento(502,'O endereço do ControleAgricola redirecionou a requisição. Confira a URL configurada.');
    json(resposta.status,resultado);
  }catch(erro){json(erro instanceof ErroEncaminhamento || erro instanceof ErroBiometriaLocal?erro.status:500,{mensagem:erro instanceof Error?erro.message:'Falha ao encaminhar a biometria. Os registros foram preservados no aparelho.'});}
  return true;
}
