import { calcularIndicadoresIrrigacao } from './irrigacao-calculo.ts';
import { minutosHorarioIrrigacao, validarAreaIrrigadaTalhao, validarInsumoIrrigacao, validarParadasIrrigacao } from './irrigacao-validacao.ts';
import { calcularDistanciasPorLamina, distribuirInsumosIrrigacao } from './irrigacao-periodos.ts';
import { consultarSql, consultarSqlGravacao, withOracleGravacao } from './oracle.ts';
import type { MotivoParadaIrrigacao, EspacamentoIrrigacao, EquipamentoIrrigacao, IrrigacaoEntrada, IrrigacaoGravada, TipoIrrigacao } from './irrigacao-types.ts';

export const SQL_CONTEXTO_IRRIGACAO = `SELECT
          NVL(f.cod_grupoempresa, NVL(oc.cod_grupoempresa, 1)) AS grupo,
          NVL(f.cod_empresa, NVL(oc.cod_empresa, 1)) AS empresa,
          NVL(f.cod_filial, NVL(oc.cod_filial, 1)) AS filial
        FROM agricola.fazenda f
        JOIN rh.operacaoagricola o ON o.cod_operacaoagricola = :operacao AND NVL(o.ativo, 'S') = 'S'
        LEFT JOIN rh.operacaoobjetocusto oc ON oc.cod_operacaoagricola = o.cod_operacaoagricola
          AND oc.data_termino IS NULL AND oc.cod_objetocusto = (
            SELECT MIN(x.cod_objetocusto) FROM rh.operacaoobjetocusto x
            WHERE x.cod_operacaoagricola = o.cod_operacaoagricola AND x.data_termino IS NULL)
        WHERE f.cod_fazenda = :fazenda`;

export async function listarTiposIrrigacao(): Promise<TipoIrrigacao[]> {
  const rows = await consultarSqlGravacao(`SELECT cod_tipoirrigacao, TRIM(descricao) AS descricao, tipo_irrigacao
    FROM agricola.irrigacaotipo ORDER BY descricao, cod_tipoirrigacao`);
  return rows.map(row => ({ codigo: Number(row.COD_TIPOIRRIGACAO), descricao: String(row.DESCRICAO ?? '').trim(), tipo: String(row.TIPO_IRRIGACAO ?? '').trim() }))
    .filter(row => Number.isSafeInteger(row.codigo) && row.codigo > 0);
}

export const SQL_MOTIVOS_PARADA_IRRIGACAO = `SELECT cod_motivo, TRIM(descricao) AS descricao
  FROM csintegracao.vw_cs_agr_paradairrigacao
  WHERE cod_grupoempresa = :grupo AND cod_empresa = :empresa AND cod_filial = :filial
    AND ativo = 'S' AND cod_motivo > 0
  ORDER BY cod_motivo`;
function mapearMotivosParada(rows: Record<string, unknown>[]): MotivoParadaIrrigacao[] {
  const motivos = new Map<number, MotivoParadaIrrigacao>();
  for (const row of rows) {
    const codigo = Number(row.COD_MOTIVO), descricao = String(row.DESCRICAO ?? '').trim();
    if (!Number.isSafeInteger(codigo) || codigo <= 0 || !descricao) continue;
    if (motivos.has(codigo) && motivos.get(codigo)?.descricao !== descricao) throw new Error(`Descrição ambígua para o motivo de parada ${codigo}. Confira o cadastro no ERP.`);
    motivos.set(codigo, { codigo, descricao });
  }
  return [...motivos.values()];
}
export async function listarMotivosParadaIrrigacao(codFazenda: number, codOperacao: number): Promise<MotivoParadaIrrigacao[]> {
  if (![codFazenda, codOperacao].every(codigo => Number.isSafeInteger(codigo) && codigo > 0)) throw new Error('Selecione fazenda e operação para consultar os motivos de parada.');
  const contexto = await consultarSqlGravacao(SQL_CONTEXTO_IRRIGACAO, { fazenda: codFazenda, operacao: codOperacao });
  if (contexto.length !== 1) throw new Error('Não foi possível identificar o contexto da fazenda e operação.');
  const row = contexto[0];
  // A view descritiva é acessível ao usuário de leitura CONSULTA, não ao CSCLIENTE.
  return mapearMotivosParada(await consultarSql(SQL_MOTIVOS_PARADA_IRRIGACAO, { grupo: Number(row.GRUPO), empresa: Number(row.EMPRESA), filial: Number(row.FILIAL) }));
}

export async function listarEspacamentosIrrigacao(): Promise<EspacamentoIrrigacao[]> {
  const rows = await consultarSqlGravacao(`SELECT cod_espacamento, qtde_tubos_pri, qtde_tubos_sec, comprimento FROM agricola.irrigacaoespacamento ORDER BY cod_espacamento`);
  return rows.map(row => ({ codigo: Number(row.COD_ESPACAMENTO), qtdeTubosPrimarios: Number(row.QTDE_TUBOS_PRI ?? 0), qtdeTubosSecundarios: Number(row.QTDE_TUBOS_SEC ?? 0), comprimento: Number(row.COMPRIMENTO ?? 0) }));
}

export const SQL_EQUIPAMENTOS_IRRIGACAO = `SELECT DISTINCT e.cod_grupoempresa, e.cod_equipamento, TRIM(e.descricao) AS descricao,
    h.cod_tipoequipamento, t.cod_tipoirrigacao, t.tipo_irrigacao AS modalidade, NVL(t.tempo_lamina_barra, 'V') AS tempo_lamina_barra,
    (SELECT rh.c('OCULTA_POSICOES_HIDR','S') FROM dual) AS oculta_posicoes_hidr, TRIM(t.descricao) AS descricao_tipo
  FROM automotivo.equipamento e
  JOIN automotivo.historico_tipoequipamento h ON h.cod_grupoempresa = e.cod_grupoempresa AND h.cod_equipamento = e.cod_equipamento
  JOIN agricola.irrigacaotipoequipamento m ON m.cod_grupoempresa = h.cod_grupoempresa AND m.cod_tipoequipamento = h.cod_tipoequipamento
  JOIN agricola.irrigacaotipo t ON t.tipo_irrigacao = m.tipoirrigacao
  WHERE (:grupo = 0 OR e.cod_grupoempresa = :grupo) AND (:empresa = 0 OR m.cod_empresa = :empresa) AND (:filial = 0 OR m.cod_filial = :filial)
    AND NVL(e.ativo, 'S') = 'S'
    AND h.data_inicio <= TO_DATE(:data, 'FXYYYY-MM-DD')
    AND (h.data_fim IS NULL OR h.data_fim >= TO_DATE(:data, 'FXYYYY-MM-DD'))
    AND m.data_inicio <= TO_DATE(:data, 'FXYYYY-MM-DD')
    AND (m.data_termino IS NULL OR m.data_termino >= TO_DATE(:data, 'FXYYYY-MM-DD'))
    AND (:equipamento = 0 OR e.cod_equipamento = :equipamento)
  ORDER BY e.cod_equipamento, t.cod_tipoirrigacao`;

export function mapearEquipamentosIrrigacao(rows: Record<string, unknown>[]): EquipamentoIrrigacao[] {
  const grupos = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const codigo = Number(row.COD_EQUIPAMENTO);
    if (!Number.isSafeInteger(codigo) || codigo <= 0) continue;
    grupos.set(codigo, [...(grupos.get(codigo) ?? []), row]);
  }
  return [...grupos].map(([codigo, equipamentos]) => {
    // Regra de negócio confirmada pelo usuário: 7 -> MOTO BOMBA (1), 40 -> ELETROBOMBA (4).
    const candidatos = equipamentos.filter(row => {
      const tipoEquipamento = Number(row.COD_TIPOEQUIPAMENTO), tipo = Number(row.COD_TIPOIRRIGACAO);
      return tipoEquipamento === 7 ? tipo === 1 : tipoEquipamento === 40 ? tipo === 4 : true;
    });
    const codigos = [...new Set(candidatos.map(row => Number(row.COD_TIPOIRRIGACAO)))];
    const tipo = codigos.length === 1 && Number.isSafeInteger(codigos[0]) && codigos[0] > 0 ? codigos[0] : null;
    const selecionado = candidatos.find(row => Number(row.COD_TIPOIRRIGACAO) === tipo);
    const tempo = String(selecionado?.TEMPO_LAMINA_BARRA ?? '');
    const oculta = String(selecionado?.OCULTA_POSICOES_HIDR ?? '');
    return { codigo, tempoLaminaBarra: tempo === 'H' || tempo === 'V' ? tempo : undefined,
      ocultaPosicoesHidr: oculta === 'S' ? true : oculta === 'N' ? false : undefined, descricao: String(equipamentos[0].DESCRICAO ?? '').trim(), codTipoIrrigacao: tipo,
      modalidade: tipo == null ? undefined : String(candidatos.find(row => Number(row.COD_TIPOIRRIGACAO) === tipo)?.MODALIDADE ?? '').trim(),
      descricaoTipo: tipo == null ? 'Vínculo de irrigação ausente ou ambíguo no ERP.' : String(candidatos.find(row => Number(row.COD_TIPOIRRIGACAO) === tipo)?.DESCRICAO_TIPO ?? '').trim() };
  });
}

export async function listarEquipamentosIrrigacao(codFazenda: number, codOperacao: number, dataApontamento: string): Promise<EquipamentoIrrigacao[]> {
  if (![codFazenda, codOperacao].every(codigo => Number.isSafeInteger(codigo) && codigo > 0)) throw new Error('Selecione fazenda e operação válidas.');
  validarDataIrrigacao(dataApontamento);
  const rows = await consultarSqlGravacao(SQL_CONTEXTO_IRRIGACAO, { fazenda: codFazenda, operacao: codOperacao });
  if (rows.length !== 1) throw new Error('Selecione uma fazenda e operação com contexto único.');
  const row = rows[0];
  const dados = await consultarSqlGravacao(SQL_EQUIPAMENTOS_IRRIGACAO, { grupo: Number(row.GRUPO), empresa: Number(row.EMPRESA), filial: Number(row.FILIAL), data: dataApontamento, equipamento: 0 });
  return mapearEquipamentosIrrigacao(dados);
}

/** Resolve os vínculos em lotes e escolhe apenas uma consulta de equipamentos por empresa/filial/data. */
export async function planejarImportacaoEquipamentos(entrada: unknown, incluirVinculos = false) {
  if (!Array.isArray(entrada) || !entrada.length || entrada.length > 50000) throw new Error('Informe entre 1 e 50000 contextos de irrigação.');
  const contextos = new Map<string, { codFazenda: number; codOperacao: number; data: string }>();
  for (const item of entrada) {
    if (!item || ![item.codFazenda, item.codOperacao].every(codigo => Number.isSafeInteger(codigo) && codigo > 0)) throw new Error('Fazenda ou operação inválida.');
    validarDataIrrigacao(item.data);
    contextos.set(JSON.stringify([item.codFazenda, item.codOperacao, item.data]), { codFazenda: item.codFazenda, codOperacao: item.codOperacao, data: item.data });
  }
  const pares = [...new Map([...contextos.values()].map(item => [JSON.stringify([item.codFazenda, item.codOperacao]), item])).values()];
  const vinculos = new Map<string, { grupo: number; empresa: number; filial: number }>();
  const sql = SQL_CONTEXTO_IRRIGACAO
    .replace('SELECT', 'SELECT DISTINCT c.fazenda AS fazenda_origem, c.operacao AS operacao_origem,')
    .replace('FROM agricola.fazenda f', `FROM JSON_TABLE(:contextos, '$[*]' COLUMNS (fazenda NUMBER PATH '$.codFazenda', operacao NUMBER PATH '$.codOperacao')) c
          JOIN agricola.fazenda f ON f.cod_fazenda = c.fazenda`)
    .replaceAll(':operacao', 'c.operacao').replaceAll(':fazenda', 'c.fazenda');
  for (let offset = 0; offset < pares.length; offset += 200) {
    const rows = await consultarSqlGravacao(sql, { contextos: JSON.stringify(pares.slice(offset, offset + 200).map(({ codFazenda, codOperacao }) => ({ codFazenda, codOperacao }))) });
    for (const row of rows) {
      const chave = JSON.stringify([Number(row.FAZENDA_ORIGEM), Number(row.OPERACAO_ORIGEM)]);
      const vinculo = { grupo: Number(row.GRUPO), empresa: Number(row.EMPRESA), filial: Number(row.FILIAL) };
      if (!Object.values(vinculo).every(codigo => Number.isSafeInteger(codigo) && codigo > 0)) throw new Error('Contexto de empresa/filial inválido.');
      const anterior = vinculos.get(chave);
      if (anterior && JSON.stringify(anterior) !== JSON.stringify(vinculo)) throw new Error('Uma fazenda/operação tem contexto ambíguo. Confira o cadastro no ERP.');
      vinculos.set(chave, vinculo);
    }
  }
  const unicos = new Map<string, { codFazenda: number; codOperacao: number; data: string }>();
  for (const item of contextos.values()) {
    const vinculo = vinculos.get(JSON.stringify([item.codFazenda, item.codOperacao]));
    if (!vinculo) throw new Error(`Fazenda ${item.codFazenda} e operação ${item.codOperacao} sem contexto válido.`);
    const chave = JSON.stringify([vinculo.grupo, vinculo.empresa, vinculo.filial, item.data]);
    if (!unicos.has(chave)) unicos.set(chave, item);
  }
  return { versao: 1, totalContextos: contextos.size, contextos: [...unicos.values()], ...(incluirVinculos ? { vinculos: [...vinculos.entries()] } : {}) };
}

function validarDataIrrigacao(dataApontamento: string): void {
  if (typeof dataApontamento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dataApontamento)) throw new Error('Informe uma data válida.');
  const [ano, mes, dia] = dataApontamento.split('-').map(Number);
  const data = new Date(ano, mes - 1, dia);
  if (ano < 1900 || data.getFullYear() !== ano || data.getMonth() !== mes - 1 || data.getDate() !== dia) throw new Error('Informe uma data válida.');
}
export async function consultarEquipamentoIrrigacao(codigo: number, dataApontamento: string): Promise<EquipamentoIrrigacao> {
  if (!Number.isSafeInteger(codigo) || codigo <= 0) throw new Error('Informe um código válido de equipamento.');
  validarDataIrrigacao(dataApontamento);
  const rows = await consultarSqlGravacao(SQL_EQUIPAMENTOS_IRRIGACAO, { grupo: 0, empresa: 0, filial: 0, data: dataApontamento, equipamento: codigo });
  const grupos = new Set(rows.map(row => Number(row.COD_GRUPOEMPRESA)).filter(grupo => grupo > 0));
  if (grupos.size > 1) throw new Error('Esse código de equipamento existe em mais de um grupo. Importe os equipamentos pela fazenda e operação para identificá-lo.');
  const equipamento = mapearEquipamentosIrrigacao(rows).find(item => item.codigo === codigo);
  if (!equipamento) throw new Error(`Equipamento ${codigo} não encontrado como ativo e com vínculo de irrigação vigente na data informada.`);
  return equipamento;
}

export function validarIrrigacao(entrada: IrrigacaoEntrada): void {
  if (!entrada || typeof entrada !== 'object') throw new Error('Informe os dados da irrigação.');
  if (entrada.apenasParadas !== undefined && typeof entrada.apenasParadas !== 'boolean') throw new Error('Opção apenas paradas inválida.');
  if (entrada.houveHorarioPico !== undefined && typeof entrada.houveHorarioPico !== 'boolean') throw new Error('Opção de horário de pico inválida.');
  if (entrada.houveHorarioPico) {
    if (!Number.isSafeInteger(entrada.codMotivoHorarioPico) || Number(entrada.codMotivoHorarioPico) <= 0) throw new Error('Informe um motivo válido para a parada do horário de pico.');
    const inicioPico = minutosHorarioIrrigacao(entrada.inicioParadaPico ?? '');
    const terminoPico = minutosHorarioIrrigacao(entrada.terminoParadaPico ?? '');
    if (terminoPico <= inicioPico) throw new Error('O término da parada do horário de pico deve ser posterior ao início, no mesmo dia.');
  }
  if (![entrada.codFazenda, entrada.codTalhao, entrada.codFuncionario, entrada.codOperacao, entrada.codTipoIrrigacao, entrada.codEquipamento].every(valor => Number.isSafeInteger(valor) && valor > 0) ||
      !Number.isSafeInteger(entrada.zona) || entrada.zona < 0) throw new Error('Selecione fazenda, talhão, zona, funcionário, operação e tipo de irrigação válidos.');
  if (!entrada.apenasParadas && (typeof entrada.area !== 'number' || !Number.isFinite(entrada.area) || entrada.area <= 0 ||
      typeof entrada.numeroLamina !== 'number' || !Number.isFinite(entrada.numeroLamina) || entrada.numeroLamina <= 0)) throw new Error('Área e lâmina devem ser maiores que zero.');
  const paradas = paradasDaEntrada(entrada);
  if (entrada.apenasParadas && !paradas.length) throw new Error('Adicione pelo menos uma parada.');
  validarDataIrrigacao(entrada.dataApontamento);
  validarParadasIrrigacao(paradas);
  if (!entrada.apenasParadas && (entrada.insumo !== undefined || paradas.length)) validarInsumoIrrigacao(entrada.insumo);
}

function paradasDaEntrada(entrada: IrrigacaoEntrada) {
  const outras = entrada.paradas ?? [];
  const pico = entrada.houveHorarioPico ? { codMotivo: entrada.codMotivoHorarioPico!, inicio: entrada.inicioParadaPico!, termino: entrada.terminoParadaPico!, descricao: 'Horário de pico' } : null;
  return [
    ...outras,
    ...(pico && !outras.some(parada => parada.codMotivo === pico.codMotivo && parada.inicio === pico.inicio && parada.termino === pico.termino) ? [pico] : []),
  ];
}

export async function gravarIrrigacao(entrada: IrrigacaoEntrada): Promise<IrrigacaoGravada> {
  validarIrrigacao(entrada);
  const paradas = paradasDaEntrada(entrada);
  return withOracleGravacao(async (connection, driver) => {
    const opcoes = { outFormat: driver.OUT_FORMAT_OBJECT };
    try {
      // O contexto de empresa é obtido no ERP, sem confiar em códigos de empresa enviados pelo celular.
      const contexto = await connection.execute(SQL_CONTEXTO_IRRIGACAO, { fazenda: entrada.codFazenda, operacao: entrada.codOperacao }, opcoes);
      const row = contexto.rows?.[0];
      if (!row || contexto.rows?.length !== 1) throw new Error('Não foi possível identificar unicamente a fazenda e a operação no ERP.');
      const grupo = Number(row.GRUPO), empresa = Number(row.EMPRESA), filial = Number(row.FILIAL);
      if (![grupo, empresa, filial].every(valor => Number.isSafeInteger(valor) && valor > 0)) throw new Error('Grupo, empresa ou filial inválidos no cadastro.');
      const talhao = await connection.execute(`SELECT NVL(areaplantada, areaproducao) AS area_ha FROM agricola.talhao
        WHERE cod_fazenda = :fazenda AND cod_talhao = :talhao AND zona = :zona AND ROWNUM = 1`,
      { fazenda: entrada.codFazenda, talhao: entrada.codTalhao, zona: entrada.zona }, opcoes);
      if (!talhao.rows?.length) throw new Error('Talhão e zona não encontrados para esta fazenda.');
      const funcionario = await connection.execute(`SELECT 1 AS ok FROM rh.funcionario
        WHERE cod_grupoempresa = :grupo AND cod_funcionario = :funcionario AND ROWNUM = 1`,
      { grupo, funcionario: entrada.codFuncionario }, opcoes);
      if (!funcionario.rows?.length) throw new Error('Funcionário não encontrado no grupo da fazenda.');
      const equipamentos = await connection.execute(SQL_EQUIPAMENTOS_IRRIGACAO,
        { grupo, empresa, filial, data: entrada.dataApontamento, equipamento: entrada.codEquipamento }, opcoes);
      const equipamento = mapearEquipamentosIrrigacao(equipamentos.rows ?? []).find(item => item.codigo === entrada.codEquipamento);
      if (!equipamento?.codTipoIrrigacao) throw new Error('O equipamento não possui um tipo de irrigação único e vigente. Confira o cadastro no ERP.');
      if (equipamento.codTipoIrrigacao !== entrada.codTipoIrrigacao) throw new Error('O tipo do equipamento mudou. Atualize os equipamentos antes de enviar.');
      if (entrada.insumo && !entrada.apenasParadas) {
        if (!equipamento.modalidade) throw new Error('Atualize o cadastro do equipamento para identificar os parâmetros de irrigação.');
        if (entrada.insumo.laminaAutomaticaMmHa !== undefined) {
          const distanciasPeriodos = calcularDistanciasPorLamina(entrada.insumo, paradas, equipamento.modalidade, equipamento.tempoLaminaBarra);
          entrada = { ...entrada, insumo: { ...entrada.insumo, distanciasPeriodos, distancia: distanciasPeriodos.reduce((total, item) => total + item.distancia, 0) } };
        }
        validarInsumoIrrigacao(entrada.insumo, equipamento.modalidade);
      }
      if (paradas.length) {
        const motivos = mapearMotivosParada(await consultarSql(SQL_MOTIVOS_PARADA_IRRIGACAO, { grupo, empresa, filial }));
        for (const parada of paradas) {
          if (!motivos.some(motivo => motivo.codigo === parada.codMotivo)) throw new Error(`Motivo de parada ${parada.codMotivo} não encontrado ou inativo neste contexto. Atualize os motivos.`);
        }
      }
      if (!entrada.apenasParadas && entrada.insumo) {
        const espacamento = ['A', 'H'].includes(equipamento.modalidade ?? '')
          ? (await listarEspacamentosIrrigacao()).find(item => item.codigo === entrada.insumo?.codEspacamento) : undefined;
        const indicadores = calcularIndicadoresIrrigacao({ modalidade: equipamento.modalidade!, tempoLaminaBarra: equipamento.tempoLaminaBarra,
          ocultaPosicoesHidr: equipamento.ocultaPosicoesHidr }, entrada.insumo, espacamento, paradas);
        validarAreaIrrigadaTalhao(indicadores.areaIrrigada, Number(talhao.rows?.[0]?.AREA_HA));
        entrada = { ...entrada, area: indicadores.areaIrrigada };
      }
      // Calcula tudo antes do primeiro INSERT; o servidor refaz a distribuição.
      const periodos = !entrada.apenasParadas && entrada.insumo?.horaInicio !== undefined && (paradas.length || entrada.insumo.distanciasPeriodos !== undefined)
        ? distribuirInsumosIrrigacao(entrada.insumo, paradas, equipamento.modalidade!)
        : entrada.insumo && !entrada.apenasParadas ? [entrada.insumo] : [];
      const result = await connection.execute(`INSERT INTO csintegracao.cs_agr_irrig_apontamento
        (cod_grupoempresa, cod_empresa, cod_filial, ano_apontamento, data_apontamento, importado)
        VALUES (:grupo, :empresa, :filial, :ano, TO_DATE(:data, 'FXYYYY-MM-DD'), 'N')
        RETURNING id_irrigapt INTO :id`,
      { grupo, empresa, filial, ano: Number(entrada.dataApontamento.slice(0, 4)), data: entrada.dataApontamento,
        id: { dir: driver.BIND_OUT, type: driver.NUMBER } }, { autoCommit: false });
      const idRetornado = (valor: unknown): number => Number(Array.isArray(valor) ? valor[0] : valor);
      const idApontamento = idRetornado(result.outBinds?.id);
      if (!Number.isSafeInteger(idApontamento) || idApontamento <= 0) throw new Error('O banco não retornou o ID do apontamento.');
      const inserirArea = async (apenas: boolean): Promise<number> => {
        const area = await connection.execute(`INSERT INTO csintegracao.cs_agr_irrig_apont_area
          (id_irrigapt, cod_operacao, cod_fazenda, cod_talhao, zona, cod_funcionario,
           cod_tipoirrigacao, area, numero_lamina, apenas_paradas, encerrado, importado)
          VALUES (:apontamento, :operacao, :fazenda, :talhao, :zona, :funcionario,
                  :tipo, :area, :lamina, :apenasParadas, 'N', 'N') RETURNING id_irgaptarea INTO :id`,
        { apontamento: idApontamento, operacao: entrada.codOperacao, fazenda: entrada.codFazenda,
          talhao: entrada.codTalhao, zona: entrada.zona, funcionario: entrada.codFuncionario,
          tipo: entrada.codTipoIrrigacao, area: apenas ? 0 : entrada.area,
          lamina: apenas ? (Number.isSafeInteger(entrada.numeroLamina) && entrada.numeroLamina > 0 ? entrada.numeroLamina : 1) : entrada.numeroLamina,
          apenasParadas: apenas ? 'S' : 'N',
          id: { dir: driver.BIND_OUT, type: driver.NUMBER } }, { autoCommit: false });
        const idArea = idRetornado(area.outBinds?.id);
        if (!Number.isSafeInteger(idArea) || idArea <= 0) throw new Error('O banco não retornou o ID da área irrigada.');
        return idArea;
      };
      const idArea = await inserirArea(entrada.apenasParadas === true);
      let idInsumo: number | undefined;
      const idsInsumos: number[] = [];
      const idsParadas: number[] = [];
      // Cada parada fica uma única vez no primeiro período do equipamento, no mesmo item/área.
      const itens: { insumo: Partial<NonNullable<IrrigacaoEntrada['insumo']>>; area: number; parada: boolean }[] = periodos.map((insumo, indice) => ({ insumo, area: idArea, parada: indice === 0 }));
      // As constraints CK exigem produto e vazão mesmo quando os triggers dispensam produção.
      if (entrada.apenasParadas) itens.push({ insumo: { tipoProduto: entrada.insumo?.tipoProduto ?? 'A', vazao: 0 }, area: idArea, parada: true });
      for (const item of itens) {
        const insumo = item.insumo;
        const resultInsumo = await connection.execute(`INSERT INTO csintegracao.cs_agr_irrig_apont_insumo
          (id_irgaptarea, cod_insumo, tipo_produto, vazao, velocidade, posicoes, cod_espacamento,
           qtde_aspersores, comprimento, deslocamento, distancia, hora_inicio, hora_termino, importado)
          VALUES (:area, :equipamento, :produto, :vazao, :velocidade, :posicoes, :espacamento,
                  :aspersores, :comprimento, :deslocamento, :distancia, :horaInicio, :horaTermino, 'N') RETURNING id_irgaptinsu INTO :id`,
        { area: item.area, equipamento: entrada.codEquipamento, produto: insumo.tipoProduto ?? null, vazao: insumo.vazao ?? null,
          velocidade: insumo.velocidade ?? null, posicoes: insumo.posicoes ?? null, espacamento: insumo.codEspacamento ?? null,
          aspersores: insumo.qtdeAspersores ?? null, comprimento: insumo.comprimento ?? null,
          deslocamento: insumo.deslocamento ?? null, distancia: insumo.distancia ?? null,
          horaInicio: insumo.horaInicio ?? null, horaTermino: insumo.horaTermino ?? null,
          id: { dir: driver.BIND_OUT, type: driver.NUMBER } }, { autoCommit: false });
        const idItem = idRetornado(resultInsumo.outBinds?.id);
        if (!Number.isSafeInteger(idItem) || idItem <= 0) throw new Error('O banco não retornou o ID do equipamento/insumo.');
        idInsumo ??= idItem; idsInsumos.push(idItem);
        for (const parada of item.parada ? paradas : []) {
          const resultParada = await connection.execute(`INSERT INTO csintegracao.cs_agr_irrig_apont_parada
            (id_irgaptinsu, cod_motivo, inicio, termino, importado)
            VALUES (:insumo, :motivo, :inicio, :termino, 'N') RETURNING id_irgaptprda INTO :id`,
          { insumo: idItem, motivo: parada.codMotivo, inicio: parada.inicio, termino: parada.termino,
            id: { dir: driver.BIND_OUT, type: driver.NUMBER } }, { autoCommit: false });
          const idParada = idRetornado(resultParada.outBinds?.id);
          if (!Number.isSafeInteger(idParada) || idParada <= 0) throw new Error('O banco não retornou o ID da parada.');
          idsParadas.push(idParada);
        }
      }
      await connection.commit();
      return { idApontamento, idArea, idInsumo, idsInsumos, idsParadas, mensagem: 'Irrigação gravada na integração do ERP.' };
    } catch (erro) {
      await connection.rollback();
      throw erro;
    }
  });
}
