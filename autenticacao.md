# Configuração da autenticação

A API valida as senhas e mantém sessões opacas com validade de oito horas. A API independente preserva as sessões em `data/sessoes.json` entre reinícios, armazenando somente o hash do token, o identificador do usuário e a expiração. Preserve e restrinja o acesso a essa pasta; não publique seu conteúdo. Sessões perdidas antes desta atualização exigem novo login. Use uma instância da API; múltiplas instâncias exigem um armazenamento compartilhado de sessões e limites de tentativas.

O aplicativo chama `/api/auth/login`, recebe os dados públicos do usuário e um token, e envia esse token nas chamadas à API. O servidor consulta o perfil e a situação do usuário a cada chamada protegida. Nome ou e-mail contendo “admin” não concedem acesso. Hashes de senha não são enviados ao aplicativo.

## Preparação no banco e na ORDS

Estas etapas são manuais. Nenhum script desta alteração modifica o banco remoto automaticamente.

1. Identifique a tabela real por trás do endpoint `usuario`. Faça backup antes da migração.
2. Adicione um campo `perfil`, restrito a `admin` e `operador`, com padrão `operador`. Exemplo **a adaptar ao nome real da tabela**:

   ```sql
   ALTER TABLE SEU_SCHEMA.SUA_TABELA_USUARIO ADD (
     perfil VARCHAR2(8) DEFAULT 'operador' NOT NULL
       CHECK (perfil IN ('admin', 'operador'))
   );
   ```

3. Confirme que `senha_hash` comporta pelo menos 64 caracteres, `ativo` usa 1/0 e os e-mails estão normalizados em minúsculas, sem duplicações. Configure uma restrição única no e-mail. O endpoint precisa expor `perfil` para leitura e escrita pela API.
4. Proteja **todos** os métodos de `usuario` por um privilégio ORDS e permita acesso somente ao cliente OAuth do servidor. Confira que GET, POST e PUT sem autenticação são recusados. Remova acessos anônimos antigos; apenas mudar o aplicativo não protege o endpoint remoto.
5. Configure `ORDS_AUTH_USUARIOS_URL` e `ORDS_AUTH_TOKEN` em `server/.env`. O token deve permitir apenas as operações necessárias no cadastro de usuários. Ele nunca deve ser colocado em `EXPO_PUBLIC_*` ou no EAS do aplicativo. Renove-o quando expirar.
6. Para o primeiro administrador, execute `node scripts/hash-password.mjs` em um terminal. A senha não aparece na tela; copie somente o hash gerado para o campo `senha_hash` de uma conta escolhida no banco. Defina explicitamente `perfil = 'admin'` e `ativo = 1` nessa conta. Não determine o perfil pelo nome ou e-mail.
7. Suba a API atualizada e configure `EXPO_PUBLIC_API_URL` com sua URL HTTPS. Entre novamente no aplicativo. Sessões do formato antigo são descartadas.

## Contas existentes

O padrão aceita somente hashes scrypt. Senhas em texto puro deixam de funcionar: redefina-as com o gerador de hash.

Se houver hashes SHA256 legados, ative temporariamente `AUTH_ALLOW_LEGACY_SHA256=true` no servidor. Cada login válido substitui o hash por scrypt, com salt aleatório. Depois da janela de migração, volte para `false` e redefina a senha das contas restantes. Não há alteração automática de perfil: contas sem perfil explícito recebem somente acesso de operador.

Administradores podem listar e criar usuários por `/api/usuarios`; o servidor exige sessão de administrador e senha nova de no mínimo 12 caracteres. Desativar uma conta ou retirar o perfil no banco vale na próxima chamada à API.

## Limites e integrações existentes

O endpoint `/health` é público e retorna somente a disponibilidade da API. As rotas `/api/*`, com exceção do login, exigem sessão. Configuração Oracle, teste de INSERT e gestão de usuários exigem administrador.

O aplicativo ainda contém integrações diretas com outras rotas ORDS (mapas, conexão, insumos e biometria). As permissões desses serviços precisam ser configuradas no servidor ORDS antes de uma implantação pública. Em particular, credenciais de banco não devem ser expostas por `conexao_banco` a operadores ou visitantes. Não coloque um token administrativo no APK para contornar uma recusa de acesso. A migração completa dessas integrações para a API é trabalho adicional necessário para uma implantação pública segura.

O armazenamento web atual usa localStorage. Em um produto web exposto publicamente, planeje cookies HttpOnly/Secure e proteção de conteúdo; no Android a sessão usa SecureStore. Tokens expirados ou revogados são recusados pela API mesmo que a interface ainda mostre dados locais.
