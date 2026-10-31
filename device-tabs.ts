export const ABAS_DISPOSITIVO = [
  { id: 'mapa', titulo: 'Mapa', rotas: ['mapa'] },
  { id: 'cadastros', titulo: 'Cadastros', rotas: ['importar-cadastro-apontamento'] },
  { id: 'insumos', titulo: 'Insumos', rotas: ['apontamento'] },
  { id: 'mao-de-obra', titulo: 'Mão de obra', rotas: ['mao-de-obra'] },
  { id: 'irrigacao', titulo: 'Irrigação', rotas: ['irrigacao'] },
  { id: 'salvos', titulo: 'Apontamentos salvos', rotas: ['apontamentos-locais'] },
  { id: 'perdas', titulo: 'Perdas de colheita', rotas: ['perdas-colheita'] },
  { id: 'biometria', titulo: 'Análise biométrica', rotas: ['analise-biometrica'] },
  { id: 'talhoes-admin', titulo: 'Talhões (administrador)', rotas: ['mapa-admin', 'desenhar-talhao'] },
  { id: 'usuarios', titulo: 'Usuários (administrador)', rotas: ['usuarios'] },
  { id: 'conexao', titulo: 'Conexão Oracle (administrador)', rotas: ['conexao-oracle'] },
] as const;
export type AbaDispositivo = typeof ABAS_DISPOSITIVO[number]['id'];
export const ABAS_OBRIGATORIAS: readonly AbaDispositivo[] = ['cadastros', 'salvos'];
export interface AcessoUsuario {
  idUsuario: number; abas: AbaDispositivo[];
}
