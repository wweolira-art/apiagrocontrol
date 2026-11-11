import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { ABAS_DISPOSITIVO, ABAS_OBRIGATORIAS, type AbaDispositivo, type AcessoUsuario } from './device-tabs.ts';
import { AuthError } from './auth.ts';

type AcessoOrds = { list: () => Promise<AcessoUsuario[]> };

const abasValidas = new Set<string>(ABAS_DISPOSITIVO.map((item) => item.id));

function normalizarId(valor: unknown): number {
  const id = Number(valor);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AuthError(400, 'Informe um código de usuário válido.');
  }
  return id;
}

function normalizarAbas(abas: unknown): AbaDispositivo[] {
  if (!Array.isArray(abas) || abas.some((aba) => typeof aba !== 'string' || !abasValidas.has(aba))) {
    throw new AuthError(400, 'Lista de abas inválida.');
  }
  return [...new Set([...ABAS_OBRIGATORIAS, ...abas])] as AbaDispositivo[];
}

/**
 * Repositório local das permissões. A ORDS é usada somente para preencher o
 * banco uma vez; leituras e alterações posteriores não dependem dela.
 */
export function createAcessoAbasSqlite(arquivo: string) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS acesso_abas (
      id_usuario INTEGER NOT NULL,
      aba TEXT NOT NULL,
      atualizado_em TEXT NOT NULL,
      PRIMARY KEY (id_usuario, aba)
    );
  `);

  const acesso = (idUsuario: number, abas: AbaDispositivo[]): AcessoUsuario => ({
    idUsuario,
    abas: [...new Set([...ABAS_OBRIGATORIAS, ...abas])],
  });

  function abasDoUsuario(idUsuario: number): AbaDispositivo[] {
    return db.prepare('SELECT aba FROM acesso_abas WHERE id_usuario=? ORDER BY aba').all(idUsuario)
      .map((linha) => String(linha.aba))
      .filter((aba): aba is AbaDispositivo => abasValidas.has(aba));
  }

  return {
    current(valor: unknown): AcessoUsuario {
      const idUsuario = normalizarId(valor);
      return acesso(idUsuario, abasDoUsuario(idUsuario));
    },
    list(): AcessoUsuario[] {
      const ids = db.prepare('SELECT DISTINCT id_usuario FROM acesso_abas ORDER BY id_usuario').all()
        .map((linha) => normalizarId(linha.id_usuario));
      return ids.map((idUsuario) => acesso(idUsuario, abasDoUsuario(idUsuario)));
    },
    update(valor: unknown, corpo: Record<string, unknown>): AcessoUsuario {
      const idUsuario = normalizarId(valor);
      const abas = normalizarAbas(corpo.abas);
      const agora = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM acesso_abas WHERE id_usuario=?').run(idUsuario);
        const inserir = db.prepare('INSERT INTO acesso_abas (id_usuario, aba, atualizado_em) VALUES (?, ?, ?)');
        for (const aba of abas) inserir.run(idUsuario, aba, agora);
        db.exec('COMMIT');
      } catch (erro) {
        db.exec('ROLLBACK');
        throw erro;
      }
      return acesso(idUsuario, abas);
    },
    async importarOrdsSeVazio(ords: AcessoOrds): Promise<number> {
      const existente = Number(db.prepare('SELECT COUNT(*) AS total FROM acesso_abas').get().total);
      if (existente > 0) return 0;
      const liberacoes = await ords.list();
      if (!liberacoes.length) return 0;
      const agora = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const inserir = db.prepare('INSERT OR IGNORE INTO acesso_abas (id_usuario, aba, atualizado_em) VALUES (?, ?, ?)');
        for (const item of liberacoes) {
          const idUsuario = normalizarId(item.idUsuario);
          for (const aba of normalizarAbas(item.abas)) inserir.run(idUsuario, aba, agora);
        }
        db.exec('COMMIT');
      } catch (erro) {
        db.exec('ROLLBACK');
        throw erro;
      }
      return liberacoes.length;
    },
  };
}
