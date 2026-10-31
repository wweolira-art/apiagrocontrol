/**
 * Lançamento de perdas de colheita — integração CSINTEGRACAO.
 * Tipos de amostra = agricola.tipo_corte; tipos de perda = agricola.tipo_perdacolheita
 * filtrados por agricola.historico_tipoperda (manual vs mecanizado).
 */

import { consultarSql, withOraclePerdas } from './oracle.ts';

function rowVal(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
    const upper = key.toUpperCase();
    if (row[upper] !== undefined && row[upper] !== null) {
      return row[upper];
    }
    const lower = key.toLowerCase();
    if (row[lower] !== undefined && row[lower] !== null) {
      return row[lower];
    }
  }
  return null;
}

function toNumber(val: unknown): number | null {
  if (val == null || val === '') {
    return null;
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function toStr(val: unknown): string {
  return val == null ? '' : String(val).trim();
}

export interface TipoCorteCadastro {
  codTipocorte: number;
  descricao: string;
}

export interface TipoPerdaCadastro {
  codTipoperda: number;
  descricao: string;
  codTipocorte: number;
}

export interface FrenteCadastro {
  codFrente: number;
  descricao: string;
}

export interface EquipamentoCadastro {
  codEquipamento: number;
  descricao: string;
}

export interface OperadorCadastro {
  codOperador: number;
  nome: string;
}

export interface TalhaoPerdaCadastro {
  codFazenda: number;
  codTalhao: number;
  zona: number;
  areaHa: number | null;
  descricao: string;
  codSafra: number;
  codSafradetalhe: number;
}

export interface FazendaPerdaCadastro {
  codFazenda: number;
  nome: string;
}

export interface ParametrosPerdaCadastro {
  areaAmostraMecanizada: number;
  areaAmostraManual: number;
  metaMecanizada: number;
  metaManual: number;
  codGrupoempresa: number;
  codEmpresa: number;
  codFilial: number;
}

export interface CadastrosPerda {
  fazendas: FazendaPerdaCadastro[];
  talhoes: TalhaoPerdaCadastro[];
  tiposCorte: TipoCorteCadastro[];
  tiposPerda: TipoPerdaCadastro[];
  frentes: FrenteCadastro[];
  equipamentos: EquipamentoCadastro[];
  operadores: OperadorCadastro[];
  parametros: ParametrosPerdaCadastro;
}

export interface PerdaItemEntrada {
  codTipoperda: number;
  quantidade: number;
}

export interface PerdaEntrada {
  codTipocorte: number;
  codFazenda: number;
  codTalhao: number;
  zona?: number;
  codSafra?: number;
  codSafradetalhe?: number;
  dataAmostra?: string;
  turno?: string;
  codFrente?: number | null;
  codEquipamento?: number | null;
  codOperador?: number | null;
  codAgenciador?: number | null;
  codTipocana?: number | null;
  codObservacaoPerda?: number | null;
  numeroOrdem?: number | null;
  tipoOperador?: string;
  bituca?: string;
  latitude?: string | null;
  longitude?: string | null;
  itens: PerdaItemEntrada[];
}

function outNumber(result: { outBinds?: Record<string, unknown> }, key: string): number | null {
  const value = result.outBinds?.[key] ?? result.outBinds?.[key.toUpperCase()] ?? result.outBinds?.[key.toLowerCase()];
  return toNumber(Array.isArray(value) ? value[0] : value);
}

export interface PerdaGravada {
  numeroAmostra: number;
  codSafra: number;
  itens: number;
}

const PARAMETROS_PADRAO: ParametrosPerdaCadastro = {
  areaAmostraMecanizada: 10,
  areaAmostraManual: 10,
  metaMecanizada: 3.5,
  metaManual: 2.5,
  codGrupoempresa: 1,
  codEmpresa: 1,
  codFilial: 1,
};

const TIPOS_CORTE_PADRAO: TipoCorteCadastro[] = [
  { codTipocorte: 1, descricao: 'Manual' },
  { codTipocorte: 2, descricao: 'Mecanizado' },
];

const FAZENDAS_SQL = `
SELECT f.cod_fazenda, TRIM(f.descricao) AS nome
  FROM agricola.fazenda f
 WHERE f.cod_fazenda > 0
 ORDER BY TRIM(f.descricao)
`;

const TALHOES_SQL = `
SELECT cod_fazenda, cod_talhao, zona, area_ha, descricao, cod_safra, cod_safradetalhe
  FROM (
    SELECT t.cod_fazenda, t.cod_talhao, NVL(t.zona, 1) AS zona,
           NVL(t.areaplantada, t.areaproducao) AS area_ha,
           TRIM(NVL(t.descricao_talhao, TO_CHAR(t.cod_talhao))) AS descricao,
           t.cod_safra,
           NVL(t.cod_safradetalhe, t.cod_safra) AS cod_safradetalhe,
           ROW_NUMBER() OVER (
             PARTITION BY t.cod_fazenda, t.cod_talhao
             ORDER BY t.cod_safra DESC NULLS LAST,
                      NVL(t.areaplantada, t.areaproducao) DESC NULLS LAST
           ) AS rn
      FROM agricola.talhao t
     WHERE t.cod_fazenda > 0
       AND NVL(t.encerrado, 'N') <> 'S'
  )
 WHERE rn = 1
 ORDER BY cod_fazenda, cod_talhao
`;

const TIPOS_CORTE_SQL = `
SELECT t.cod_tipocorte, TRIM(t.descricao) AS descricao
  FROM agricola.tipo_corte t
 ORDER BY t.cod_tipocorte
`;

const TIPOS_PERDA_SQL = `
SELECT h.cod_tipoperda,
       TRIM(tp.descricao) AS descricao,
       h.cod_tipocorte
  FROM agricola.historico_tipoperda h
  JOIN agricola.tipo_perdacolheita tp ON tp.cod_tipoperda = h.cod_tipoperda
 WHERE h.datafim IS NULL
 ORDER BY h.cod_tipocorte, h.sequencia, h.cod_tipoperda
`;

const FRENTES_SQL = `
SELECT f.cod_frente, TRIM(f.descricao) AS descricao
  FROM agricola.frente f
 WHERE NVL(f.ativo, 'S') = 'S'
 ORDER BY f.cod_frente
`;

const EQUIPAMENTOS_SQL = `
SELECT e.cod_equipamento, TRIM(e.descricao) AS descricao
  FROM automotivo.equipamento e
 WHERE e.cod_grupoempresa = 1
   AND NVL(e.ativo, 'S') = 'S'
   AND NVL(e.bloqueado, 'N') <> 'S'
   AND (
     e.cod_classificacao = 25
     OR UPPER(e.descricao) LIKE '%COLHEIT%'
     OR EXISTS (
       SELECT 1 FROM agricola.perdas p WHERE p.cod_equipamento = e.cod_equipamento
     )
   )
 ORDER BY e.cod_equipamento
`;

const OPERADORES_SQL = `
SELECT s.cdgfuncionario AS cod_operador,
       TRIM(s.cscfuncionario) AS nome
  FROM agricola.sga_funcionario s
 WHERE s.idnativo = 'S'
   AND TRIM(s.cscfuncionario) IS NOT NULL
 ORDER BY TRIM(s.cscfuncionario)
`;

const PARAMETROS_SQL = `
SELECT areaamostra_mecanizada, areaamostra_manual, meta_mecanizada, meta_manual,
       NVL(cod_grupoempresa, 1) AS cod_grupoempresa,
       NVL(cod_empresa, 1) AS cod_empresa,
       NVL(cod_filial, 1) AS cod_filial
  FROM agricola.parametros_perda
 WHERE datatermino IS NULL
   AND ROWNUM = 1
`;

function uniqTalhoes(talhoes: TalhaoPerdaCadastro[]): TalhaoPerdaCadastro[] {
  const porChave = new Map<string, TalhaoPerdaCadastro>();
  for (const talhao of talhoes) {
    const chave = `${talhao.codFazenda}-${talhao.codTalhao}`;
    const atual = porChave.get(chave);
    if (!atual || talhao.codSafra > atual.codSafra) {
      porChave.set(chave, talhao);
    }
  }
  return [...porChave.values()];
}

export async function listarCadastrosPerda(): Promise<CadastrosPerda> {
  const [fazRows, talRows, corteRows, tipoRows, frenteRows, equipRows, opRows, paramRows] = await Promise.all([
    consultarSql(FAZENDAS_SQL),
    consultarSql(TALHOES_SQL),
    consultarSql(TIPOS_CORTE_SQL).catch(() => []),
    consultarSql(TIPOS_PERDA_SQL).catch(() => []),
    consultarSql(FRENTES_SQL).catch(() => []),
    consultarSql(EQUIPAMENTOS_SQL).catch(() => []),
    consultarSql(OPERADORES_SQL).catch(() => []),
    consultarSql(PARAMETROS_SQL).catch(() => []),
  ]);

  const tiposCorte = corteRows
    .map((row) => ({
      codTipocorte: toNumber(rowVal(row, 'COD_TIPOCORTE', 'cod_tipocorte')) ?? 0,
      descricao: toStr(rowVal(row, 'DESCRICAO', 'descricao')),
    }))
    .filter((t) => t.codTipocorte > 0);

  const tiposPerda = tipoRows
    .map((row) => ({
      codTipoperda: toNumber(rowVal(row, 'COD_TIPOPERDA', 'cod_tipoperda')) ?? 0,
      descricao: toStr(rowVal(row, 'DESCRICAO', 'descricao')),
      codTipocorte: toNumber(rowVal(row, 'COD_TIPOCORTE', 'cod_tipocorte')) ?? 0,
    }))
    .filter((t) => t.codTipoperda > 0 && t.codTipocorte > 0);

  const param = paramRows[0];

  return {
    fazendas: fazRows
      .map((row) => ({
        codFazenda: toNumber(rowVal(row, 'COD_FAZENDA', 'cod_fazenda')) ?? 0,
        nome: toStr(rowVal(row, 'NOME', 'nome')),
      }))
      .filter((f) => f.codFazenda > 0),
    talhoes: uniqTalhoes(
      talRows
        .map((row) => ({
          codFazenda: toNumber(rowVal(row, 'COD_FAZENDA', 'cod_fazenda')) ?? 0,
          codTalhao: toNumber(rowVal(row, 'COD_TALHAO', 'cod_talhao')) ?? 0,
          zona: toNumber(rowVal(row, 'ZONA', 'zona')) ?? 1,
          areaHa: toNumber(rowVal(row, 'AREA_HA', 'area_ha')),
          descricao: toStr(rowVal(row, 'DESCRICAO', 'descricao')),
          codSafra: toNumber(rowVal(row, 'COD_SAFRA', 'cod_safra')) ?? 0,
          codSafradetalhe:
            toNumber(rowVal(row, 'COD_SAFRADETALHE', 'cod_safradetalhe')) ??
            toNumber(rowVal(row, 'COD_SAFRA', 'cod_safra')) ??
            0,
        }))
        .filter((t) => t.codFazenda > 0 && t.codTalhao > 0 && t.codSafra > 0),
    ),
    tiposCorte: tiposCorte.length > 0 ? tiposCorte : TIPOS_CORTE_PADRAO,
    tiposPerda,
    frentes: frenteRows
      .map((row) => ({
        codFrente: toNumber(rowVal(row, 'COD_FRENTE', 'cod_frente')) ?? 0,
        descricao: toStr(rowVal(row, 'DESCRICAO', 'descricao')),
      }))
      .filter((f) => f.codFrente > 0),
    equipamentos: equipRows
      .map((row) => ({
        codEquipamento: toNumber(rowVal(row, 'COD_EQUIPAMENTO', 'cod_equipamento')) ?? 0,
        descricao: toStr(rowVal(row, 'DESCRICAO', 'descricao')),
      }))
      .filter((e) => e.codEquipamento > 0),
    operadores: opRows
      .map((row) => ({
        codOperador: toNumber(rowVal(row, 'COD_OPERADOR', 'cod_operador')) ?? 0,
        nome: toStr(rowVal(row, 'NOME', 'nome')),
      }))
      .filter((o) => o.codOperador > 0 && o.nome),
    parametros: param
      ? {
          areaAmostraMecanizada: toNumber(rowVal(param, 'AREAAMOSTRA_MECANIZADA')) ?? 10,
          areaAmostraManual: toNumber(rowVal(param, 'AREAAMOSTRA_MANUAL')) ?? 10,
          metaMecanizada: toNumber(rowVal(param, 'META_MECANIZADA')) ?? 3.5,
          metaManual: toNumber(rowVal(param, 'META_MANUAL')) ?? 2.5,
          codGrupoempresa: toNumber(rowVal(param, 'COD_GRUPOEMPRESA')) ?? 1,
          codEmpresa: toNumber(rowVal(param, 'COD_EMPRESA')) ?? 1,
          codFilial: toNumber(rowVal(param, 'COD_FILIAL')) ?? 1,
        }
      : PARAMETROS_PADRAO,
  };
}

function mensagemOracle(erro: unknown): string {
  const texto = erro instanceof Error ? erro.message : String(erro);
  if (/ORA-00942/i.test(texto)) {
    return 'CSCLIENTE não tem INSERT nas tabelas CSINTEGRACAO de perdas. Rode scripts/grant-perdas-integracao.sql no Oracle (schema CSINTEGRACAO).';
  }
  return texto;
}

export async function gravarPerdaColheita(entrada: PerdaEntrada): Promise<PerdaGravada> {
  if (!entrada.codFazenda || !entrada.codTalhao) {
    throw new Error('Informe fazenda e talhão.');
  }
  if (entrada.codTipocorte !== 1 && entrada.codTipocorte !== 2) {
    throw new Error('Informe o tipo de amostra (Manual ou Mecanizado).');
  }
  if (!Array.isArray(entrada.itens) || entrada.itens.length === 0) {
    throw new Error('Informe as quantidades dos tipos de perda.');
  }

  const cadastros = await listarCadastrosPerda();
  const talhao = cadastros.talhoes.find(
    (item) => item.codFazenda === entrada.codFazenda && item.codTalhao === entrada.codTalhao,
  );
  const parametros = cadastros.parametros;
  const mecanizado = entrada.codTipocorte === 2;
  const tiposDoCorte = cadastros.tiposPerda.filter((t) => t.codTipocorte === entrada.codTipocorte);
  const tiposValidos = new Set(
    (tiposDoCorte.length > 0 ? tiposDoCorte : cadastros.tiposPerda).map((t) => t.codTipoperda),
  );

  const itens = entrada.itens
    .map((item) => ({
      codTipoperda: Number(item.codTipoperda),
      quantidade: Number(item.quantidade) || 0,
    }))
    .filter((item) => item.quantidade > 0)
    .filter((item) => tiposValidos.has(item.codTipoperda) || tiposValidos.size === 0);

  if (itens.length === 0) {
    throw new Error('Informe ao menos um tipo de perda válido com quantidade maior que zero.');
  }

  const grupo = parametros.codGrupoempresa;
  const empresa = parametros.codEmpresa;
  const filial = parametros.codFilial;
  const zona = entrada.zona ?? talhao?.zona ?? 1;
  const codSafra = entrada.codSafra ?? talhao?.codSafra;
  const codSafradetalhe = entrada.codSafradetalhe ?? talhao?.codSafradetalhe ?? codSafra;
  if (!codSafra || !codSafradetalhe) {
    throw new Error('O talhão não tem safra cadastrada.');
  }

  const dataRef = entrada.dataAmostra ? new Date(entrada.dataAmostra) : new Date();
  const turno = (entrada.turno ?? 'T').toUpperCase().slice(0, 1);
  const bituca = (entrada.bituca ?? 'N').toUpperCase().slice(0, 1) === 'S' ? 'S' : 'N';
  const areaAmostra = mecanizado ? parametros.areaAmostraMecanizada : parametros.areaAmostraManual;
  const tipoOperador = (entrada.tipoOperador ?? (entrada.codOperador ? 'F' : 'T')).toUpperCase().slice(0, 1);
  const codEquipamento = entrada.codEquipamento && entrada.codEquipamento > 0 ? entrada.codEquipamento : null;
  const codAgenciador = entrada.codAgenciador && entrada.codAgenciador > 0 ? entrada.codAgenciador : null;
  if ((codEquipamento && codAgenciador) || (!codEquipamento && !codAgenciador)) {
    throw new Error('Informe equipamento ou agenciador para a importação de perdas, mas não os dois.');
  }
  const codTipocana = entrada.codTipocana && entrada.codTipocana > 0 ? entrada.codTipocana : 2;

  return withOraclePerdas(async (connection, driver) => {
    try {
      const header = await connection.execute(
        `INSERT INTO csintegracao.cs_agr_perdascolheita (
           cod_grupoempresa, cod_empresa, cod_filial, cod_safra,
           data_amostra, area_amostra, cod_fazenda, cod_talhao, zona,
           cod_frente, cod_tipocorte, cod_equipamento, cod_agenciador,
           turno, cod_operador, tipo_operador, bituca, cod_tipocana,
           cod_observacaoperda, numero_ordem, latitude, longitude, id_origem
         ) VALUES (
           :grupo, :empresa, :filial, :safra,
           TRUNC(:dataAmostra), :area, :codFazenda, :codTalhao, :zona,
           :codFrente, :codTipocorte, :codEquipamento, :codAgenciador,
           :turno, :codOperador, :tipoOperador, :bituca, :codTipocana,
           :codObservacaoPerda, :numeroOrdem, :latitude, :longitude, :idOrigem
         )
         RETURNING id_perdascol INTO :idPerdascol`,
        {
          grupo,
          empresa,
          filial,
          safra: codSafra,
          dataAmostra: dataRef,
          area: areaAmostra,
          codFazenda: entrada.codFazenda,
          codTalhao: entrada.codTalhao,
          zona,
          codFrente: entrada.codFrente && entrada.codFrente > 0 ? entrada.codFrente : null,
          codTipocorte: entrada.codTipocorte,
          codEquipamento,
          codAgenciador,
          turno,
          codOperador: entrada.codOperador && entrada.codOperador > 0 ? entrada.codOperador : null,
          tipoOperador,
          bituca,
          codTipocana,
          codObservacaoPerda:
            entrada.codObservacaoPerda && entrada.codObservacaoPerda > 0 ? entrada.codObservacaoPerda : null,
          numeroOrdem: entrada.numeroOrdem && entrada.numeroOrdem > 0 ? entrada.numeroOrdem : null,
          latitude: entrada.latitude ? String(entrada.latitude).slice(0, 20) : null,
          longitude: entrada.longitude ? String(entrada.longitude).slice(0, 20) : null,
          idOrigem: codSafradetalhe,
          idPerdascol: { dir: driver.BIND_OUT, type: driver.NUMBER },
        },
        { autoCommit: false },
      );
      const idPerdascol = outNumber(header, 'idPerdascol');
      if (!idPerdascol) {
        throw new Error('Não foi possível recuperar o ID gerado da perda.');
      }

      for (const item of itens) {
        await connection.execute(
          `INSERT INTO csintegracao.cs_agr_perdas_itens (
             id_perdascol, cod_tipoperda, quantidade
           ) VALUES (
             :idPerdascol, :codTipoperda, :quantidade
           )`,
          {
            idPerdascol,
            codTipoperda: item.codTipoperda,
            quantidade: item.quantidade,
          },
          { autoCommit: false },
        );
      }

      await connection.commit();
      return { numeroAmostra: idPerdascol, codSafra, itens: itens.length };
    } catch (erro) {
      try {
        await connection.rollback();
      } catch {
        /* ignore */
      }
      throw new Error(mensagemOracle(erro));
    }
  });
}
