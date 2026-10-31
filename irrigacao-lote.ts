import { planejarImportacaoEquipamentos, listarEquipamentosIrrigacao } from './irrigacao.ts';
import { incluirParametrosFixos } from './irrigacao-parametros.ts';
import type { EquipamentoIrrigacao } from './irrigacao-types.ts';

export async function listarEquipamentosEmLote(entrada: unknown) {
  if (!Array.isArray(entrada) || entrada.length < 1 || entrada.length > 100) throw new Error('Informe entre 1 e 100 contextos de irrigação por lote.');
  const plano = await planejarImportacaoEquipamentos(entrada, true);
  const vinculos = new Map(plano.vinculos);
  const chave = (item: { codFazenda: number; codOperacao: number; data: string }) => {
    const vinculo = vinculos.get(JSON.stringify([item.codFazenda, item.codOperacao]));
    if (!vinculo) throw new Error('Contexto de irrigação não encontrado.');
    return JSON.stringify([vinculo.grupo, vinculo.empresa, vinculo.filial, item.data]);
  };
  const catalogos = new Map<string, EquipamentoIrrigacao[]>();
  for (const item of plano.contextos) {
    catalogos.set(chave(item), incluirParametrosFixos(await listarEquipamentosIrrigacao(item.codFazenda, item.codOperacao, item.data)));
  }
  return { versao: 1, contextos: entrada.map(item => ({ codFazenda: item.codFazenda, codOperacao: item.codOperacao, data: item.data, equipamentos: catalogos.get(chave(item)) })) };
}
