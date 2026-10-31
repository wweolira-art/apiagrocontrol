import type { EspacamentoIrrigacao, IndicadoresIrrigacao, InsumoIrrigacao, ParadaIrrigacao } from './irrigacao-types.ts';
import { minutosHorarioIrrigacao, validarInsumoIrrigacao, validarParadasIrrigacao } from './irrigacao-validacao.ts';
import { calcularDistanciasPorLamina, distribuirInsumosIrrigacao } from './irrigacao-periodos.ts';

export interface ConfigCalculoIrrigacao {
  modalidade: string;
  tempoLaminaBarra?: 'V' | 'H';
  ocultaPosicoesHidr?: boolean;
}

/** Mesmas fórmulas de AGRICOLA.FN_AREA_IRRIGADA/FN_LAMINA_IRRIGADA, verificadas em 25/10/2026. */
export function calcularIndicadoresIrrigacao(config: ConfigCalculoIrrigacao, insumo: InsumoIrrigacao,
  espacamento?: EspacamentoIrrigacao, paradas: ParadaIrrigacao[] = []): IndicadoresIrrigacao {
  if (insumo.laminaAutomaticaMmHa !== undefined) {
    const distanciasPeriodos = calcularDistanciasPorLamina(insumo, paradas, config.modalidade, config.tempoLaminaBarra);
    const { laminaAutomaticaMmHa: _lamina, ...base } = insumo;
    return calcularIndicadoresIrrigacao(config, { ...base, distanciasPeriodos, distancia: distanciasPeriodos.reduce((total, item) => total + item.distancia, 0) }, espacamento, paradas);
  }
  validarInsumoIrrigacao(insumo, config.modalidade);
  validarParadasIrrigacao(paradas);
  if (paradas.length || insumo.distanciasPeriodos !== undefined) {
    const itens = distribuirInsumosIrrigacao(insumo, paradas, config.modalidade);
    const resultados = itens.map(item => calcularIndicadoresIrrigacao(config, item, espacamento));
    const areaIrrigada = resultados.reduce((total, resultado) => total + resultado.areaIrrigada, 0);
    const m3Ha = resultados.reduce((total, resultado) => total + resultado.m3Ha * resultado.areaIrrigada, 0) / areaIrrigada;
    return { areaIrrigada, m3Ha, mmHa: m3Ha / 10,
      horasPeriodo: (minutosHorarioIrrigacao(insumo.horaTermino ?? '') - minutosHorarioIrrigacao(insumo.horaInicio ?? '')) / 60,
      horasConsideradas: resultados.reduce((total, resultado) => total + resultado.horasConsideradas, 0),
      horasParadas: paradas.reduce((total, parada) => total + (minutosHorarioIrrigacao(parada.termino) - minutosHorarioIrrigacao(parada.inicio)) / 60, 0) };
  }
  const inicio = minutosHorarioIrrigacao(insumo.horaInicio ?? ''), termino = minutosHorarioIrrigacao(insumo.horaTermino ?? '');
  if (termino <= inicio) throw new Error('Informe o início e término da irrigação no mesmo dia.');
  const horasPeriodo = (termino - inicio) / 60;
  const horasParadas = paradas.reduce((total, parada) => total + (minutosHorarioIrrigacao(parada.termino) - minutosHorarioIrrigacao(parada.inicio)) / 60, 0);
  const horasConsideradas = horasPeriodo - (['P', 'A'].includes(config.modalidade) ? 0 : horasParadas);
  let areaIrrigada: number, m3Ha: number;
  const comprimento = insumo.comprimento ?? 0;
  const posicoes = insumo.posicoes ?? 0;
  if (['A', 'H'].includes(config.modalidade)) {
    if (!espacamento || espacamento.codigo !== insumo.codEspacamento ||
        !Number.isFinite(espacamento.qtdeTubosPrimarios) || espacamento.qtdeTubosPrimarios <= 0 ||
        !Number.isFinite(espacamento.qtdeTubosSecundarios) || espacamento.qtdeTubosSecundarios < 0 ||
        !Number.isFinite(espacamento.comprimento) || espacamento.comprimento <= 0) throw new Error('Importe e selecione um espaçamento válido para calcular os indicadores.');
    const largura = espacamento.qtdeTubosPrimarios * espacamento.comprimento;
    if (config.modalidade === 'A') {
      const areaTubos = largura * espacamento.qtdeTubosSecundarios * espacamento.comprimento;
      if (areaTubos <= 0) throw new Error('O espaçamento precisa informar os tubos secundários.');
      areaIrrigada = areaTubos / 10000 * posicoes * (insumo.qtdeAspersores ?? 0);
      m3Ha = horasConsideradas * insumo.vazao * 10000 / areaTubos / posicoes;
    } else {
      if (typeof config.ocultaPosicoesHidr !== 'boolean') throw new Error('Atualize os equipamentos para carregar a configuração de posições do ERP.');
      const areaBase = largura * comprimento / 10000;
      areaIrrigada = areaBase * (config.ocultaPosicoesHidr ? 1 : posicoes);
      m3Ha = comprimento / (insumo.velocidade ?? 0) * insumo.vazao / areaBase;
    }
  } else if (config.modalidade === 'B') {
    if (!['V', 'H'].includes(config.tempoLaminaBarra ?? '')) throw new Error('Atualize os equipamentos para carregar o critério de tempo do ERP.');
    areaIrrigada = comprimento * (insumo.distancia ?? 0) / 10000;
    const horasLamina = config.tempoLaminaBarra === 'V' ? (insumo.distancia ?? 0) / (insumo.velocidade ?? 0) : horasConsideradas;
    m3Ha = horasLamina * insumo.vazao / areaIrrigada;
  } else if (config.modalidade === 'P') {
    // A função do ERP usa 3.1415 e inclui horas somente no cálculo da área, não na lâmina.
    const areaHora = comprimento * comprimento * 3.1415 / 10000 / 360 * (insumo.deslocamento ?? 0);
    areaIrrigada = areaHora * horasConsideradas;
    m3Ha = insumo.vazao / areaHora;
  } else throw new Error('Cálculo ainda não disponível para esta modalidade de irrigação.');
  if (![areaIrrigada, m3Ha].every(valor => Number.isFinite(valor) && valor >= 0) || areaIrrigada <= 0) throw new Error('Confira os parâmetros do equipamento para calcular a irrigação.');
  return { areaIrrigada, m3Ha, mmHa: m3Ha / 10, horasPeriodo, horasParadas, horasConsideradas };
}
