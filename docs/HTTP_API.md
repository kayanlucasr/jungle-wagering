# API HTTP — Etapa 4

Implementada sobre os serviços, repositories, locks e schema da Etapa 3. Não há novo
processador financeiro, migration, alteração de privilégios ou dependência adicional.
Os exemplos usam identificadores curtos; a abertura gera UUID interno no servidor.
Identificadores externos continuam strings do domínio, sem obrigação de serem UUIDs.

## Regras comuns

- JSON de entrada com campos obrigatórios e whitelist; propriedades desconhecidas são
  recusadas, incluindo objetos money. Não se aceita hash ou chave de idempotência no body.
- Dinheiro entra e sai como `{ "amount": "25.00", "currency": "BRL" }`. Duas casas,
  moeda reconhecida por Money, sem coerção, arredondamento, expoente, sinal negativo ou number.
- IDs: 1–256 unidades UTF-16, sem whitespace nas extremidades, NUL ou surrogate isolado.
  NUL não cabe em PostgreSQL TEXT; surrogate isolado mudaria a identidade ao codificar UTF-8.
- Versões são strings decimais; timestamps são ISO-8601 UTC com milissegundos.
- Toda resposta recebe `x-correlation-id` e `x-request-id`. Correlation ID válido recebido
  é preservado; request ID é sempre novo por requisição, inclusive em replay.
- Limite do body JSON: 64 KiB, conforme a fundação. Payload excedente retorna 413.
- Endpoints de leitura não retornam entidades ORM, payloadHash ou idempotencyKey.
- Autenticação externa está fora desta etapa; não há isolamento autorizado por provider
  implementado. Os testes usam somente ambiente local/descartável.
- A Etapa 8.1 conecta NoopProviderIdentityGuard aos dois controllers financeiros.
  É uma extensão explícita sem autenticação: permite acesso e não altera providerId,
  body ou contexto financeiro. Health permanece sem guard; SQS não passa por ele.

## Rotas e status

| Método e rota | Resultado |
|---|---|
| POST /wallets | 201; player/moeda duplicado retorna 409 WALLET_ALREADY_EXISTS. |
| GET /wallets/:walletId | 200; wallet inexistente retorna 404 WALLET_NOT_FOUND. |
| GET /wallets/:walletId/ledger | 200; cursor/limite inválido retorna 400; wallet ausente retorna 404. |
| GET /wagering/transactions/:transactionId | 200 com estado atual; ausente retorna 404 TRANSACTION_NOT_FOUND. |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | Mesma representação da consulta por ID interno. |
| POST /wagering/transactions | 200 PROCESSED, 202 PENDING/PENDING_REFERENCE, 422 REJECTED, 500 FAILED persistido. |
| POST /wallets/:walletId/reconciliation | 200 com diagnóstico, inclusive quando consistent=false; não corrige dados. |
| GET /health/live | Contrato da fundação: processo vivo, 200. |
| GET /health/ready | PostgreSQL, tabelas/colunas operacionais e filas prontos, 200; indisponibilidade/schema parcial, 503. |

As consultas financeiras recusam query params desconhecidos. Ledger aceita somente
`limit` e `cursor`; reconciliação não recebe payload ou aceita apenas `{}`.

## Abertura e consulta de wallet

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "player-a",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Resposta 201 (a mesma representação é usada no GET):

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "player-a",
  "currency": "BRL",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": "1",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "updatedAt": "2026-10-28T12:00:00.000Z"
}
```

Saldo inicial positivo cria OPENING/CREDIT na mesma unidade de trabalho. Saldo zero
abre com versão 1 e ledger vazio. Duplicatas concorrentes de player/moeda produzem uma
abertura e um conflito; não se implementa replay de POST /wallets.

## Ledger paginado

```http
GET /wallets/wallet-a/ledger?limit=50
```

```json
{
  "items": [
    {
      "id": "entry-a",
      "walletId": "wallet-a",
      "transactionId": "transaction-a",
      "walletVersion": "2",
      "direction": "DEBIT",
      "money": { "amount": "20.00", "currency": "BRL" },
      "balanceBefore": { "amount": "100.00", "currency": "BRL" },
      "balanceAfter": { "amount": "80.00", "currency": "BRL" },
      "createdAt": "2026-10-28T12:00:01.000Z"
    }
  ],
  "nextCursor": null
}
```

Ordenação crescente por walletVersion, usando o índice único existente. Limite padrão
50, permitido 1–100. O cursor opaco e versionado transporta walletId, última versão
retornada e limite superior fixado na primeira página. A primeira consulta lê wallet e
ledger no mesmo snapshot; próximas páginas usam `after < version <= upper`, sem OFFSET.

Inserções posteriores não aparecem no percurso já iniciado. Para vê-las, iniciar uma
nova consulta sem cursor. Como o ledger é imutável e não pode ser apagado, as páginas
existentes não se deslocam. Cursor pode ser usado em outra réplica sem estado local.

Clientes devem tratar o cursor como opaco. Ele usa Base64URL, é validado e vinculado à
wallet, mas **não é assinado, criptografado ou um token de autorização**. Alterar manualmente
um cursor válido escolhe outra posição/limite dentro do histórico já consultável; não
autoriza acesso nem modifica finanças. O contrato não promete autenticidade criptográfica.

## Submissão e replay

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-a
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-a",
  "playerId": "player-a",
  "walletId": "wallet-a",
  "roundId": "round-a",
  "gameId": "game-a",
  "kind": "BET",
  "money": { "amount": "20.00", "currency": "BRL" }
}
```

Para REFUND/ROLLBACK, incluir `referenceExternalTransactionId`. OPENING não pode ser
submetido externamente. Referência malformada/autorref retorna 400; contexto, tipo ou
valor de uma referência existente incompatível produzem rejeição financeira persistida.

Resposta PROCESSED, HTTP 200:

```json
{
  "transactionId": "transaction-internal-a",
  "status": "PROCESSED",
  "balance": { "amount": "80.00", "currency": "BRL" },
  "walletVersion": "2",
  "completedAt": "2026-10-28T12:00:01.000Z",
  "idempotentReplay": false
}
```

REJECTED retorna 422, com o mesmo formato e `failureCode`. Inclui saldo observado e
versão da wallet real, inclusive em rejeição por moeda/player incompatível. FAILED
persistido retorna 500 com status FAILED, failureCode permanente e snapshot auditável.
GET de qualquer transação existente retorna 200, independentemente de seu status financeiro.

PENDING/PENDING_REFERENCE retornam 202 sem inventar saldo ou resultado terminal:

```json
{
  "transactionId": "transaction-internal-a",
  "status": "PENDING_REFERENCE",
  "idempotentReplay": false
}
```

O header é obrigatório, único e a fonte da verdade. Aceita 1–256 caracteres ASCII
visíveis sem espaços; múltiplos headers são recusados. Não se gera default silencioso.
O hash v1 é o algoritmo aprovado na Etapa 3: SHA-256 de JSON de array com ordem fixa,
moeda/valor canônicos, referência ausente como null, excluindo chave e metadados de transporte.
Não se muda para outro algoritmo no endpoint, preservando as identidades persistidas.

| Tentativa | Comportamento |
|---|---|
| Mesma chave, identidade e hash | Retorna o registro persistido, idempotentReplay=true. |
| Mesma chave com outra identidade/payload | 409 IDEMPOTENCY_CONFLICT. |
| Mesma identidade externa com outra chave | 409 IDEMPOTENCY_CONFLICT. |
| Identidade e chave apontam para registros diferentes | 409 IDEMPOTENCY_CONFLICT. |
| Registro terminal | Status HTTP e snapshot históricos; nenhum movimento adicional. |
| Registro pendente | 202 com estado atual, sem executar transição pelo replay. |
| Pendência concluída internamente depois | Replay passa a retornar resultado terminal persistido. |

Após BET 20.00 sobre 100.00 e WIN 50.00, o saldo atual é 130.00. O replay da BET
continua retornando 80.00, sua versão e instante originais. Somente idempotentReplay
muda no body; IDs de rastreamento dos headers pertencem à nova requisição.

Não há cache local, Map ou resposta HTTP alternativa usada como garantia de idempotência.
O body é mapeado deterministicamente do estado/snapshot persistido. Não foi necessário
armazenar outro snapshot HTTP ou modificar o schema. O caminho de replay não usa saldo
atual para substituir o resultado, nem trata duplicata pendente como pedido de retomada.

## Consulta de transações

Os dois GETs retornam `id`, providerId/externalTransactionId quando externos, playerId,
walletId, roundId/gameId quando aplicáveis, kind, money, status, referências quando
existentes, failureCode e `result` terminal persistido. Há createdAt e completedAt quando
concluída. Campos opcionais ausentes são omitidos, não preenchidos com resultado fictício.

`result` contém transactionId, status, balance, walletVersion, completedAt e os campos
opcionais failureCode/referenceTransactionId. É histórico; o saldo atual da wallet não
é consultado para reconstruí-lo. Hash, chave e metadados internos de retry não são expostos.

## Reconciliação

```http
POST /wallets/wallet-a/reconciliation
```

```json
{
  "walletId": "wallet-a",
  "storedBalance": { "amount": "130.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "130.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 3,
  "storedVersion": "3",
  "lastLedgerVersion": "3",
  "totalCredits": { "amount": "150.00", "currency": "BRL" },
  "totalDebits": { "amount": "20.00", "currency": "BRL" },
  "issues": []
}
```

Reutiliza a leitura READ ONLY REPEATABLE READ e o diagnóstico da Etapa 3. Difference
é `storedBalance - calculatedBalance`, calculada com bigint de centavos na Application.
CheckedEntries é contagem não financeira em number, com guarda de inteiro seguro;
versões e valores permanecem strings. Totais históricos podem exceder a faixa de Money.
Divergência produz consistent=false/issues, evento JSON e incremento do contador de
inconsistências, sem executar correção ou alterar o saldo.

## Erros operacionais e validação

Envelope de erro antes de haver um resultado financeiro:

```json
{
  "statusCode": 409,
  "code": "IDEMPOTENCY_CONFLICT",
  "correlationId": "correlation-a",
  "requestId": "request-a"
}
```

DTO inválido pode incluir `fields`, contendo somente nomes de campos conhecidos, nunca
valores submetidos. Código 400 pode ser INVALID_REQUEST, INVALID_CURSOR ou o código de
validação monetária/referência do domínio. Recurso ausente é 404; duplicidade é 409.
Erro interno inesperado retorna 500 INTERNAL_ERROR, sem SQL, stack ou detalhes de configuração.

Timeout/deadlock esgotado/erro de conexão classificado retorna 503 TEMPORARILY_UNAVAILABLE,
sem persistir REJECTED ou FAILED financeiro. Falha não classificada após trabalho concluído
é tratada como commit possivelmente incerto e não é repetida automaticamente: o cliente
deve repetir a mesma identidade/chave. Falhas de integridade continuam sendo erro interno.

## Observabilidade, execução e limites

Logs de conclusão incluem correlationId, requestId, método, status, duração e IDs financeiros
validados disponíveis. Não registram body, query, Idempotency-Key, hash, tokens ou credenciais.
Contadores HTTP/duração/reconciliação são locais por processo, preparados para um exporter
futuro. Não há novo endpoint de métricas, dependência ou infraestrutura de monitoramento.

Build/typecheck/smoke e testes:

```text
bun run test:build
bun run test
bun run test:integration:docker
```

O runner Docker executa integração e E2E juntos. Os 19 testes HTTP iniciam três processos
Nest reais usando `dist/`, cada um com pool e conexão PostgreSQL próprios e login runtime.
Ao executar integração fora do Docker, configurar o ambiente administrativo de testes e
executar `bun run build` antes de `bun run test:integration` para atualizar `dist/`.

O teste histórico da Etapa 4 usa harness interno para conclusão. As Etapas 5–7
implementaram consumer, publisher, retries/DLQ e scheduler operacional, sem endpoint
de retomada. Autenticação externa e frontend continuam ausentes. Readiness e métricas
foram ampliados na Etapa 7. Estado atual e pendências de conformidade estão em
[FINAL_REVIEW.md](../FINAL_REVIEW.md); este documento preserva o contrato HTTP.
