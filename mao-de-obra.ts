import { consultarSqlGravacao, withOracleGravacao } from './oracle.ts';

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

export interface MaoDeObraEntrada {
  codAgenciador: number;
  codGrupoempresaTurma: number;
  codFuncionario: number;
  codFazenda: number;
  codTalhao: number;
  codOperacao: number;
  dataApontamento: string;
  quantidade: number;
  observacao?: string;
  logon?: string;
}

export async function listarTurmasMaoDeObra() {
  const rows = await consultarSqlGravacao(`
    SELECT a.cod_grupoempresa, a.cod_agenciador,
           COALESCE(TRIM(pf.nome), TRIM(pe.nome), TRIM(f.nomefantasia)) AS descricao
      FROM rh.agenciador a
      LEFT JOIN material.fornecedor f ON f.cod_fornecedor = a.cod_fornecedor
      LEFT JOIN rh.pessoa pf ON pf.cod_pessoa = f.cod_pessoa
      LEFT JOIN rh.funcionario e ON e.cod_grupoempresa = a.cod_grupoempresa
        AND e.cod_funcionario = a.cod_funcionario
      LEFT JOIN rh.fisica fi ON fi.cpf = e.cpf
      LEFT JOIN rh.pessoa pe ON pe.cod_pessoa = fi.cod_pessoa
     ORDER BY a.cod_grupoempresa, a.cod_agenciador`);
  return rows.map(row => ({
    codGrupoempresa: toNumber(rowVal(row, 'COD_GRUPOEMPRESA')),
    codAgenciador: toNumber(rowVal(row, 'COD_AGENCIADOR')),
    descricao: toStr(rowVal(row, 'DESCRICAO')),
  })).filter(row => row.codGrupoempresa != null && row.codAgenciador != null);
}

export const SQL_SERVICOS_MAO_DE_OBRA = `
  SELECT i.cod_itemtabelapreco AS cod_atividade, TRIM(s.descricao) AS descricao,
         t.cod_tabelapreco, i.valor AS valor_unitario
    FROM agricola.fazenda f
    JOIN rh.tabelapreco t ON t.cod_grupoempresa = NVL(f.cod_grupoempresa, 1) AND t.cod_empresa = NVL(f.cod_empresa, 1)
    JOIN rh.itemtabelapreco i ON i.cod_grupoempresa = t.cod_grupoempresa
      AND i.cod_empresa = t.cod_empresa AND i.cod_tabelapreco = t.cod_tabelapreco
    JOIN rh.tiposervico s ON s.cod_tiposervico = i.cod_tiposervico
   WHERE f.cod_fazenda = :codFazenda
     AND t.cod_tabelapreco = (
       SELECT cod_tabelapreco FROM (
         SELECT p.cod_tabelapreco FROM rh.tabelapreco p
          WHERE p.cod_grupoempresa = NVL(f.cod_grupoempresa, 1) AND p.cod_empresa = NVL(f.cod_empresa, 1)
            AND p.datainicio <= TO_DATE(:dataApontamento, 'FXYYYY-MM-DD')
            AND (p.datafinal IS NULL OR p.datafinal >= TO_DATE(:dataApontamento, 'FXYYYY-MM-DD'))
          ORDER BY p.datainicio DESC, p.cod_tabelapreco DESC
       ) WHERE ROWNUM = 1
     )
   ORDER BY TRIM(s.descricao), i.cod_itemtabelapreco`;

export async function listarServicosMaoDeObra(codFazenda: number, dataApontamento: string): Promise<Array<{ codAtividade: number; descricao: string; codTabelaPreco: number; valorUnitario: number | null }>> {
  if (!Number.isSafeInteger(codFazenda) || codFazenda <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dataApontamento)) {
    throw new Error('Informe fazenda e data para consultar os serviços e preços.');
  }
  const rows = await consultarSqlGravacao(SQL_SERVICOS_MAO_DE_OBRA, { codFazenda, dataApontamento });
  return rows.map((row) => ({
    codAtividade: toNumber(rowVal(row, 'COD_ATIVIDADE', 'cod_atividade')) ?? 0,
    descricao: toStr(rowVal(row, 'DESCRICAO', 'descricao')),
    codTabelaPreco: toNumber(rowVal(row, 'COD_TABELAPRECO')) ?? 0,
    valorUnitario: toNumber(rowVal(row, 'VALOR_UNITARIO')),
  })).filter((item) => item.codAtividade > 0 && item.descricao);
}
/** Grava os dados operacionais na tabela de integração de mão de obra. */
export async function gravarMaoDeObra(entrada: MaoDeObraEntrada): Promise<{ mensagem: string }> {
  if (![entrada.codAgenciador, entrada.codGrupoempresaTurma].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Selecione a turma do lançamento.');
  }
  if (![entrada.codFuncionario, entrada.codFazenda, entrada.codTalhao, entrada.codOperacao].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('Selecione funcionário, fazenda, talhão e serviço.');
  }
  if (entrada.quantidade !== 1) {
    throw new Error('A quantidade deste lançamento é fixa em 1.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entrada.dataApontamento)) throw new Error('Informe uma data válida (AAAA-MM-DD).');
  const [ano, mes, dia] = entrada.dataApontamento.split('-').map(Number);
  const data = new Date(ano, mes - 1, dia);
  if (data.getFullYear() !== ano || data.getMonth() !== mes - 1 || data.getDate() !== dia) {
    throw new Error('Informe uma data válida.');
  }

  try {
    await withOracleGravacao(async (connection, driver) => {
      try {
        const result = await connection.execute(
          'SELECT CSCLIENTE.SEQ_APONTAMENTO_APP.NEXTVAL AS id_apont FROM dual',
          {},
          { outFormat: driver.OUT_FORMAT_OBJECT },
        );
        const idApont = toNumber(rowVal(result.rows?.[0] ?? {}, 'ID_APONT', 'id_apont'));
        if (!idApont) throw new Error('Não foi possível gerar ID_APONT para o lançamento.');
      const contextoResult = await connection.execute(
        `SELECT NVL(f.cod_grupoempresa, 1) AS cod_grupoempresa,
                NVL(f.cod_empresa, 1) AS cod_empresa,
                NVL(f.cod_filial, 1) AS cod_filial,
                NVL((SELECT MAX(t.zona)
                       FROM agricola.talhao t
                      WHERE t.cod_fazenda = f.cod_fazenda
                        AND t.cod_talhao = :codTalhao), 1) AS zona
           FROM agricola.fazenda f
          WHERE f.cod_fazenda = :codFazenda`,
        { codFazenda: entrada.codFazenda, codTalhao: entrada.codTalhao },
        { outFormat: driver.OUT_FORMAT_OBJECT },
      );
      const contexto = contextoResult.rows?.[0] ?? {};
      const codGrupoempresa = toNumber(rowVal(contexto, 'COD_GRUPOEMPRESA', 'cod_grupoempresa'));
      const codEmpresa = toNumber(rowVal(contexto, 'COD_EMPRESA', 'cod_empresa'));
      const codFilial = toNumber(rowVal(contexto, 'COD_FILIAL', 'cod_filial'));
      const zona = toNumber(rowVal(contexto, 'ZONA', 'zona'));
      const codAgenciador = entrada.codAgenciador;
      if (!codGrupoempresa || !codEmpresa || !codFilial || !zona) {
        throw new Error('Não foi possível completar os dados de empresa e zona para este apontamento.');
      }
      if (entrada.codGrupoempresaTurma !== codGrupoempresa) {
        throw new Error('A turma selecionada não pertence ao grupo da fazenda.');
      }
      const turma = await connection.execute(
        'SELECT cod_agenciador FROM rh.agenciador WHERE cod_grupoempresa = :grupo AND cod_agenciador = :turma',
        { grupo: codGrupoempresa, turma: codAgenciador }, { outFormat: driver.OUT_FORMAT_OBJECT },
      );
      if (!turma.rows?.length) {
        throw new Error('Turma não encontrada no cadastro do ERP.');
      }
      const tabelaPrecoResult = await connection.execute(
        `SELECT * FROM (${SQL_SERVICOS_MAO_DE_OBRA}) WHERE cod_atividade = :codAtividade`,
        { codFazenda: entrada.codFazenda, dataApontamento: entrada.dataApontamento, codAtividade: entrada.codOperacao },
        { outFormat: driver.OUT_FORMAT_OBJECT },
      );
      const tabelaPreco = tabelaPrecoResult.rows?.[0] ?? {};
      const codTabelaPreco = toNumber(rowVal(tabelaPreco, 'COD_TABELAPRECO', 'cod_tabelapreco'));
      const valorUnitario = toNumber(rowVal(tabelaPreco, 'VALOR_UNITARIO', 'valor_unitario'));
      if (!codTabelaPreco || valorUnitario == null) {
        throw new Error('Não existe tabela de preço válida para o serviço e a data informados.');
      }
        await connection.execute(
          `INSERT INTO csintegracao.APONTAMENTO_app (
           id_apont, data_apontamento, cod_agenciador, cod_fazenda, zona, cod_talhao,
           cod_atividade, cod_funcionario, quantidade, cod_grupoempresa, cod_empresa,
           cod_filial, cod_grupoempresa_tabpreco, cod_empresa_tabpreco, cod_tabelapreco,
           valor_unitario, importado, origem_importacao, desconsiderar, observacao
           ) VALUES (
           :idApont, TRUNC(:dataApontamento), :codAgenciador, :codFazenda, :zona, :codTalhao,
           :codAtividade, :codFuncionario, :quantidade, :codGrupoempresa, :codEmpresa,
           :codFilial, :codGrupoempresa, :codEmpresa, :codTabelaPreco,
           :valorUnitario, 'N', 1, 'N', :observacao
           )`,
          {
            idApont,
            dataApontamento: data,
            codFazenda: entrada.codFazenda,
            codTalhao: entrada.codTalhao,
          zona,
          codAgenciador,
            codAtividade: entrada.codOperacao,
            codFuncionario: entrada.codFuncionario,
            quantidade: 1,
          codGrupoempresa,
          codEmpresa,
          codFilial,
          codTabelaPreco,
          valorUnitario,
            observacao: entrada.observacao?.trim() || null,
          },
          { autoCommit: false },
        );
        await connection.commit();
      } catch (erro) {
        await connection.rollback().catch(() => undefined);
        throw erro;
      }
    });
    return { mensagem: 'Apontamento de mão de obra gravado com sucesso.' };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    if (/ORA-01031|insufficient privileges/i.test(mensagem)) {
      throw new Error('CSCLIENTE precisa de SELECT em CSCLIENTE.SEQ_APONTAMENTO_APP e nas tabelas de contexto/preço, e INSERT em CSINTEGRACAO.APONTAMENTO_APP.');
    }
    if (/ORA-02289/i.test(mensagem)) {
      throw new Error('A sequence CSCLIENTE.SEQ_APONTAMENTO_APP ainda não existe. Execute apontamento-mao-de-obra.sql conectado como CSCLIENTE.');
    }
    throw erro;
  }
}
