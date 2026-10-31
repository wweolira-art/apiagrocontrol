# AgroControl API

API independente do aplicativo Elejotaagro, com autenticação, permissões e integrações Oracle e ControleAgricola.

## Executar

Requer Node.js 24 ou superior. Algumas conexões Oracle legadas exigem Oracle Instant Client (modo Thick).

```powershell
npm ci
Copy-Item .env.example .env
```

Preencha o `.env` com os dados do seu servidor. Configure o cadastro ORDS de usuários, permissões, conexão Oracle e domínio ngrok conforme o ambiente.

```powershell
npm start
```

Para publicar pelo ngrok, instale/configure o ngrok e execute `npm run public`. No Windows, os arquivos `AgroControl-API.vbs`, `Configurar-API.vbs` e `Parar-API.vbs` também permitem gerenciar a API.

## Verificação

```powershell
npm test
```

`GET /health` informa a disponibilidade da API. As rotas operacionais exigem uma sessão obtida em `POST /api/auth/login` e as permissões correspondentes.

## Dados locais

O `.env`, sessões e outros dados em `data/`, bancos locais, logs, backups e APKs são ignorados pelo Git. Preserve seus dados e configurações ao atualizar o servidor. Nunca publique senhas ou tokens. O `.env.example` contém apenas valores de exemplo.

## Documentação

- [Autenticação](autenticacao.md)
- [Permissões por e-mail](acesso-abas.md)
- [Integração de biometria](BIOMETRIA-LOCAL.md)

Esta pasta pode ser versionada em um repositório separado do aplicativo AgroControl.
