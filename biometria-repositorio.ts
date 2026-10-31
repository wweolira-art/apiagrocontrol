import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type Usuario = { idUsuario: number; nome: string; perfil: string };
export class ErroBiometriaLocal extends Error {
  status: number;
  constructor(status: number, mensagem: string) { super(mensagem); this.status = status; }
}
function dataIso(valor: unknown): string {
  if (typeof valor !== 'string') throw new ErroBiometriaLocal(400, 'Informe a data da biometria.');
  const texto = valor.trim();
  const iso = /^\d{2}\/\d{2}\/\d{4}$/.test(texto) ? texto.split('/').reverse().join('-') : texto;
  const data = new Date(iso+'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(data.getTime()) || data.toISOString().slice(0,10)!==iso) throw new ErroBiometriaLocal(400, 'Data biométrica inválida.');
  return iso;
}
function codigo(valor: unknown, campo: string): number {
  const n = typeof valor === 'number' || typeof valor === 'string' && valor.trim() ? Number(valor) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ErroBiometriaLocal(400, `Código inválido: ${campo}.`);
  return n;
}
function motivos(valor: unknown): number[] {
  if (valor === undefined) return [];
  if (!Array.isArray(valor) || valor.length > 100) throw new ErroBiometriaLocal(400, 'Lista de motivos inválida.');
  return [...new Set(valor.map(x=>codigo(x,'motivo TCH')))].sort((a,b)=>a-b);
}
function texto(valor: unknown, campo: string, maximo: number): string {
  if (typeof valor !== 'string' || !valor.trim() || valor.trim().length > maximo) throw new ErroBiometriaLocal(400, `${campo} inválida.`);
  return valor.trim();
}
export function abrirRepositorioBiometria(arquivo: string) {
  // Nunca cria um banco vazio em um caminho errado ou silenciosamente grava em outro projeto.
  if (arquivo !== ':memory:' && (!fs.existsSync(arquivo) || !fs.statSync(arquivo).isFile())) throw new ErroBiometriaLocal(503, 'Banco do ControleAgricola não encontrado. Configure CONTROLE_AGRICOLA_DB_PATH na API.');
  const db = new DatabaseSync(arquivo, { timeout: 5000 });
  try {
    for (const tabela of ['analise_biometrica_itens','analise_biometrica_lancamentos']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tabela)) throw new ErroBiometriaLocal(503, 'Inicialize o ControleAgricola e importe os cadastros biométricos antes de receber lançamentos.');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const colunas = new Set(db.prepare('PRAGMA table_info(analise_biometrica_lancamentos)').all().map(x=>x.name));
      if (!colunas.has('usuario')) db.exec("ALTER TABLE analise_biometrica_lancamentos ADD COLUMN usuario TEXT NOT NULL DEFAULT ''");
      if (!colunas.has('created_by_user_id')) db.exec('ALTER TABLE analise_biometrica_lancamentos ADD COLUMN created_by_user_id INTEGER');
      if (!colunas.has('qtd_colmos')) db.exec('ALTER TABLE analise_biometrica_lancamentos ADD COLUMN qtd_colmos REAL');
      db.exec(`CREATE TABLE IF NOT EXISTS analise_biometrica_motivos (
        collected_at TEXT NOT NULL, farm_code TEXT NOT NULL, field_code TEXT NOT NULL,
        motive_code INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(collected_at,farm_code,field_code,motive_code));
        CREATE TABLE IF NOT EXISTS analise_biometrica_envios (
        id_envio TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, registro_id INTEGER NOT NULL, created_at TEXT NOT NULL);`);
      db.exec('COMMIT');
    } catch (erro) { db.exec('ROLLBACK'); throw erro; }
  } catch (erro) { db.close(); throw erro; }
  const linhaPublica = (row: Record<string, unknown>) => ({id:Number(row.id),data:row.data_label,cod_ponto:Number(row.point_code),cod_item:Number(row.item_code),cod_fazenda:Number(row.farm_code),cod_talhao:Number(row.field_code),variedade:row.variety,valor:Number(row.value),usuario:row.usuario,qtd_colmos:row.qtd_colmos,
    links:[{rel:'self',href:`/api/biometria/lancamentos/${row.id}`}],origem:'controle-agricola-local'});
  const idLinha = (id: number) => db.prepare('SELECT * FROM analise_biometrica_lancamentos WHERE id=?').get(id);
  return {
    fechar:()=>db.close(),
    listar() {return db.prepare('SELECT * FROM analise_biometrica_lancamentos ORDER BY collected_at,id').all().map(linhaPublica);},
    motivos(filtro: {data?:string;codFazenda?:string;codTalhao?:string}={}) {
      const where:string[]=[], binds:(string|number)[]=[];
      if(filtro.data){where.push('collected_at=?');binds.push(dataIso(filtro.data));}
      if(filtro.codFazenda){where.push('farm_code=?');binds.push(String(codigo(filtro.codFazenda,'fazenda')));}
      if(filtro.codTalhao){where.push('field_code=?');binds.push(String(codigo(filtro.codTalhao,'talhão')));}
      return db.prepare(`SELECT * FROM analise_biometrica_motivos${where.length?' WHERE '+where.join(' AND '):''} ORDER BY collected_at,motive_code`).all(...binds).map(row=>({data:String(row.collected_at).split('-').reverse().join('/'),codFazenda:Number(row.farm_code),codTalhao:Number(row.field_code),codigosMotivoTch:[Number(row.motive_code)]}));
    },
    gravar(entradas: unknown, usuario: Usuario) {
      if (!Array.isArray(entradas) || !entradas.length || entradas.length > 100) throw new ErroBiometriaLocal(400, 'Envie entre 1 e 100 itens biométricos.');
      const normalizadas = entradas.map(entrada=>{
        if(!entrada||typeof entrada!=='object')throw new ErroBiometriaLocal(400,'Item inválido.');
        const valor=typeof entrada.valor==='number'?entrada.valor:NaN;
        if(!Number.isFinite(valor)||valor<0)throw new ErroBiometriaLocal(400,'Valor biométrico inválido.');
        const item={data:dataIso(entrada.data),codPonto:codigo(entrada.codPonto,'ponto'),codItem:codigo(entrada.codItem,'item'),codFazenda:codigo(entrada.codFazenda,'fazenda'),codTalhao:codigo(entrada.codTalhao,'talhão'),variedade:texto(entrada.variedade,'Variedade',200),valor,codigosMotivoTch:motivos(entrada.codigosMotivoTch),usuario:usuario.nome,idUsuario:usuario.idUsuario,
          qtdColmos:entrada.qtdColmos==null?null:Number(entrada.qtdColmos)};
        if(item.qtdColmos!==null&&(!Number.isFinite(item.qtdColmos)||item.qtdColmos<0))throw new ErroBiometriaLocal(400,'Quantidade de colmos inválida.');
        if(!db.prepare('SELECT 1 FROM analise_biometrica_itens WHERE code=?').get(item.codItem))throw new ErroBiometriaLocal(400,`Item ${item.codItem} ausente do cadastro local do ControleAgricola.`);
        const hash=createHash('sha256').update(JSON.stringify(item)).digest('hex');
        const idEnvio=entrada.idEnvio===undefined?`conteudo:${hash}`:texto(entrada.idEnvio,'Identificação do envio',200);
        return {item,hash,idEnvio};
      });
      db.exec('BEGIN IMMEDIATE');
      try {
        const resultado=[];
        for(const {item,hash,idEnvio} of normalizadas){
          const recibo=db.prepare('SELECT * FROM analise_biometrica_envios WHERE id_envio=?').get(idEnvio);
          if(recibo){
            if(recibo.payload_hash!==hash)throw new ErroBiometriaLocal(409,'Esse envio já foi confirmado com outros dados. Não altere um apontamento enviado.');
            const row=idLinha(Number(recibo.registro_id));
            if(!row)throw new ErroBiometriaLocal(409,'Este apontamento já foi excluído do banco local.');
            resultado.push(linhaPublica(row));continue;
          }
          const agora=new Date().toISOString();
          const args=[item.data,item.data.split('-').reverse().join('/'),String(item.codPonto),item.codItem,String(item.codFazenda),String(item.codTalhao),item.variedade,item.valor,agora,item.usuario,item.idUsuario,item.qtdColmos];
          db.prepare(`INSERT OR IGNORE INTO analise_biometrica_lancamentos (collected_at,data_label,point_code,item_code,farm_code,field_code,variety,value,updated_at,usuario,created_by_user_id,qtd_colmos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...args);
          const row=db.prepare('SELECT * FROM analise_biometrica_lancamentos WHERE collected_at=? AND point_code=? AND item_code=? AND farm_code=? AND field_code=? AND variety=? AND value=?').get(item.data,String(item.codPonto),item.codItem,String(item.codFazenda),String(item.codTalhao),item.variedade,item.valor);
          if(!row)throw new Error('Não foi possível confirmar o lançamento local.');
          for(const motivo of item.codigosMotivoTch)db.prepare('INSERT OR IGNORE INTO analise_biometrica_motivos (collected_at,farm_code,field_code,motive_code,updated_at) VALUES (?,?,?,?,?)').run(item.data,String(item.codFazenda),String(item.codTalhao),motivo,agora);
          db.prepare('INSERT INTO analise_biometrica_envios (id_envio,payload_hash,registro_id,created_at) VALUES (?,?,?,?)').run(idEnvio,hash,Number(row.id),agora);
          resultado.push(linhaPublica(row));
        }
        db.exec('COMMIT');return resultado;
      }catch(erro){db.exec('ROLLBACK');throw erro;}
    },
    excluir(id:number,usuario:Usuario){
      const item=idLinha(id);if(!item)throw new ErroBiometriaLocal(404,'Lançamento local não encontrado.');
      if(usuario.perfil!=='admin'&&Number(item.created_by_user_id)!==usuario.idUsuario)throw new ErroBiometriaLocal(403,'Somente o autor ou administrador pode excluir este lançamento.');
      db.prepare('DELETE FROM analise_biometrica_lancamentos WHERE id=?').run(id);
    },
  };
}
