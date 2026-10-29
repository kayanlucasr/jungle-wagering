# Referências pendentes — Etapa 6

O scheduler retoma o mesmo registro financeiro. Não depende de replay HTTP, mensagem SQS
original invisível ou timer em memória para recuperar uma pendência após reinício.

## Estado e política

API e consumer persistem PENDING_REFERENCE, identidade/chave/hash, processing_attempts=1,
next_attempt_at, last_attempt_at e reference_deadline_at. Inbox e primeiro evento de
pendência pertencem ao mesmo commit; a mensagem SQS pode receber ACK imediatamente depois.
O prazo nasce na primeira transição, fica imutável e permanece no registro terminal.

| Situação na avaliação | Decisão |
|---|---|
| Prazo alcançado | REJECTED / REFERENCE_NOT_FOUND; sem movimento |
| Referência ausente ou não terminal, antes dos limites | Reagendar com backoff |
| Referência de contexto/tipo/valor inválido | REJECTED com código específico da FinancialPolicy |
| Referência REJECTED/FAILED | REJECTED / REFERENCE_NOT_PROCESSED |
| Referência PROCESSED válida e não revertida | Aplicar a política original na mesma transação |
| Última avaliação ainda não resolve | REJECTED / REFERENCE_NOT_FOUND |
| Indisponibilidade de infraestrutura | Rollback; nenhuma rejeição financeira automática |
| Estado já terminal | Não é candidato; replay retorna snapshot persistido |

Isso segue o item 7.1 de CHALLENGE.md, que exige REJECTED ao esgotar a referência. FAILED
não é usado para expiração/timeout. O código existente REFERENCE_NOT_FOUND identifica
a espera esgotada; logs distinguem expired_ttl de expired_attempts. Deadline, contador e
completed_at permanecem disponíveis para auditoria. A última avaliação antes do prazo
pode processar uma referência válida; uma referência que chega depois do prazo não revive
a operação. Fonte e dependente continuam sujeitos à exclusão REFUND/ROLLBACK aprovada.

Busca é por providerId + externalTransactionId. Um externalId idêntico em outro provider
não cria alias nem prova invalidade definitiva: a referência correta ainda pode chegar.
Wallet/player/currency/round/amount/kind são validados pela FinancialPolicy existente.
Não é adquirido lock da wallet de uma referência incompatível.

## Claim, atomicidade e recuperação

Uma transação READ COMMITTED faz:

1. SELECT de wallet com pendência elegível por next_attempt_at ou deadline, usando
   `FOR UPDATE OF w SKIP LOCKED`. EXISTS lê a transação por MVCC, sem travá-la.
2. Com a wallet travada, reconsulta e trava a linha da transação pendente elegível.
3. Consulta referência/histórico e chama a mesma execução/persistência usada por submit.
4. Confirma estado, saldo/versão, ledger, snapshot, contador, schedule e outbox juntos.

Sempre wallet → transaction. Consumer pode segurar inbox antes da wallet; scheduler não
trava inbox. Publisher não toma wallet durante claim de outbox. Não há lock global nem
rede SQS, espera por referência ou sleep dentro da tentativa. Cada item do lote tem commit
próprio; a pausa de polling ocorre fora de qualquer transação financeira.

O claim vive na própria transação curta, sem lease persistente adicional. SIGKILL antes
do commit faz rollback e libera locks; depois do commit, status terminal elimina o candidato.
Statement/lock timeouts existentes e PENDING_REFERENCE_IDLE_TIMEOUT_MS local limitam uma
sessão ociosa que sobreviva ao processo ou conexão. O teste mantém o processo antigo vivo
e comprova que outra instância recupera após o timeout PostgreSQL.

Não há contador exato de claims recuperados: um claim que sofreu rollback não deixa um
marcador durável, e não se confunde polling vazio com recuperação. A evidência é funcional,
com processos/locks/ledger reais. A correção não depende de hooks de shutdown.

## Backoff e configuração

| Variável | Padrão | Uso |
|---|---|---|
| PENDING_REFERENCE_TTL_SECONDS | 86400 | Prazo das novas pendências, desde a primeira transição |
| PENDING_REFERENCE_MAX_ATTEMPTS | 20 | Avaliações totais confirmadas, incluindo aceite inicial; mínimo 2 |
| PENDING_REFERENCE_BASE_SECONDS | 1 | Base exponencial |
| PENDING_REFERENCE_CAP_SECONDS | 300 | Teto de backoff |
| PENDING_REFERENCE_POLL_MS | 1000 | Pausa entre ciclos; mínimo 50ms |
| PENDING_REFERENCE_BATCH_SIZE | 20 | Máximo de tentativas/transações por ciclo |
| PENDING_REFERENCE_IDLE_TIMEOUT_MS | 10000 | Timeout local de sessão ociosa na transação |

Teto de delay = min(cap, base × 2^(attempt−1)). Equal jitter escolhe entre metade e todo
esse teto; next_attempt_at nunca ultrapassa o deadline. Relógio e jitter são injetáveis
para testes determinísticos. Contadores são inteiros operacionais; valores financeiros
continuam Money/string, sem number. Timeouts de infraestrutura fazem rollback, então não
gastam o orçamento financeiro. O worker reconecta com backoff limitado por delay; uma
indisponibilidade prolongada não é convertida em REJECTED. O deadline será avaliado quando
o PostgreSQL voltar a permitir uma tentativa confirmada.

TTL e orçamento são limites independentes; o orçamento pode terminar antes de 24h.
Alterar o TTL não estende prazos persistidos. Alterar o orçamento é uma decisão operacional
que afeta pendências ainda ativas. Manter relógios UTC dos hosts sincronizados; não há
serviço externo de tempo nesta implementação. Dimensionar pools considerando API,
consumers, publishers e schedulers multiplicados pelas réplicas.

## Eventos e replay

- WagerTransactionPendingReference somente na primeira entrada, nunca a cada retry.
- WagerTransactionProcessed ou WagerTransactionRejected ao concluir.
- WalletBalanceChanged somente com movimento/ledger efetivo.
- Mesmo contrato v1 e UNIQUE(transaction_id,event_type,event_version), sem novo ID em retry
  de publicação. Retry financeiro que sofre rollback não confirma nenhum evento.
- Correlação original é lida do primeiro evento de pendência na outbox. Legado sem evento
  usa `pending-` + md5(transactionId) como fallback determinístico, sem inventar ID do request.
- Replay HTTP/SQS enquanto pendente não incrementa tentativas nem inicia resolução.
  Após conclusão, retorna snapshot histórico mesmo após outros movimentos da wallet.

## Migration e operação

Migration `20261029000200`, após plano/DDL aprovados em docs/stage-6/:

- Uma coluna reference_deadline_at, CHECK de consistência, trigger de imutabilidade,
  índice parcial de prazos e grant UPDATE apenas da coluna nova.
- Backfill de pendências legadas para created_at + 24h, mantendo next_attempt_at existente
  ou usando created_at. Não altera status, saldo, versão, ledger ou resultado financeiro.
- Antes do DDL seguinte ao backfill, executa os triggers diferidos com SET CONSTRAINTS
  ALL IMMEDIATE e restaura ALL DEFERRED; nenhuma proteção é desativada.
- Down recusa remover deadline preenchido, inclusive de transação terminal, para não
  apagar histórico. Não excluir dados para tornar o rollback possível.

Parar/drenar writers antigos antes do upgrade: o novo schema exige deadline na transição
para pendência. Pendências legadas já vencidas serão rejeitadas pelo scheduler quando ele
iniciar. Conferir esse efeito antes de atualizar um ambiente existente.

```text
docker compose stop app consumer publisher pending-reference
bun run stack:scale
```

Stack scale agora inclui três schedulers. Para execução local com runtime/migrations já
preparados: `bun run worker:pending-reference`. Scheduler depende de PostgreSQL, não de
disponibilidade do SQS; seu startup valida role e schema, e os eventos aguardam o publisher.
SIGTERM/SIGINT interrompem novos claims e drenam a tentativa em voo dentro do prazo geral
de shutdown. Os testes não migram o banco ou alteram o .env de desenvolvimento.

Logs JSON de tentativa confirmada têm correlationId, transactionId, walletId,
referenceExternalTransactionId, attempt, nextAttemptAt, deadline, result, errorCode e
durationMs. Sem payloads, credenciais ou erros brutos do driver. Métricas por processo:
active, attempts confirmadas, resolved, rejected, expired, transientFailures,
processingDurationMs, completedCount, resolutionAgeMs e meanResolutionMs. Sem exporter
externo/agregação/SLO nesta etapa.

## Validação e limites

Os testes reais A–K e os casos adicionais estão em test/integration/pending-reference.test.ts.
Incluem backfill legado, SQL imutável, REFUND antes da BET com ACK SQS, ROLLBACK antes de WIN,
contexto/provider inválidos, referência rejeitada/ainda pendente, cadeias, prazo/orçamento,
três processos, SIGKILL em três pontos, sessão abandonada, replay HTTP histórico, reinício,
reversões concorrentes, wallets independentes, timeout PostgreSQL e SQS indisponível.

Tempos de negócio de TTL/backoff usam relógio controlado; crashes são SIGKILL reais de
processos e o timeout de sessão/lock vem do PostgreSQL real. A indisponibilidade de SQS
é um endpoint TCP real inacessível; não é um desligamento de toda a instalação LocalStack.
Três processos independentes no container de testes não são três containers implantados.
Resultados completos e arquivos alterados em [../VALIDATION.md](../VALIDATION.md).

Não há backfill de eventos antigos, política nova de reversão, frontend, autenticação
externa ou avanço automático para Etapa 7. Ciclos de referências ficam limitados pelos
mesmos prazos/orçamentos; não há detecção de ciclos, ordenação topológica ou SLO de resolução.
