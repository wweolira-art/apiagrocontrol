/**
 * Custos do talhão — mesma lógica de Custoplanejamento.
 *
 * Rateio:
 *  1) Oficina: lancamento_custo tipo R (negócio 3 / processo 1 / subprocesso 1)
 *     custo_rateado = valor × (horas_os / horas_total do mês)
 *  2) Equipamento → atividade: percentual = kmhs_talhão / kmhs_total do equipamento
 *     custoOficina = custo_rateado × percentual
 *  3) Combustível: abastecimento (automotivo + posto)
 *  4) Material de manutenção: requisição (exclui oficina, insumo e combustível)
 *  5) Insumo agrícola: apontamentomaterial + apontamentoitem
 *
 * custoEquipamento = oficina + combustível + material
 * rendimento R$/ha = custo / área do talhão
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

import { consultarSql, oracleCredenciaisPreenchidas, sincronizarConexaoBancoOrds } from './oracle.ts';

export interface CustoTalhaoFiltros {
  codigoFazenda: number;
  talhao: number;
  anomesInicio?: string;
  anomesFim?: string;
  areaHa?: number | null;
}

export interface InsumoTalhao {
  codMaterial: string;
  descricao: string;
  quantidade: number;
  dosePorHa: number | null;
  custo: number;
  custoPorHa: number | null;
}

export interface GrupoInsumoTalhao {
  codFamilia: number;
  codGrupoMaterial: number;
  descricao: string;
  quantidade: number;
  dosePorHa: number | null;
  custo: number;
  custoPorHa: number | null;
  itens: InsumoTalhao[];
}

export interface EquipamentoTalhao {
  codEquipamento: number;
  descricao: string;
  codOperacoes: number[];
  horas: number;
  litros: number;
  litrosPorHora: number | null;
  percentualRateio: number;
  custoOficina: number;
  custoCombustivel: number;
  custoMaterial: number;
  custoTotal: number;
  custoPorHa: number | null;
}

export interface EquipamentoAtividade {
  codEquipamento: number;
  descricao: string;
  horas: number;
  custo: number;
  custoPorHa: number | null;
}

export interface AtividadeTalhao {
  atividade: number | null;
  codObjetoCusto: number | null;
  descricao: string;
  custoInsumo: number;
  custoEquipamento: number;
  custo: number;
  custoPorHa: number | null;
  insumos: InsumoTalhao[];
  equipamentos: EquipamentoAtividade[];
}

export interface FichaTalhao {
  areaHa: number | null;
  areaPlantada: number | null;
  areaProducao: number | null;
  codVariedade: number | null;
  variedade: string | null;
  codTipoSolo: number | null;
  tipoSolo: string | null;
  tipoSoloDetalhe: string | null;
}

export interface CustoTalhaoResponse {
  origem: 'oracle' | 'mock';
  codigoFazenda: number;
  talhao: number;
  periodo: { anomesInicio: string; anomesFim: string };
  areaHa: number | null;
  ficha: FichaTalhao | null;
  rendimento: {
    custoInsumo: number;
    custoEquipamento: number;
    custoTotal: number;
    custoInsumoPorHa: number | null;
    custoEquipamentoPorHa: number | null;
    custoTotalPorHa: number | null;
  };
  insumos: GrupoInsumoTalhao[];
  equipamentos: EquipamentoTalhao[];
  atividades: AtividadeTalhao[];
  logica: Record<string, string>;
}

const MAP_PATH = [
  path.resolve(process.cwd(), 'assets/maps/talhoes.json'),
  path.resolve(SERVER_DIR, '../assets/maps/talhoes.json'),
].find((arquivo) => fs.existsSync(arquivo)) ?? path.resolve(SERVER_DIR, 'talhoes.json');

const LOGICA = {
  equipamentos:
    'cod_equipamento vem de automotivo.abastecimento / posto.abastecimento; fazenda e talhão vêm do último automotivo.itens_apontamento',
  operacoes:
    'cod_operacaoagricola vem de consulta separada em automotivo.itens_apontamento (fazenda, talhão, período e equipamentos)',
  oficina: 'custo_rateado = valor × (horas_os / horas_total) · objetocusto 3/1/1',
  atividade: 'percentual = kmhs do talhão / kmhs total do equipamento no mês',
  custos: 'custoOficina + custoCombustivel + custoMaterial',
  insumos: 'apontamentomaterial agrupado por material.grupomaterial (família + grupo)',
  atividades:
    'insumos e equipamentos do talhão agrupados por custo.objetocusto.descricao (atividade)',
  ficha: 'agricola.talhao + agricola.variedade.descricao + agricola.tipo_solo.descricao',
  rendimento: 'R$/ha = custo / área do talhão (areaplantada)',
};

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toTrimmed(value: unknown): string | null {
  if (value == null || value === '') {
    return null;
  }
  const texto = String(value).trim();
  return texto || null;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function periodoPadrao(hoje = new Date()): { anomesInicio: string; anomesFim: string } {
  const fim = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const inicio = new Date(fim.getFullYear(), fim.getMonth() - 11, 1);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return { anomesInicio: fmt(inicio), anomesFim: fmt(fim) };
}

function anomesParaDataInicio(anomes: string): Date {
  return new Date(Number(anomes.slice(0, 4)), Number(anomes.slice(4, 6)) - 1, 1);
}

function anomesParaDataFimExclusiva(anomes: string): Date {
  return new Date(Number(anomes.slice(0, 4)), Number(anomes.slice(4, 6)), 1);
}

function porHa(valor: number, areaHa: number | null): number | null {
  if (areaHa == null || areaHa <= 0) {
    return null;
  }
  return valor / areaHa;
}

function porHora(valor: number, horas: number): number | null {
  if (!(horas > 0)) {
    return null;
  }
  return valor / horas;
}

function rowVal(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) {
      return row[key];
    }
    const upper = key.toUpperCase();
    if (row[upper] !== undefined) {
      return row[upper];
    }
  }
  return undefined;
}

function parseFicha(row: Record<string, unknown> | undefined): FichaTalhao | null {
  if (!row) {
    return null;
  }
  const areaPlantada = toNullableNumber(rowVal(row, 'AREAPLANTADA', 'areaplantada'));
  const areaProducao = toNullableNumber(rowVal(row, 'AREAPRODUCAO', 'areaproducao'));
  const areaHa =
    areaPlantada != null && areaPlantada > 0
      ? areaPlantada
      : areaProducao != null && areaProducao > 0
        ? areaProducao
        : null;
  return {
    areaHa,
    areaPlantada,
    areaProducao,
    codVariedade: toNullableNumber(rowVal(row, 'COD_VARIEDADE', 'cod_variedade')),
    variedade: toTrimmed(rowVal(row, 'VARIEDADE', 'variedade')),
    codTipoSolo: toNullableNumber(rowVal(row, 'COD_TIPOSOLO', 'cod_tiposolo')),
    tipoSolo: toTrimmed(rowVal(row, 'TIPO_SOLO', 'tipo_solo')),
    tipoSoloDetalhe: toTrimmed(rowVal(row, 'TIPO_SOLO_DETALHE', 'tipo_solo_detalhe')),
  };
}

function chaveAtividade(atividade: number | null, descricao: string): string {
  return `${atividade ?? 'sem'}|${descricao}`;
}

function vaziaAtividade(
  atividade: number | null,
  codObjetoCusto: number | null,
  descricao: string,
): AtividadeTalhao {
  return {
    atividade,
    codObjetoCusto,
    descricao,
    custoInsumo: 0,
    custoEquipamento: 0,
    custo: 0,
    custoPorHa: null,
    insumos: [],
    equipamentos: [],
  };
}

function montarAtividades(
  insumoRows: Record<string, unknown>[],
  equipAtivRows: Record<string, unknown>[],
  equipamentos: EquipamentoTalhao[],
  areaHa: number | null,
): AtividadeTalhao[] {
  const grupos = new Map<string, AtividadeTalhao>();

  const obter = (atividade: number | null, codObjetoCusto: number | null, descricao: string) => {
    const nome = descricao || 'Sem atividade';
    const chave = chaveAtividade(atividade, nome);
    const atual = grupos.get(chave) ?? vaziaAtividade(atividade, codObjetoCusto, nome);
    if (atual.codObjetoCusto == null && codObjetoCusto != null) {
      atual.codObjetoCusto = codObjetoCusto;
    }
    grupos.set(chave, atual);
    return atual;
  };

  for (const row of insumoRows) {
    const descricao = toTrimmed(rowVal(row, 'ATIVIDADE_DESCRICAO', 'atividade_descricao')) ?? 'Sem atividade';
    const grupo = obter(
      toNullableNumber(rowVal(row, 'ATIVIDADE', 'atividade')),
      toNullableNumber(rowVal(row, 'COD_OBJETOCUSTO', 'cod_objetocusto')),
      descricao,
    );
    const codMaterial = String(rowVal(row, 'COD_MATERIAL', 'cod_material') ?? '');
    const custo = toNumber(rowVal(row, 'CUSTO_INSUMO', 'custo_insumo'));
    const quantidade = toNumber(rowVal(row, 'QUANTIDADE', 'quantidade'));
    if (!codMaterial && !(custo > 0)) {
      continue;
    }
    grupo.custoInsumo += custo;
    grupo.insumos.push({
      codMaterial: codMaterial || '—',
      descricao: toTrimmed(rowVal(row, 'MATERIAL_DESCRICAO', 'material_descricao')) ?? `Material ${codMaterial}`,
      quantidade,
      dosePorHa: porHa(quantidade, areaHa),
      custo,
      custoPorHa: porHa(custo, areaHa),
    });
  }

  const horasPorEq = new Map<number, number>();
  const linhasEquip: Array<{
    eq: number;
    horas: number;
    atividade: number | null;
    codObjetoCusto: number | null;
    descricao: string;
  }> = [];
  for (const row of equipAtivRows) {
    const eq = toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento'));
    if (eq == null) {
      continue;
    }
    const horas = toNumber(rowVal(row, 'HORAS', 'horas'));
    horasPorEq.set(eq, (horasPorEq.get(eq) || 0) + horas);
    linhasEquip.push({
      eq,
      horas,
      atividade: toNullableNumber(rowVal(row, 'ATIVIDADE', 'atividade')),
      codObjetoCusto: toNullableNumber(rowVal(row, 'COD_OBJETOCUSTO', 'cod_objetocusto')),
      descricao: toTrimmed(rowVal(row, 'ATIVIDADE_DESCRICAO', 'atividade_descricao')) ?? 'Sem atividade',
    });
  }

  const custoPorEq = new Map(equipamentos.map((item) => [item.codEquipamento, item]));
  const linhasPorEq = new Map<number, number>();
  for (const linha of linhasEquip) {
    linhasPorEq.set(linha.eq, (linhasPorEq.get(linha.eq) || 0) + 1);
  }

  for (const linha of linhasEquip) {
    const grupo = obter(linha.atividade, linha.codObjetoCusto, linha.descricao);
    const totalHoras = horasPorEq.get(linha.eq) || 0;
    const qtdLinhas = linhasPorEq.get(linha.eq) || 1;
    const equipamento = custoPorEq.get(linha.eq);
    const share = totalHoras > 0 ? linha.horas / totalHoras : 1 / qtdLinhas;
    const custo = (equipamento?.custoTotal ?? 0) * share;
    grupo.custoEquipamento += custo;
    grupo.equipamentos.push({
      codEquipamento: linha.eq,
      descricao: equipamento?.descricao ?? '',
      horas: linha.horas,
      custo,
      custoPorHa: porHa(custo, areaHa),
    });
  }

  return [...grupos.values()]
    .map((grupo) => ({
      ...grupo,
      insumos: grupo.insumos.sort((a, b) => b.custo - a.custo),
      equipamentos: grupo.equipamentos.sort((a, b) => b.custo - a.custo),
      custo: grupo.custoInsumo + grupo.custoEquipamento,
      custoPorHa: porHa(grupo.custoInsumo + grupo.custoEquipamento, areaHa),
    }))
    .sort((a, b) => b.custo - a.custo);
}

function geodesicAreaHa(ring: number[][]): number {
  if (!ring || ring.length < 3) {
    return 0;
  }
  const R = 6378137;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const lng1 = ring[i]?.[0];
    const lat1 = ring[i]?.[1];
    const lng2 = ring[i + 1]?.[0];
    const lat2 = ring[i + 1]?.[1];
    if (lng1 == null || lat1 == null || lng2 == null || lat2 == null) {
      continue;
    }
    area +=
      ((lng2 - lng1) * Math.PI) / 180 *
      (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
  }
  return Math.abs((area * R * R) / 2) / 10_000;
}

export function areaHaDoGeoJson(codigoFazenda: number, talhao: number): number | null {
  if (!fs.existsSync(MAP_PATH)) {
    return null;
  }
  const collection = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) as {
    features?: Array<{
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown> | null;
    }>;
  };
  const feature = (collection.features ?? []).find((item) => {
    const p = item.properties ?? {};
    return Number(p.Cod_fazend) === codigoFazenda && Number(p.Lote) === talhao;
  });
  if (!feature?.geometry) {
    return null;
  }
  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') {
    const ring = (geometry.coordinates as number[][][])[0];
    const ha = geodesicAreaHa(ring ?? []);
    return ha > 0 ? ha : null;
  }
  if (geometry.type === 'MultiPolygon') {
    const ha = (geometry.coordinates as number[][][][]).reduce(
      (sum, polygon) => sum + geodesicAreaHa(polygon[0] ?? []),
      0,
    );
    return ha > 0 ? ha : null;
  }
  return null;
}

const FILTRO_OFICINA = `
      AND EXISTS (
          SELECT 1
          FROM custo.objetocusto b
          WHERE b.negocio = 3
            AND b.processo = 1
            AND b.subprocesso = 1
            AND a.cod_objetocusto = b.cod_objetocusto
      )
`;

const RESUMO_OFICINA_SQL = `
WITH custos AS (
    SELECT a.anomes, a.cod_objetocusto, a.cod_empenho, SUM(a.valor) AS valor
    FROM custo.lancamento_custo a
    WHERE a.tipo = 'R'
${FILTRO_OFICINA}
      AND a.anomes >= :anomesInicio
      AND a.anomes <= :anomesFim
    GROUP BY a.anomes, a.cod_objetocusto, a.cod_empenho
),
ordens AS (
    SELECT
        cod_equipamento,
        TO_CHAR(dtabertura, 'YYYYMM') AS anomes,
        SUM((NVL(dtencerramento, SYSDATE) - dtabertura) * 24) AS horas_os
    FROM automotivo.ordemservico
    WHERE dtencerramento IS NOT NULL
      AND dtabertura >= :dataInicio
      AND dtabertura < :dataFim
    GROUP BY cod_equipamento, TO_CHAR(dtabertura, 'YYYYMM')
),
horas_total AS (
    SELECT anomes, SUM(horas_os) AS horas_total
    FROM ordens
    GROUP BY anomes
),
rateio AS (
    SELECT
        c.anomes,
        o.cod_equipamento,
        o.horas_os,
        ht.horas_total,
        o.horas_os / ht.horas_total AS percentual_rateio,
        c.valor * (o.horas_os / ht.horas_total) AS custo_rateado
    FROM custos c
    INNER JOIN ordens o ON o.anomes = c.anomes
    INNER JOIN horas_total ht ON ht.anomes = o.anomes
    WHERE ht.horas_total > 0
      AND INSTR(',' || :equipamentosCsv || ',', ',' || TO_CHAR(o.cod_equipamento) || ',') > 0
)
SELECT
    anomes,
    cod_equipamento,
    MAX(horas_os) AS horas_os,
    MAX(percentual_rateio) AS percentual_rateio,
    SUM(custo_rateado) AS custo_rateado
FROM rateio
GROUP BY anomes, cod_equipamento
`;

/** Equipamentos que apontaram neste talhão — filtro barato antes do abastecimento. */
const EQUIP_TALHAO_SQL = `
SELECT DISTINCT cod_equipamento
FROM automotivo.itens_apontamento
WHERE cod_fazenda = :codFazenda
  AND cod_talhao = :codTalhao
  AND dt_apontamento >= ADD_MONTHS(:dataInicio, -2)
  AND dt_apontamento < :dataFim
  AND cod_equipamento IS NOT NULL
`;

/**
 * Abastecimento só dos equipamentos do talhão.
 * Operação agrícola fica em consulta separada (OPERACOES_TALHAO_SQL).
 * kmhs_total = horas do equipamento no mês (todos os talhões) para o rateio.
 */
const ATIVIDADE_TALHAO_SQL = `
WITH custoMedioMaterial AS (
    SELECT cod_grupoempresa, cod_material, ano, mes, AVG(custo_medio) AS custo_medio
    FROM material.customedio
    GROUP BY cod_grupoempresa, cod_material, ano, mes
),
abastecimentos AS (
    SELECT
        a.cod_equipamento,
        a.dtabastecimento AS data_abastecimento,
        a.qtdelitros AS qtde_litros,
        a.kmhs_rodados,
        (a.qtdelitros * NVL(cm.custo_medio, 0)) AS valor_total
    FROM automotivo.abastecimento a
    LEFT JOIN custoMedioMaterial cm
        ON cm.cod_grupoempresa = a.cod_grupoempresa
       AND cm.cod_material = a.cod_material
       AND cm.ano = EXTRACT(YEAR FROM a.dtabastecimento)
       AND cm.mes = EXTRACT(MONTH FROM a.dtabastecimento)
    WHERE a.dtabastecimento >= :dataInicio
      AND a.dtabastecimento < :dataFim
      AND INSTR(',' || :equipamentosCsv || ',', ',' || TO_CHAR(a.cod_equipamento) || ',') > 0
    UNION ALL
    SELECT
        a.cod_equipamento,
        a.data AS data_abastecimento,
        a.qtde_litros,
        a.kmhs_rodados,
        (a.qtde_litros * NVL(cm.custo_medio, 0)) AS valor_total
    FROM posto.abastecimento a
    LEFT JOIN custoMedioMaterial cm
        ON cm.cod_grupoempresa = a.cod_grupoempresa
       AND cm.cod_material = a.cod_material
       AND cm.ano = EXTRACT(YEAR FROM a.data)
       AND cm.mes = EXTRACT(MONTH FROM a.data)
    WHERE a.data >= :dataInicio
      AND a.data < :dataFim
      AND INSTR(',' || :equipamentosCsv || ',', ',' || TO_CHAR(a.cod_equipamento) || ',') > 0
),
detalhe AS (
    SELECT
        TO_CHAR(a.data_abastecimento, 'YYYYMM') AS anomes,
        a.cod_equipamento,
        NVL(a.kmhs_rodados, 0) AS kmhs_rodados,
        NVL(a.qtde_litros, 0) AS qtde_litros,
        NVL(a.valor_total, 0) AS valor_abastecimento,
        b.cod_fazenda,
        b.cod_talhao,
        SUM(NVL(a.kmhs_rodados, 0)) OVER (
            PARTITION BY TO_CHAR(a.data_abastecimento, 'YYYYMM'), a.cod_equipamento
        ) AS kmhs_total
    FROM abastecimentos a
    LEFT JOIN LATERAL (
        SELECT ap.cod_fazenda, ap.cod_talhao
        FROM automotivo.itens_apontamento ap
        WHERE ap.cod_equipamento = a.cod_equipamento
          AND ap.dt_apontamento <= a.data_abastecimento
        ORDER BY ap.dt_apontamento DESC
        FETCH FIRST 1 ROW ONLY
    ) b ON 1 = 1
)
SELECT
    anomes,
    cod_equipamento,
    SUM(kmhs_rodados) AS kmhs_rodados,
    SUM(qtde_litros) AS qtde_litros,
    SUM(valor_abastecimento) AS valor_abastecimento,
    MAX(kmhs_total) AS kmhs_total
FROM detalhe
WHERE cod_fazenda = :codFazenda
  AND cod_talhao = :codTalhao
  AND cod_equipamento IS NOT NULL
GROUP BY anomes, cod_equipamento
`;

/** Operações do talhão no período — mesma chave (fazenda, talhão, equipamentos) sem LATERAL no abastecimento. */
const OPERACOES_TALHAO_SQL = `
SELECT DISTINCT
    cod_equipamento,
    cod_operacaoagricola
FROM automotivo.itens_apontamento
WHERE cod_fazenda = :codFazenda
  AND cod_talhao = :codTalhao
  AND dt_apontamento >= :dataInicio
  AND dt_apontamento < :dataFim
  AND INSTR(',' || :equipamentosCsv || ',', ',' || TO_CHAR(cod_equipamento) || ',') > 0
  AND cod_operacaoagricola IS NOT NULL
`;

const INSUMO_TALHAO_SQL = `
WITH insumos AS (
    SELECT
        m.cod_material,
        m.quantidade,
        (m.quantidade * NVL(req.vrcustounitario, 0)) AS valor_total
    FROM agricola.apontamentomaterial m
    INNER JOIN agricola.apontamentoitem i
        ON i.cod_grupoempresa = m.cod_grupoempresa
       AND i.cod_empresa = m.cod_empresa
       AND i.cod_filial = m.cod_filial
       AND i.ano_apontamento = m.ano_apontamento
       AND i.nr_apontamento = m.nr_apontamento
       AND i.item_apontamento = m.item_apontamento
    INNER JOIN agricola.apontamento ap
        ON ap.cod_grupoempresa = m.cod_grupoempresa
       AND ap.cod_empresa = m.cod_empresa
       AND ap.cod_filial = m.cod_filial
       AND ap.ano_apontamento = m.ano_apontamento
       AND ap.nr_apontamento = m.nr_apontamento
    LEFT JOIN material.itensrequisicaomaterial req
        ON req.nrrequisicao = m.nrrequisicao
       AND req.cod_material = m.cod_material
       AND req.item = m.item_requisicao
    WHERE i.cod_fazenda = :codFazenda
      AND i.cod_talhao = :codTalhao
      AND ap.data_apontamento >= :dataInicio
      AND ap.data_apontamento < :dataFim
)
SELECT
    NVL(mat.cod_familia, 0) AS cod_familia,
    NVL(mat.cod_grupomaterial, 0) AS cod_grupomaterial,
    NVL(TRIM(gm.descricao), 'Sem grupo') AS grupo_descricao,
    i.cod_material,
    NVL(TRIM(mat.descricao), TO_CHAR(i.cod_material)) AS material_descricao,
    SUM(NVL(i.quantidade, 0)) AS quantidade,
    SUM(NVL(i.valor_total, 0)) AS custo_insumo
FROM insumos i
LEFT JOIN material.material mat
    ON mat.cod_material = i.cod_material
LEFT JOIN material.grupomaterial gm
    ON gm.cod_familia = mat.cod_familia
   AND gm.cod_grupomaterial = mat.cod_grupomaterial
GROUP BY
    NVL(mat.cod_familia, 0),
    NVL(mat.cod_grupomaterial, 0),
    NVL(TRIM(gm.descricao), 'Sem grupo'),
    i.cod_material,
    NVL(TRIM(mat.descricao), TO_CHAR(i.cod_material))
ORDER BY custo_insumo DESC
`;

const INSUMO_ATIVIDADE_SQL = `
SELECT
    NVL(i.cod_objetocusto, d.cod_objetocusto) AS cod_objetocusto,
    oc.atividade,
    TRIM(oc.descricao) AS atividade_descricao,
    m.cod_material,
    NVL(TRIM(mat.descricao), TO_CHAR(m.cod_material)) AS material_descricao,
    SUM(NVL(m.quantidade, 0)) AS quantidade,
    SUM(m.quantidade * NVL(req.vrcustounitario, 0)) AS custo_insumo
FROM agricola.apontamentomaterial m
INNER JOIN agricola.apontamentoitem i
    ON i.cod_grupoempresa = m.cod_grupoempresa
   AND i.cod_empresa = m.cod_empresa
   AND i.cod_filial = m.cod_filial
   AND i.ano_apontamento = m.ano_apontamento
   AND i.nr_apontamento = m.nr_apontamento
   AND i.item_apontamento = m.item_apontamento
INNER JOIN agricola.apontamento ap
    ON ap.cod_grupoempresa = m.cod_grupoempresa
   AND ap.cod_empresa = m.cod_empresa
   AND ap.cod_filial = m.cod_filial
   AND ap.ano_apontamento = m.ano_apontamento
   AND ap.nr_apontamento = m.nr_apontamento
LEFT JOIN material.itensrequisicaomaterial req
    ON req.nrrequisicao = m.nrrequisicao
   AND req.cod_material = m.cod_material
   AND req.item = m.item_requisicao
LEFT JOIN material.material mat
    ON mat.cod_material = m.cod_material
LEFT JOIN rh.operacaoobjetocusto d
    ON d.cod_operacaoagricola = i.cod_operacao
   AND d.data_termino IS NULL
LEFT JOIN custo.objetocusto oc
    ON oc.cod_objetocusto = NVL(i.cod_objetocusto, d.cod_objetocusto)
WHERE i.cod_fazenda = :codFazenda
  AND i.cod_talhao = :codTalhao
  AND ap.data_apontamento >= :dataInicio
  AND ap.data_apontamento < :dataFim
GROUP BY
    NVL(i.cod_objetocusto, d.cod_objetocusto),
    oc.atividade,
    TRIM(oc.descricao),
    m.cod_material,
    NVL(TRIM(mat.descricao), TO_CHAR(m.cod_material))
ORDER BY custo_insumo DESC
`;

const EQUIP_ATIVIDADE_SQL = `
SELECT
    ap.cod_equipamento,
    oc.atividade,
    TRIM(oc.descricao) AS atividade_descricao,
    d.cod_objetocusto,
    SUM(NVL(NULLIF(ap.tothoros_trabalhadas, 0), NVL(ap.dur_kmhs, 0))) AS horas
FROM automotivo.itens_apontamento ap
LEFT JOIN rh.operacaoobjetocusto d
    ON d.cod_operacaoagricola = ap.cod_operacaoagricola
   AND d.data_termino IS NULL
LEFT JOIN custo.objetocusto oc
    ON oc.cod_objetocusto = d.cod_objetocusto
WHERE ap.cod_fazenda = :codFazenda
  AND ap.cod_talhao = :codTalhao
  AND ap.dt_apontamento >= :dataInicio
  AND ap.dt_apontamento < :dataFim
  AND INSTR(',' || :equipamentosCsv || ',', ',' || TO_CHAR(ap.cod_equipamento) || ',') > 0
GROUP BY
    ap.cod_equipamento,
    oc.atividade,
    TRIM(oc.descricao),
    d.cod_objetocusto
`;

const TALHAO_FICHA_SQL = `
SELECT
    t.areaplantada,
    t.areaproducao,
    t.cod_variedade,
    v.descricao AS variedade,
    t.cod_tiposolo,
    s.descricao AS tipo_solo,
    s.descricaodetalhada AS tipo_solo_detalhe
FROM agricola.talhao t
LEFT JOIN agricola.variedade v
    ON v.cod_variedade = t.cod_variedade
LEFT JOIN agricola.tipo_solo s
    ON s.cod_tiposolo = t.cod_tiposolo
WHERE t.cod_fazenda = :codFazenda
  AND t.cod_talhao = :codTalhao
  AND ROWNUM = 1
`;

const MATERIAL_TALHAO_SQL = `
WITH req AS (
    SELECT
        a.nrrequisicao, a.item, a.cod_material, a.quantidade, a.vrcustounitario,
        a.dataretirada, a.cod_equipamento, a.cod_objetocusto AS objetocustorequisicao,
        (a.quantidade * NVL(a.vrcustounitario, 0)) AS valor_total
    FROM material.itensrequisicaomaterial a
    WHERE a.dataretirada IS NOT NULL
      AND a.dataretirada >= :dataInicio
      AND a.dataretirada < :dataFim
      AND INSTR(',' || :equipamentosCsv || ',', ',' || TO_CHAR(a.cod_equipamento) || ',') > 0
      AND NOT EXISTS (
          SELECT 1 FROM custo.objetocusto oc_oficina
          WHERE oc_oficina.cod_objetocusto = a.cod_objetocusto
            AND oc_oficina.negocio = 3 AND oc_oficina.processo = 1
      )
      AND NOT EXISTS (
          SELECT 1 FROM agricola.apontamentomaterial am
          WHERE am.nrrequisicao = a.nrrequisicao
            AND am.cod_material = a.cod_material
            AND am.item_requisicao = a.item
      )
      AND NOT EXISTS (
          SELECT 1
          FROM material.material mat
          INNER JOIN material.grupomaterial gm
              ON mat.cod_familia = gm.cod_familia
             AND mat.cod_grupomaterial = gm.cod_grupomaterial
          WHERE mat.cod_material = a.cod_material
            AND mat.cod_familia = 29
            AND mat.cod_grupomaterial IN (10, 11, 1, 4, 5)
      )
)
SELECT
    TO_CHAR(r.dataretirada, 'YYYYMM') AS anomes,
    r.cod_equipamento,
    SUM(NVL(r.valor_total, 0)) AS custo_material
FROM req r
LEFT JOIN LATERAL (
    SELECT ap.cod_fazenda, ap.cod_talhao
    FROM automotivo.itens_apontamento ap
    WHERE ap.cod_equipamento = r.cod_equipamento
      AND ap.dt_apontamento <= r.dataretirada
    ORDER BY ap.dt_apontamento DESC
    FETCH FIRST 1 ROW ONLY
) b ON 1 = 1
WHERE b.cod_fazenda = :codFazenda
  AND b.cod_talhao = :codTalhao
GROUP BY TO_CHAR(r.dataretirada, 'YYYYMM'), r.cod_equipamento
`;

async function consultarOracle(filtros: CustoTalhaoFiltros, periodo: { anomesInicio: string; anomesFim: string }): Promise<CustoTalhaoResponse> {
  const dataInicio = anomesParaDataInicio(periodo.anomesInicio);
  const dataFim = anomesParaDataFimExclusiva(periodo.anomesFim);
  const bindsTalhao = {
    dataInicio,
    dataFim,
    codFazenda: filtros.codigoFazenda,
    codTalhao: filtros.talhao,
  };

  const equipRows = await consultarSql(EQUIP_TALHAO_SQL, bindsTalhao);
  const equipamentosIds = [
    ...new Set(
      equipRows
        .map((row) => toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento')))
        .filter((v): v is number => v != null),
    ),
  ];
  const equipamentosCsv = equipamentosIds.length ? equipamentosIds.join(',') : null;

  const bindsEquip = {
    ...bindsTalhao,
    equipamentosCsv,
  };
  const bindsOficina = {
    dataInicio,
    dataFim,
    anomesInicio: periodo.anomesInicio,
    anomesFim: periodo.anomesFim,
    equipamentosCsv,
  };

  const bindsFicha = {
    codFazenda: filtros.codigoFazenda,
    codTalhao: filtros.talhao,
  };

  const [atividades, oficinaRows, materialRows, insumoRows, operacaoRows, descEquipRows, fichaRows, atividadeCustoRows, equipAtivRows] = await Promise.all([
    equipamentosCsv ? consultarSql(ATIVIDADE_TALHAO_SQL, bindsEquip) : Promise.resolve([]),
    equipamentosCsv ? consultarSql(RESUMO_OFICINA_SQL, bindsOficina) : Promise.resolve([]),
    equipamentosCsv ? consultarSql(MATERIAL_TALHAO_SQL, bindsEquip) : Promise.resolve([]),
    consultarSql(INSUMO_TALHAO_SQL, bindsTalhao),
    equipamentosCsv ? consultarSql(OPERACOES_TALHAO_SQL, bindsEquip) : Promise.resolve([]),
    equipamentosCsv
      ? consultarSql(
          `
          SELECT cod_equipamento, descricao
          FROM automotivo.equipamento
          WHERE INSTR(',' || :csv || ',', ',' || TO_CHAR(cod_equipamento) || ',') > 0
          `,
          { csv: equipamentosCsv },
        ).catch(() => [])
      : Promise.resolve([]),
    consultarSql(TALHAO_FICHA_SQL, bindsFicha).catch(() => []),
    consultarSql(INSUMO_ATIVIDADE_SQL, bindsTalhao).catch(() => []),
    equipamentosCsv ? consultarSql(EQUIP_ATIVIDADE_SQL, bindsEquip).catch(() => []) : Promise.resolve([]),
  ]);

  const ficha = parseFicha(fichaRows[0]);
  const areaHa =
    ficha?.areaHa && ficha.areaHa > 0
      ? ficha.areaHa
      : filtros.areaHa && filtros.areaHa > 0
        ? filtros.areaHa
        : areaHaDoGeoJson(filtros.codigoFazenda, filtros.talhao);

  const descEquip = new Map<number, string>();
  for (const row of descEquipRows) {
    const cod = toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento'));
    const desc = String(rowVal(row, 'DESCRICAO', 'descricao') ?? '').trim();
    if (cod != null) {
      descEquip.set(cod, desc);
    }
  }

  const kmhsTotal = new Map<string, number>();
  for (const row of atividades) {
    const anomes = String(rowVal(row, 'ANOMES', 'anomes') ?? '');
    const eq = toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento'));
    if (!anomes || eq == null) {
      continue;
    }
    kmhsTotal.set(`${anomes}|${eq}`, toNumber(rowVal(row, 'KMHS_TOTAL', 'kmhs_total')));
  }

    const oficinaPorEq = new Map<string, number>();
    for (const row of oficinaRows) {
      const anomes = String(rowVal(row, 'ANOMES', 'anomes') ?? '');
      const eq = toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento'));
      if (!anomes || eq == null) {
        continue;
      }
      oficinaPorEq.set(`${anomes}|${eq}`, toNumber(rowVal(row, 'CUSTO_RATEADO', 'custo_rateado')));
    }

    const materialPorEqMes = new Map<string, number>();
    for (const row of materialRows) {
      const anomes = String(rowVal(row, 'ANOMES', 'anomes') ?? '');
      const eq = toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento'));
      if (!anomes || eq == null) {
        continue;
      }
      const key = `${anomes}|${eq}`;
      materialPorEqMes.set(key, (materialPorEqMes.get(key) || 0) + toNumber(rowVal(row, 'CUSTO_MATERIAL', 'custo_material')));
    }

    const operacoesPorEq = new Map<number, Set<number>>();
    for (const row of operacaoRows) {
      const eq = toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento'));
      const operacao = toNullableNumber(rowVal(row, 'COD_OPERACAOAGRICOLA', 'cod_operacaoagricola'));
      if (eq == null || operacao == null) {
        continue;
      }
      const atual = operacoesPorEq.get(eq) ?? new Set<number>();
      atual.add(operacao);
      operacoesPorEq.set(eq, atual);
    }

    const porEquipamento = new Map<
      number,
      {
        horas: number;
        litros: number;
        custoOficina: number;
        custoCombustivel: number;
        custoMaterial: number;
        percentualPonderado: number;
        pesoHoras: number;
      }
    >();

    for (const row of atividades) {
      const anomes = String(rowVal(row, 'ANOMES', 'anomes') ?? '');
      const eq = toNullableNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento'));
      if (eq == null) {
        continue;
      }
      const key = `${anomes}|${eq}`;
      const kmhs = toNumber(rowVal(row, 'KMHS_RODADOS', 'kmhs_rodados'));
      const litros = toNumber(rowVal(row, 'QTDE_LITROS', 'qtde_litros'));
      const combustivel = toNumber(rowVal(row, 'VALOR_ABASTECIMENTO', 'valor_abastecimento'));
      const totalEq = kmhsTotal.get(key) || 0;
      const percentual = totalEq > 0 ? kmhs / totalEq : 0;
      const custoOficina = (oficinaPorEq.get(key) || 0) * percentual;
      const custoMaterial = materialPorEqMes.get(key) || 0;
      materialPorEqMes.delete(key);

      const atual = porEquipamento.get(eq) ?? {
        horas: 0,
        litros: 0,
        custoOficina: 0,
        custoCombustivel: 0,
        custoMaterial: 0,
        percentualPonderado: 0,
        pesoHoras: 0,
      };
      atual.horas += kmhs;
      atual.litros += litros;
      atual.custoOficina += custoOficina;
      atual.custoCombustivel += combustivel;
      atual.custoMaterial += custoMaterial;
      atual.percentualPonderado += percentual * kmhs;
      atual.pesoHoras += kmhs;
      porEquipamento.set(eq, atual);
    }

    for (const [key, custoMaterial] of materialPorEqMes.entries()) {
      const eq = Number(key.split('|')[1]);
      const atual = porEquipamento.get(eq);
      if (!atual) {
        continue;
      }
      atual.custoMaterial += custoMaterial;
    }

    const equipamentos: EquipamentoTalhao[] = [...porEquipamento.entries()]
      .map(([codEquipamento, dados]) => {
        const custoTotal = dados.custoOficina + dados.custoCombustivel + dados.custoMaterial;
        return {
          codEquipamento,
          descricao: descEquip.get(codEquipamento) ?? '',
          codOperacoes: [...(operacoesPorEq.get(codEquipamento) ?? [])].sort((a, b) => a - b),
          horas: dados.horas,
          litros: dados.litros,
          litrosPorHora: porHora(dados.litros, dados.horas),
          percentualRateio: dados.pesoHoras > 0 ? dados.percentualPonderado / dados.pesoHoras : 0,
          custoOficina: dados.custoOficina,
          custoCombustivel: dados.custoCombustivel,
          custoMaterial: dados.custoMaterial,
          custoTotal,
          custoPorHa: porHa(custoTotal, areaHa ?? null),
        };
      })
      .sort((a, b) => b.custoTotal - a.custoTotal);

    const gruposInsumo = new Map<string, GrupoInsumoTalhao>();
    for (const row of insumoRows) {
      const codMaterial = String(rowVal(row, 'COD_MATERIAL', 'cod_material') ?? '');
      if (!codMaterial) {
        continue;
      }
      const custo = toNumber(rowVal(row, 'CUSTO_INSUMO', 'custo_insumo'));
      const quantidade = toNumber(rowVal(row, 'QUANTIDADE', 'quantidade'));
      const codFamilia = toNumber(rowVal(row, 'COD_FAMILIA', 'cod_familia'));
      const codGrupoMaterial = toNumber(rowVal(row, 'COD_GRUPOMATERIAL', 'cod_grupomaterial'));
      const grupoDescricao = String(rowVal(row, 'GRUPO_DESCRICAO', 'grupo_descricao') ?? 'Sem grupo').trim() || 'Sem grupo';
      const materialDescricao = String(
        rowVal(row, 'MATERIAL_DESCRICAO', 'material_descricao') ?? `Material ${codMaterial}`,
      ).trim();
      const chave = `${codFamilia}|${codGrupoMaterial}|${grupoDescricao}`;
      const item: InsumoTalhao = {
        codMaterial,
        descricao: materialDescricao || `Material ${codMaterial}`,
        quantidade,
        dosePorHa: porHa(quantidade, areaHa ?? null),
        custo,
        custoPorHa: porHa(custo, areaHa ?? null),
      };
      const grupo = gruposInsumo.get(chave) ?? {
        codFamilia,
        codGrupoMaterial,
        descricao: grupoDescricao,
        quantidade: 0,
        dosePorHa: null,
        custo: 0,
        custoPorHa: null,
        itens: [],
      };
      grupo.quantidade += quantidade;
      grupo.custo += custo;
      grupo.itens.push(item);
      gruposInsumo.set(chave, grupo);
    }

    const insumos: GrupoInsumoTalhao[] = [...gruposInsumo.values()]
      .map((grupo) => ({
        ...grupo,
        itens: grupo.itens.sort((a, b) => b.custo - a.custo),
        dosePorHa: porHa(grupo.quantidade, areaHa ?? null),
        custoPorHa: porHa(grupo.custo, areaHa ?? null),
      }))
      .sort((a, b) => b.custo - a.custo);

    const atividadesCusto = montarAtividades(atividadeCustoRows, equipAtivRows, equipamentos, areaHa ?? null);

    const custoInsumo = insumos.reduce((acc, item) => acc + item.custo, 0);
    const custoEquipamento = equipamentos.reduce((acc, item) => acc + item.custoTotal, 0);
    const qtdMateriais = insumos.reduce((acc, grupo) => acc + grupo.itens.length, 0);
    console.log(
      `Custos talhão ${filtros.codigoFazenda}/${filtros.talhao}: ${insumos.length} grupos, ${qtdMateriais} materiais, ${atividadesCusto.length} atividades`,
    );

    return {
      origem: 'oracle',
      codigoFazenda: filtros.codigoFazenda,
      talhao: filtros.talhao,
      periodo,
      areaHa: areaHa ?? null,
      ficha,
      rendimento: {
        custoInsumo,
        custoEquipamento,
        custoTotal: custoInsumo + custoEquipamento,
        custoInsumoPorHa: porHa(custoInsumo, areaHa ?? null),
        custoEquipamentoPorHa: porHa(custoEquipamento, areaHa ?? null),
        custoTotalPorHa: porHa(custoInsumo + custoEquipamento, areaHa ?? null),
      },
      insumos,
      equipamentos,
      atividades: atividadesCusto,
      logica: LOGICA,
    };
}

const cacheCustos = new Map<string, { at: number; data: CustoTalhaoResponse }>();
const CACHE_MS = 90_000;

export function limparCacheCustos() {
  cacheCustos.clear();
}

export async function consultarCustosTalhao(filtros: CustoTalhaoFiltros): Promise<CustoTalhaoResponse> {
  const padrao = periodoPadrao();
  const periodo = {
    anomesInicio: filtros.anomesInicio && /^\d{6}$/.test(filtros.anomesInicio) ? filtros.anomesInicio : padrao.anomesInicio,
    anomesFim: filtros.anomesFim && /^\d{6}$/.test(filtros.anomesFim) ? filtros.anomesFim : padrao.anomesFim,
  };

  await sincronizarConexaoBancoOrds();
  if (!oracleCredenciaisPreenchidas()) {
    throw new Error(
      'Nenhuma conexão ativa em conexao_banco. O admin precisa salvar host, usuário e senha na tela Oracle.',
    );
  }

  const chave = `ativ-v2|${filtros.codigoFazenda}|${filtros.talhao}|${periodo.anomesInicio}|${periodo.anomesFim}`;
  const cached = cacheCustos.get(chave);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.data;
  }

  const data = await consultarOracle(filtros, periodo);
  cacheCustos.set(chave, { at: Date.now(), data });
  return data;
}
