import { consultarSqlGravacao } from './oracle.ts';
export async function buscarFuncionarioUsuario(codigo: number) {
  const rows = await consultarSqlGravacao(`SELECT DISTINCT s.cdgfuncionario AS codigo, TRIM(s.cscfuncionario) AS nome
    FROM agricola.sga_funcionario s WHERE s.cdgfuncionario = :codigo AND s.idnativo = 'S' AND TRIM(s.cscfuncionario) IS NOT NULL`, { codigo });
  if (rows.length !== 1) throw new Error('Funcionário não encontrado ou código ambíguo no cadastro ativo.');
  return { codigo: Number(rows[0].CODIGO), nome: String(rows[0].NOME).trim() };
}
