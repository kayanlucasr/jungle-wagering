# Mensageria — Etapa 5

## Comando v1

Fila `wager-transactions.fifo`. Exemplo completo:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "version": 1,
  "correlationId": "request-123",
  "occurredAt": "2026-10-29T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-123",
    "idempotencyKey": "provider-a:bet-123",
    "walletId": "wallet-123",
    "playerId": "player-123",
    "roundId": "round-123",
    "gameId": "game-123",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Todos os campos do envelope são obrigatórios, sem propriedades desconhecidas. Apenas
`referenceExternalTransactionId` é opcional em data; é obrigatório para REFUND/ROLLBACK.
Kinds externos: BET, WIN, LOSS, REFUND, ROLLBACK. OPENING é interno. Dinheiro segue Money:
string canônica com duas casas, exata e finita. Timestamp deve ser ISO UTC com milissegundos.
IDs seguem as invariantes existentes, sem NUL/surrogates isolados. Correlation ID usa
`[A-Za-z0-9._:-]{1,128}`. Envelope limitado a 64KiB e versão desconhecida recusada.

Consumer: `wager-transactions-v1`. Inbox tem PK `(consumer_name,message_id)` e hash SHA-256
do array `[version,messageId,type,correlationId,occurredAt,idempotencyKey,financialPayloadHashV1]`.
Assim, whitespace/ordem de propriedades não mudam identidade. Reusar messageId com outro
envelope é conflito. Identidade financeira usa o hash e as constraints já aprovados na
Etapa 3; outro messageId para o mesmo comando também não duplica movimento ou eventos.

MessageGroupId = SHA-256 UTF-8 de walletId, hexadecimal de 64 caracteres, pela função
`walletGroup`. Essa representação admite IDs Unicode sem exceder limites ASCII do SQS.
MessageDeduplicationId do produtor deve ser SHA-256 de messageId (identidade estável).
O messageId do envelope é a identidade de negócio do transporte; não é o ID gerado pelo SQS.

## Eventos v1

Fila `wager-events.fifo`. Envelope comum:

```json
{
  "eventId": "c36e9572-0db3-4c21-a330-73569750c006",
  "eventType": "WagerTransactionProcessed",
  "version": 1,
  "aggregateId": "wallet-123",
  "transactionId": "transaction-123",
  "correlationId": "request-123",
  "causationId": "msg-123",
  "occurredAt": "2026-10-29T12:00:01.000Z",
  "data": {
    "walletId": "wallet-123",
    "transactionId": "transaction-123",
    "providerId": "provider-a",
    "externalTransactionId": "bet-123",
    "kind": "BET",
    "status": "PROCESSED",
    "money": { "amount": "25.00", "currency": "BRL" },
    "referenceExternalTransactionId": null,
    "result": {
      "transactionId": "transaction-123",
      "status": "PROCESSED",
      "balance": { "amount": "75.00", "currency": "BRL" },
      "walletVersion": "2",
      "completedAt": "2026-10-29T12:00:01.000Z"
    }
  }
}
```

`causationId` é opcional; presente na entrada SQS. Correlation ID também é propagado
pelas entradas HTTP. `eventId` nasce uma vez na transação SQL; republicações leem exatamente
o JSON persistido. DeduplicationId = eventId; GroupId = walletGroup(aggregateId).
Versões e valores financeiros são strings nos payloads; `version` do schema é inteiro.

`IntegrationEvent<T>` é abstrata, com uma subclasse por evento:

| Evento | Produção | Data |
|---|---|---|
| WagerTransactionProcessed | Nova operação PROCESSED, inclusive LOSS e abertura positiva | Campos financeiros do exemplo, com snapshot terminal |
| WagerTransactionRejected | Nova operação REJECTED por regra financeira | Mesmos campos, status REJECTED; result inclui failureCode |
| WagerTransactionPendingReference | Nova operação PENDING_REFERENCE | Mesmos campos, status PENDING_REFERENCE; result null |
| WalletBalanceChanged | Somente quando existe ledger com mudança efetiva | Contrato abaixo |

Data de `WalletBalanceChanged`:

```json
{
  "walletId": "wallet-123",
  "transactionId": "transaction-123",
  "providerId": "provider-a",
  "externalTransactionId": "bet-123",
  "kind": "BET",
  "direction": "DEBIT",
  "money": { "amount": "25.00", "currency": "BRL" },
  "balanceBefore": { "amount": "100.00", "currency": "BRL" },
  "balanceAfter": { "amount": "75.00", "currency": "BRL" },
  "walletVersion": "2"
}
```

Em abertura positiva, providerId/externalTransactionId são null e kind é OPENING.
Abertura zero, LOSS, REJECTED e PENDING_REFERENCE não geram WalletBalanceChanged.
Campos opcionais do snapshot terminal ausentes são omitidos; não viram valores inventados.
Replay não enfileira eventos adicionais. Não há backfill de operações anteriores à Etapa 5.

## Fluxo e garantias

1. Receive com long polling e validação do envelope/grupo.
2. Na mesma UoW: receber inbox → reutilizar FinancialService/locks → persistir transação,
   saldo/versão/ledger → inserir eventos → concluir inbox → commit.
3. Só então DeleteMessage. PENDING_REFERENCE confirma aceite durável, sem movimento.
4. Se o commit retornar indisponibilidade, consultar inbox/hash/transação em snapshot
   read-only. Resultado confirmado permite ACK; ausência/indisponibilidade permite retry.
5. Publisher reserva eventos em transação curta, envia fora dela e marca publicado
   somente com confirmação do SQS e claim válido por owner/attempt/lease.

Outbox tem sequência persistida por wallet. Um evento anterior pendente, em lease ou
esgotado impede ultrapassagem na mesma wallet. Carteiras distintas avançam em paralelo.
O lote seleciona no máximo um evento por wallet. O lease deve superar duas vezes o
timeout de dependência; configuração incompatível é recusada. Publication attempts são
contadas no claim, inclusive se o processo morrer antes do envio. IDs nunca são recriados.

Falha transitória não vira REJECTED. Falha depois do commit/antes do ACK deixa redelivery
resolver a identidade existente. Falha no ACK após commit não faz cópia explícita para
DLQ. Redrive nativo continua aplicável se o processo morrer repetidamente.

Não há subscriber de produto para eventos nesta etapa. O teste de projeção usa um
consumidor real com inbox SQL e efeito na mesma transação, inclusive entregas que passam
fora da deduplicação do broker. Integrações futuras precisam adotar esse padrão.

## Retry, DLQ e operação

Backoff exponencial com equal jitter: metade do teto exponencial mais jitter até o teto,
arredondado para segundos e limitado por MESSAGING_RETRY_CAP_SECONDS. Consumer altera a
visibilidade; heartbeat mantém mensagens em andamento invisíveis. Um receive por loop
evita ultrapassar uma falha dentro de um batch da mesma wallet. Polling de dependências
reconecta com backoff; o limite por mensagem é SQS_MAX_RECEIVE_COUNT.

No último recebimento, mensagem sem processamento confirmado é enviada à DLQ, com corpo
original e atributos ErrorCode, ConsumerName, OriginalMessageId e Attempt. Só após envio
confirmado a origem é removida. Isso é transferência durável para diagnóstico, sem
processamento financeiro. Redrive nativo é o fallback em crashes; nesse caso os atributos
adicionais podem não existir. Rejeição financeira válida é confirmada normalmente.

O publisher tenta cada registro até OUTBOX_MAX_ATTEMPTS. Esgotados ficam no PostgreSQL,
com payload/eventId intactos e diagnóstico em last_error_code quando a falha pôde ser
registrada. Crash no último claim também deixa o evento durável/esgotado, mesmo sem erro
registrado. A DLQ de eventos atende redrive de subscribers; falhas de envio da outbox
permanecem no banco, porque não se pode depender do SQS para registrar sua indisponibilidade.

Inspeção SQL, com acesso operacional autorizado:

```sql
SELECT id, aggregate_id, event_type, attempts, lease_owner, lease_until,
       next_attempt_at, last_error_code
FROM wagering.outbox_messages WHERE published_at IS NULL ORDER BY position;
```

Reprocessamento da DLQ:

1. Inspecionar a fila correta em ambiente controlado, evitando imprimir payloads em logs.
2. Identificar/corrigir a causa: schema/grupo inválido, conflito de identidade ou dependência.
3. Para envelopes válidos, reenviar o corpo original à fila de origem mantendo messageId,
   idempotencyKey, identidade financeira e GroupId. Usar um DeduplicationId estável para
   aquela operação de replay, diferente do envio original se dentro da janela do broker.
4. Só remover a cópia DLQ depois de confirmar o reenvio. Se a confirmação for perdida,
   repetir o mesmo replay com a mesma identidade. Nunca alterar saldo/ledger para destravar.
5. Mensagens inválidas exigem correção explícita; conflitos de um messageId já concluído
   não podem ser resolvidos trocando seu payload. Uma nova operação exige nova identidade.
6. Conferir inbox, estado financeiro, reconciliação e eventos publicados.

Para outbox esgotada, corrigir o destino e ampliar explicitamente OUTBOX_MAX_ATTEMPTS
acima das tentativas persistidas; reiniciar publishers. A elegibilidade volta sem zerar
contadores ou mudar eventId. Um lease vigente deve expirar antes da retomada. Não marcar
published_at manualmente. Não há comando automático que purgue DLQ ou apague histórico.

## Shutdown e observabilidade

SIGTERM/SIGINT interrompem polling, aguardam trabalho adquirido e fecham SQS/pool.
WORKER_SHUTDOWN_TIMEOUT_MS limita drenagem; prazo excedido termina o processo com exit 1.
O Compose usa stop_grace_period 15s; ao aumentar o prazo de drenagem, ajustar também o
grace period. SIGKILL dispensa hooks: SQL faz rollback do que não confirmou e broker/
leases recuperam pendências. Os hooks de crash existem apenas no harness de teste.

Logs JSON incluem correlationId/messageId/transactionId/walletId/providerId quando
válidos, consumerName, attempt, durationMs, result e errorCode, sem payload, receipt,
credenciais ou erro bruto do driver. Snapshots de métricas a cada 10s incluem received,
processed, duplicates, transientFailures, invalid, permanentFailures, dlqForwarded,
published, publicationFailures, outboxPending, outboxExhausted, outboxOldestAgeMs,
processingDurationMs e processingCount. dlqForwarded conta transferências confirmadas
pelo worker; redrive nativo requer observar a profundidade da DLQ no broker. Métricas
são por processo, sem exporter/agregação ou SLO. Workers não têm servidor HTTP próprio.

## Validação e limites

Comandos de regressão e resultados completos em [../VALIDATION.md](../VALIDATION.md).
Os testes usam PostgreSQL 17 e LocalStack reais em projeto Compose descartável. Incluem
SIGKILL após commit/antes de ACK, SIGKILL após envio/antes da marcação, rollback, dois
publishers, três consumers, DLQ, reinício, confirmação de commit incerto e SIGTERM em voo.
O teste de commit incerto simula perda da resposta após commit real; não injeta uma falha
de rede física exatamente durante COMMIT. Duplicatas de eventos além da janela do broker
são representadas por DeduplicationIds de transporte diferentes, sem esperar cinco minutos.

A aplicação de desenvolvimento existente não é atualizada automaticamente pelos testes.
Deploy local é `bun run stack:up` ou `bun run stack:scale`, com bootstrap/migrations via jobs
documentados. A Etapa 6 acrescentou o scheduler descrito em [PENDING_REFERENCES.md](PENDING_REFERENCES.md).
Antes desse upgrade, drenar writers antigos conforme README; os contratos de eventos v1
e as identidades de inbox/outbox desta etapa permanecem os mesmos.

Referências: [semântica FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)
e [visibilidade SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html).
