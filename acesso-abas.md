# Liberação de abas por e-mail

O app usa a tabela publicada em ORDS_ACESSO_ABA_URL, por padrão o endpoint app_acesso_aba informado pelo usuário. Cada linha tem somente email e aba; uma linha significa liberação. E-mails são salvos em minúsculas e sem espaços. Sem linhas, não há abas operacionais liberadas.

Em Administração → Acesso por e-mail, informe o e-mail cadastrado, consulte, marque as abas e salve. Também é possível selecionar um e-mail com liberações existentes. A configuração vale em qualquer aparelho em que a conta entrar. Não concede perfil administrativo: essas telas ainda exigem perfil admin na sessão. A própria configuração permanece sempre disponível para administradores.

Os identificadores válidos são mapa, cadastros, insumos, mao-de-obra, salvos, perdas, biometria, talhoes-admin, usuarios e conexao. O servidor valida esses identificadores e usa o e-mail autenticado, nunca um e-mail informado pelo operador, nas consultas de acesso próprio.

Rotas da API do app:

- GET /api/acesso/abas: liberações da sessão atual.
- GET /api/acessos/abas: lista de liberações, somente administrador.
- GET /api/acessos/abas/EMAIL: consulta administrativa.
- PUT /api/acessos/abas/EMAIL: corpo com abas, somente administrador.

As leituras percorrem todas as páginas da ORDS. O salvamento remove somente as linhas revogadas desse e-mail e inclui somente as novas. Confirma o resultado por leitura. São chamadas REST individuais, não uma transação única; em falha parcial a tela recarrega o estado efetivamente salvo. Chamadas de atualização do mesmo e-mail são serializadas na instância da API. Múltiplas instâncias exigem controle transacional no banco para evitar concorrência.

O menu e as rotas do app respeitam as liberações. As rotas operacionais mapeadas da API também consultam a tabela. As integrações ORDS diretas existentes continuam dependendo dos privilégios próprios do serviço/banco.

As permissões são atualizadas no login, ao voltar ao primeiro plano e a cada 30 segundos enquanto o app está ativo. O cache offline é separado por e-mail e URL da API; dados de outro usuário ou do antigo modelo por dispositivo não são reutilizados. Uma revogação reflete no aparelho quando ele voltar a consultar a API; nas chamadas protegidas a API verifica o estado atual.

O antigo arquivo dispositivos.json não é mais consultado. As liberações antigas por aparelho não são migradas automaticamente, pois não possuem e-mail. Nenhum usuário real foi liberado automaticamente durante a integração.

## Configuração e segurança da ORDS

Configure ORDS_ACESSO_ABA_URL no .env da API. ORDS_ACESSO_ABA_TOKEN é opcional no código e fica apenas no servidor quando usado.

No teste real, o endpoint aceitou POST e DELETE sem autenticação. É necessário restringir a escrita da ORDS à credencial da API para garantir que apenas o administrador possa alterar permissões também fora do app; a validação de perfil na API do app não protege um endpoint ORDS público contra chamadas diretas. Nenhuma alteração de privilégios ORDS foi feita automaticamente.

O teste scripts/test-acesso-aba.mjs cria um e-mail técnico aleatório em example.invalid, confirma inclusão/leitura/revogação e remove suas linhas ao terminar. Não altera usuários reais. Não executa testes no cadastro operacional ou na folha.
