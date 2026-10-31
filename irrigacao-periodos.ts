import { minutosHorarioIrrigacao, validarInsumoIrrigacao, validarParadasIrrigacao } from './irrigacao-validacao.ts';
import type { InsumoIrrigacao, ParadaIrrigacao } from './irrigacao-types.ts';

export interface PeriodoIrrigacao { inicio: string; termino: string }

export function calcularDistanciasPorLamina(insumo: InsumoIrrigacao, paradas: ParadaIrrigacao[], modalidade: string, criterio?: string): NonNullable<InsumoIrrigacao['distanciasPeriodos']> {
  if (modalidade !== 'B' || criterio !== 'H') throw new Error('O cálculo automático da distância pela lâmina não está disponível para este equipamento.');
  const lamina = insumo.laminaAutomaticaMmHa;
  if (!Number.isFinite(lamina) || Number(lamina) <= 0) throw new Error('Informe a lâmina desejada em mm/ha, maior que zero.');
  if (!Number.isFinite(insumo.vazao) || insumo.vazao <= 0 || !Number.isFinite(insumo.comprimento) || Number(insumo.comprimento) <= 0) throw new Error('Informe vazão e comprimento maiores que zero para calcular a distância.');
  const periodos = distribuirPeriodosIrrigacao(insumo.horaInicio ?? '', insumo.horaTermino ?? '', paradas);
  if (!periodos.length) throw new Error('As paradas cobrem todo o período. Selecione Informar apenas paradas.');
  return periodos.map(periodo => {
    const horas = (minutosHorarioIrrigacao(periodo.termino) - minutosHorarioIrrigacao(periodo.inicio)) / 60;
    // mm/ha = horas × vazão / (comprimento × distância / 10000) / 10.
    const distancia = Math.round(horas * insumo.vazao * 1000 / (Number(insumo.comprimento) * Number(lamina)));
    if (!Number.isSafeInteger(distancia) || distancia < 1 || distancia > 9999) throw new Error(`Distância calculada para ${periodo.inicio}–${periodo.termino} fora de 1 a 9999 metros. Confira a lâmina, a vazão, o comprimento e os horários.`);
    return { ...periodo, distancia };
  });
}

function horario(minutos: number): string {
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

function repartirInteiro(total: number, pesos: number[]): number[] {
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Informe uma quantidade inteira para distribuir comprimento, distância, posições ou aspersores entre os períodos.');
  const soma = pesos.reduce((a, b) => a + b, 0);
  const ideais = pesos.map(peso => total * peso / soma);
  const valores = ideais.map(Math.floor);
  const ordem = ideais.map((valor, indice) => ({ indice, resto: valor - valores[indice] })).sort((a, b) => b.resto - a.resto || a.indice - b.indice);
  for (let i = 0, restantes = total - valores.reduce((a, b) => a + b, 0); i < restantes; i++) valores[ordem[i].indice]++;
  if (valores.some(valor => valor <= 0)) throw new Error('A divisão dos períodos exige quantidades inteiras maiores que zero. Confira comprimento, distância, posições ou aspersores informados.');
  return valores;
}

export function distribuirInsumosIrrigacao(insumo: InsumoIrrigacao, paradas: ParadaIrrigacao[], modalidade: string): InsumoIrrigacao[] {
  validarInsumoIrrigacao(insumo, modalidade);
  const periodos = distribuirPeriodosIrrigacao(insumo.horaInicio ?? '', insumo.horaTermino ?? '', paradas);
  if (!periodos.length) throw new Error('As paradas cobrem todo o período. Selecione Informar apenas paradas.');
  const manuais = insumo.distanciasPeriodos;
  if (manuais) {
    if (modalidade !== 'B') throw new Error('Distâncias por período são válidas apenas para irrigação em barra.');
    const chaves = manuais.map(item => `${item.inicio}-${item.termino}`);
    if (manuais.length !== periodos.length || new Set(chaves).size !== chaves.length || periodos.some(periodo => !chaves.includes(`${periodo.inicio}-${periodo.termino}`))) {
      throw new Error('Os horários foram alterados. Confira a distância de cada período distribuído antes de salvar ou enviar.');
    }
  }
  const pesos = periodos.map(periodo => minutosHorarioIrrigacao(periodo.termino) - minutosHorarioIrrigacao(periodo.inicio));
  const campo = modalidade === 'H' ? 'comprimento' : modalidade === 'B' ? 'distancia' : modalidade === 'A'
    ? ((insumo.posicoes ?? 0) >= periodos.length ? 'posicoes' : 'qtdeAspersores') : null;
  // Os campos geométricos são NUMBER(...,0) no ERP; conserva o total por maior resto.
  const valores = !manuais && campo && periodos.length > 1 ? repartirInteiro(Number(insumo[campo]), pesos) : null;
  const { distanciasPeriodos: _distancias, laminaAutomaticaMmHa: _lamina, ...parametros } = insumo;
  return periodos.map((periodo, indice) => {
    const item = { ...parametros, horaInicio: periodo.inicio, horaTermino: periodo.termino };
    if (campo && valores) item[campo] = valores[indice];
    if (manuais) item.distancia = manuais.find(valor => valor.inicio === periodo.inicio && valor.termino === periodo.termino)!.distancia;
    validarInsumoIrrigacao(item, modalidade);
    return item;
  });
}

/** Encerra um minuto antes da parada e retoma um minuto após seu término. */
export function distribuirPeriodosIrrigacao(inicio: string, termino: string, paradas: ParadaIrrigacao[] = []): PeriodoIrrigacao[] {
  const primeiro = minutosHorarioIrrigacao(inicio), ultimo = minutosHorarioIrrigacao(termino);
  if (ultimo <= primeiro) throw new Error('O término da irrigação deve ser posterior ao início, no mesmo dia.');
  validarParadasIrrigacao(paradas);
  const intervalos = paradas.map(parada => ({ inicio: minutosHorarioIrrigacao(parada.inicio), termino: minutosHorarioIrrigacao(parada.termino) }))
    .filter(parada => parada.termino >= primeiro && parada.inicio <= ultimo).sort((a, b) => a.inicio - b.inicio);
  const periodos: PeriodoIrrigacao[] = [];
  let cursor = primeiro;
  for (const parada of intervalos) {
    const fim = Math.min(parada.inicio - 1, ultimo);
    if (fim > cursor) periodos.push({ inicio: horario(cursor), termino: horario(fim) });
    cursor = Math.max(cursor, parada.termino + 1);
  }
  if (cursor < ultimo) periodos.push({ inicio: horario(cursor), termino: horario(ultimo) });
  return periodos;
}
