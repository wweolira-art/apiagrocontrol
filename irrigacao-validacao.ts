import type { InsumoIrrigacao, ParadaIrrigacao } from './irrigacao-types.ts';

export function minutosHorarioIrrigacao(valor: string): number {
    if (typeof valor !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(valor)) throw new Error('Informe os horários em HH:MM.');
    const [horas, minutos] = valor.split(':').map(Number);
    return horas * 60 + minutos;
}

export function validarParadasIrrigacao(paradas: ParadaIrrigacao[] | undefined): void {
  if (paradas === undefined) return;
  if (!Array.isArray(paradas) || paradas.length > 100) throw new Error('Informe uma lista válida de até 100 paradas.');
  const intervalos = paradas.map(parada => {
    if (!parada || !Number.isSafeInteger(parada.codMotivo) || parada.codMotivo <= 0) throw new Error('Informe o código do motivo da parada.');
    const inicio = minutosHorarioIrrigacao(parada.inicio), termino = minutosHorarioIrrigacao(parada.termino);
    if (termino <= inicio) throw new Error('O término da parada deve ser posterior ao início, no mesmo dia.');
    return { inicio, termino };
  }).sort((a, b) => a.inicio - b.inicio);
  for (let i = 1; i < intervalos.length; i++) {
    if (intervalos[i].inicio < intervalos[i - 1].termino) throw new Error('Os horários das paradas do equipamento não podem se sobrepor.');
  }
}

export function validarInsumoIrrigacao(insumo: InsumoIrrigacao | undefined, modalidade?: string): void {
  if (!insumo || typeof insumo !== 'object') throw new Error('Informe os parâmetros do equipamento.');
  if (insumo.laminaAutomaticaMmHa !== undefined && (!Number.isFinite(insumo.laminaAutomaticaMmHa) || insumo.laminaAutomaticaMmHa <= 0)) throw new Error('Informe a lâmina desejada em mm/ha, maior que zero.');
  if (insumo.distanciasPeriodos !== undefined) {
    minutosHorarioIrrigacao(insumo.horaInicio ?? ''); minutosHorarioIrrigacao(insumo.horaTermino ?? '');
    if (!Array.isArray(insumo.distanciasPeriodos) || !insumo.distanciasPeriodos.length || insumo.distanciasPeriodos.length > 101) throw new Error('Informe as distâncias dos períodos de irrigação.');
    for (const periodo of insumo.distanciasPeriodos) {
      if (!periodo || !Number.isSafeInteger(periodo.distancia) || periodo.distancia < 1 || periodo.distancia > 9999) throw new Error('Informe a distância de cada período em metros inteiros, entre 1 e 9999.');
      if (minutosHorarioIrrigacao(periodo.termino) <= minutosHorarioIrrigacao(periodo.inicio)) throw new Error('Horários inválidos na distribuição das distâncias.');
    }
  }
  if (insumo.horaInicio !== undefined || insumo.horaTermino !== undefined) {
    const inicio = minutosHorarioIrrigacao(insumo.horaInicio ?? '');
    const termino = minutosHorarioIrrigacao(insumo.horaTermino ?? '');
    if (termino <= inicio) throw new Error('O término da irrigação deve ser posterior ao início, no mesmo dia.');
  }
  if (!['A', 'V', 'D', 'L'].includes(insumo.tipoProduto)) throw new Error('Selecione o produto aplicado.');
  if (!Number.isFinite(insumo.vazao) || insumo.vazao <= 0) throw new Error('Informe uma vazão maior que zero.');
  for (const campo of ['velocidade', 'posicoes', 'codEspacamento', 'qtdeAspersores', 'comprimento', 'deslocamento', 'distancia'] as const) {
    const valor = insumo[campo];
    if (valor !== undefined && (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0)) throw new Error(`Valor inválido para ${campo}.`);
  }
  for (const campo of ['posicoes', 'codEspacamento', 'qtdeAspersores'] as const) {
    if (insumo[campo] !== undefined && !Number.isSafeInteger(insumo[campo])) throw new Error(`Informe um código ou quantidade inteira para ${campo}.`);
  }
  const obrigatorios: Record<string, (keyof InsumoIrrigacao)[]> = {
    A: ['posicoes', 'codEspacamento', 'qtdeAspersores'],
    B: ['velocidade', 'comprimento', 'distancia'],
    H: ['velocidade', 'posicoes', 'codEspacamento', 'comprimento'],
    P: ['comprimento', 'deslocamento'],
  };
  for (const campo of obrigatorios[modalidade ?? ''] ?? []) {
    if (typeof insumo[campo] !== 'number' || Number(insumo[campo]) <= 0) throw new Error(`Informe ${campo} para este tipo de irrigação.`);
  }
}
