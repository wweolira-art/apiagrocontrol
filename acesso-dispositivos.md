# Abas por dispositivo

O administrador abre Administração → Acesso dos dispositivos, seleciona um aparelho, marca as abas e salva. O código completo do aparelho aparece na página inicial e na lista de dispositivos. O cadastro é criado no primeiro acesso autenticado. Pode-se definir um nome como “Equipe campo 1”.

Novas instalações começam sem abas liberadas. A liberação é da instalação, vale para todos os usuários nela e persiste ao sair da conta. Reinstalar/limpar os dados pode gerar outro identificador, exigindo nova liberação. A conta ainda precisa ter perfil admin para funções administrativas; liberar a aba não transforma operador em administrador. A configuração de dispositivos está sempre disponível para administradores, evitando bloqueio da gestão.

O menu oculta as abas não liberadas e o Expo Router bloqueia a abertura direta das rotas. Os atalhos entre telas também respeitam a liberação. As rotas operacionais mapeadas da API validam o identificador enviado em X-Device-ID e a permissão atual, além da sessão. As integrações diretas ORDS existentes não passam por essa API: a restrição destas telas é feita no app e não substitui os privilégios do banco/ORDS.

As políticas ficam em server/data/dispositivos.json (ou data/dispositivos.json na API independente). Preserve esse arquivo nos backups e na atualização do servidor. Gravação atômica em arquivo é adequada à instância única atual; múltiplas instâncias precisariam compartilhar o armazenamento.

O app consulta as permissões no login, ao voltar ao primeiro plano e a cada 30 segundos enquanto ativo. As últimas permissões aprovadas são guardadas por instalação e URL da API para uso offline; novas liberações/revogações exigem conexão para refletir no aparelho. A API sempre consulta a política atual nas chamadas protegidas. Dispositivo novo sem autorização em cache permanece bloqueado se a API estiver indisponível.

Rotas, todas com sessão:

- GET /api/dispositivo/acesso: registra/consulta o próprio dispositivo.
- GET /api/dispositivos: somente administrador.
- PUT /api/dispositivos/UUID: somente administrador; corpo com nome e abas.

Identificador é gerado por instalação e salvo no SecureStore no aparelho, ou localStorage na web. É um controle da instalação do app, não identificação física/atestação do hardware. O backend precisa ser atualizado junto com o app. Versão antiga sem essas rotas não libera abas automaticamente.
