# Biometria recebida pelo ControleAgricola

## Modo configurado: arquivo

Na AgroControl-api-public, a configuração atual é:

```env
CONTROLE_AGRICOLA_TRANSPORTE=arquivo
CONTROLE_AGRICOLA_DB_PATH=C:\ControleAgricola\PlanejamentoAgricola\data\planejamento.db
```

A API abre exatamente esse arquivo no computador em que ela está executando. Não usa IP, porta 5173 nem HTTP para acessar o banco nesse modo. O arquivo existente precisa estar nesse computador; `C:\...` não identifica o disco C de outro dispositivo. Se o caminho estiver errado ou o banco não existir, a API retorna erro e mantém o apontamento pendente no aparelho. Ela não cria nem copia um banco vazio automaticamente.

## Fluxo

O aplicativo mantém o apontamento na fila do aparelho e, ao enviar, chama a AgroControl-api-public com a sessão autenticada. As medições e os motivos TCH são gravados no SQLite compartilhado com o ControleAgricola. A confirmação ao aparelho só acontece depois do COMMIT.

O relatório do ControleAgricola já lê `analise_biometrica_lancamentos`, portanto os novos dados aparecem ao clicar em Atualizar e selecionar o período correspondente. Não é necessário executar `sync:biometria` para os novos lançamentos enviados por este fluxo.

Os cadastros de referência (itens, pontos e lista de motivos) continuam usando as leituras ORDS existentes. As rotas de gravação, histórico, motivos vinculados ao talhão e exclusão passam pela API pública e pelo SQLite local. Não há fallback de escrita para a ORDS.

## Configuração da API no modo arquivo

Use Node.js 24, já adotado pelo projeto. No `.env` da AgroControl-api-public, configure `CONTROLE_AGRICOLA_DB_PATH` com o caminho do arquivo existente `ControleAgricola/PlanejamentoAgricola/data/planejamento.db` no PC da API. A integração não cria um arquivo vazio quando esse caminho estiver errado. Os dois processos precisam acessar o mesmo banco local.

Rotas autenticadas com liberação da aba biometria:

- `POST /api/biometria/lancamentos`: corpo `{ entradas: [...] }`, até 100 itens. Recebe data, ponto, item, fazenda, talhão, variedade, valor, motivos e identificação estável de envio.
- `GET /api/biometria/lancamentos`: histórico do SQLite.
- `GET /api/biometria/motivos-talhao`: motivos locais, com filtros opcionais data, codFazenda e codTalhao.
- `DELETE /api/biometria/lancamentos/:id`: exclusão pelo autor ou administrador.

O autor é obtido da sessão da API. A API valida datas e códigos e exige que o item exista no cadastro local. Motivos são únicos por data, fazenda, talhão e código. Medições repetidas não são reinseridas. A tabela `analise_biometrica_envios` mantém confirmações persistentes por identificação do envio; identificações reutilizadas com conteúdo diferente ou após exclusão são recusadas. Erros no lote provocam rollback.

## Aplicação da atualização

1. Reinicie a AgroControl-api-public após atualizar seus arquivos e o `.env`.
2. Instale um APK com o novo cliente. APKs anteriores continuam utilizando as rotas ORDS embutidas neles.
3. Confira a URL da API na aba Cadastros e entre novamente se a sessão estiver expirada.
4. Salve um apontamento, envie pelos Apontamentos salvos e atualize a Análise Biométrica do ControleAgricola.

A implantação cria backup dos arquivos e do banco existente antes de alterar o esquema. Os lançamentos anteriores são mantidos. Os motivos históricos são copiados por leitura da ORDS; os dados da ORDS não são excluídos nem alterados.

## Alternativa opcional: dispositivos separados pela rede

Somente quando o arquivo não estiver acessível no computador da API, pode-se selecionar `CONTROLE_AGRICOLA_TRANSPORTE=http` e definir `CONTROLE_AGRICOLA_URL=http://IP-DO-PC-CONTROLE:5173`. A API usa `CONTROLE_AGRICOLA_INTEGRACAO_TOKEN`; no ControleAgricola, `AGROCONTROL_INTEGRACAO_TOKEN` deve conter a mesma chave no `.env` do projeto. A porta 5173 encaminha `/api` ao servidor interno. A rota receptora é `/api/integracoes/agrocontrol/biometria` e utiliza o `dbPath` do próprio ControleAgricola. A configuração HTTP é ignorada enquanto o modo selecionado for `arquivo`.
