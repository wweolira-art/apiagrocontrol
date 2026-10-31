import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

function fixture(rows) {
  const queries = [];
  const source = fs.readFileSync(new URL('../mao-de-obra.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source)
    .replace(/^import .* from '\.\/oracle\.ts';\r?\n/m, '')
    .replace(/^export /gm, '');
  const list = new Function('consultarSqlGravacao', 'withOracleGravacao', `${code}\nreturn listarTurmasMaoDeObra;`)(
    async sql => { queries.push(sql); return rows; }, undefined,
  );
  return { list, queries };
}

test('turmas retornam descrição sem alterar códigos, e descartam códigos ausentes', async () => {
  const f = fixture([{ COD_GRUPOEMPRESA: 1, COD_AGENCIADOR: 12, DESCRICAO: '  Equipe campo  ' }, { COD_AGENCIADOR: 3 }]);
  assert.deepEqual(await f.list(), [{ codGrupoempresa: 1, codAgenciador: 12, descricao: 'Equipe campo' }]);
  assert.match(f.queries[0], /LEFT JOIN material.fornecedor/);
  assert.match(f.queries[0], /e.cod_grupoempresa = a.cod_grupoempresa/);
  assert.match(f.queries[0], /COALESCE\(TRIM\(pf.nome\), TRIM\(pe.nome\), TRIM\(f.nomefantasia\)\)/);
});

test('resultados em minúsculas e turma sem nome continuam compatíveis', async () => {
  const named = fixture([{ cod_grupoempresa: 1, cod_agenciador: 2, descricao: 'Equipe' }]);
  assert.equal((await named.list())[0].descricao, 'Equipe');
  const legacy = fixture([{ COD_GRUPOEMPRESA: 1, COD_AGENCIADOR: 2 }]);
  assert.equal((await legacy.list())[0].descricao, '');
});
