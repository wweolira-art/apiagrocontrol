import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import type { EquipamentoIrrigacao, IrrigacaoEntrada } from './irrigacao-types.ts';

function lerParametros(): Map<number, { vazao: number; comprimento: number }> {
  const caminho = process.env.CONTROLE_AGRICOLA_DB_PATH?.trim();
  if (!caminho || !existsSync(caminho)) throw new Error('Configure CONTROLE_AGRICOLA_DB_PATH com o banco existente do ControleAgricola para importar os parâmetros de irrigação.');
  const db = new DatabaseSync(caminho, { readOnly: true });
  try {
    const registros = db.prepare('SELECT codigo, vazao, comprimento FROM irrigacao_equipamentos_parametros').all();
    const mapa = new Map<number, { vazao: number; comprimento: number }>();
    for (const item of registros) {
      const codigo = Number(item.codigo), vazao = Number(item.vazao), comprimento = Number(item.comprimento);
      if (!Number.isSafeInteger(codigo) || !(vazao > 0) || !Number.isFinite(vazao) || !(comprimento > 0) || !Number.isFinite(comprimento)) throw new Error('Parâmetros de irrigação inválidos no ControleAgricola.');
      mapa.set(codigo, { vazao, comprimento });
    }
    for (let codigo = 8001; codigo <= 8008; codigo++) if (!mapa.has(codigo)) throw new Error(`Cadastre os parâmetros do equipamento ${codigo} no ControleAgricola.`);
    return mapa;
  } finally { db.close(); }
}
export function incluirParametrosFixos<T extends EquipamentoIrrigacao | EquipamentoIrrigacao[] | null>(dados: T): T {
  if (!dados || (Array.isArray(dados) && !dados.length)) return dados;
  const mapa = lerParametros();
  const incluir = (item: EquipamentoIrrigacao) => ({ ...item, parametrosFixos: mapa.get(item.codigo) });
  return (Array.isArray(dados) ? dados.map(incluir) : incluir(dados)) as T;
}
export function validarParametrosFixos(entrada: IrrigacaoEntrada): IrrigacaoEntrada {
  if (entrada.apenasParadas || !entrada.insumo) return entrada;
  const fixos = lerParametros().get(entrada.codEquipamento);
  if (fixos && (entrada.insumo.vazao !== fixos.vazao || entrada.insumo.comprimento !== fixos.comprimento)) {
    throw new Error('Vazão ou comprimento diferentes do cadastro fixo. Atualize os equipamentos e revise o apontamento antes de enviar.');
  }
  return entrada;
}
