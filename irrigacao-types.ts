export interface TipoIrrigacao {
  codigo: number;
  descricao: string;
  tipo: string;
}

export interface IrrigacaoEntrada {
  apenasParadas?: boolean;
  houveHorarioPico?: boolean;
  codMotivoHorarioPico?: number;
  inicioParadaPico?: string;
  terminoParadaPico?: string;
  dataApontamento: string;
  codFazenda: number;
  codTalhao: number;
  zona: number;
  codFuncionario: number;
  codOperacao: number;
  codTipoIrrigacao: number;
  codEquipamento: number;
  area: number;
  numeroLamina: number;
  insumo?: InsumoIrrigacao;
  paradas?: ParadaIrrigacao[];
}

export interface IrrigacaoGravada {
  idApontamento: number;
  idArea: number;
  mensagem: string;
  idInsumo?: number;
  idsParadas?: number[];
  idsInsumos?: number[];
  idAreaParadas?: number;
}

export interface EquipamentoIrrigacao {
  codigo: number;
  descricao: string;
  codTipoIrrigacao: number | null;
  descricaoTipo: string;
  parametrosFixos?: { vazao: number; comprimento: number };
  modalidade?: string;
  tempoLaminaBarra?: 'V' | 'H';
  ocultaPosicoesHidr?: boolean;
}

export interface ParadaIrrigacao { codMotivo: number; inicio: string; termino: string; descricao?: string }
export interface MotivoParadaIrrigacao { codigo: number; descricao: string }
export interface InsumoIrrigacao {
  laminaAutomaticaMmHa?: number;
  distanciasPeriodos?: { inicio: string; termino: string; distancia: number }[];
  tipoProduto: 'A' | 'V' | 'D' | 'L';
  horaInicio?: string;
  horaTermino?: string;
  vazao: number;
  velocidade?: number;
  posicoes?: number;
  codEspacamento?: number;
  qtdeAspersores?: number;
  comprimento?: number;
  deslocamento?: number;
  distancia?: number;
}

export interface EspacamentoIrrigacao {
  codigo: number;
  qtdeTubosPrimarios: number;
  qtdeTubosSecundarios: number;
  comprimento: number;
}
export interface IndicadoresIrrigacao {
  areaIrrigada: number;
  m3Ha: number;
  mmHa: number;
  horasPeriodo: number;
  horasParadas: number;
  horasConsideradas: number;
}
