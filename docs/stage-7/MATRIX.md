# Rastreabilidade — resultado da Etapa 7

Fonte: [enunciado original](../CHALLENGE.md). Execução de 29/10/2026 em
`jungle-financial-test-bdbbd37c`; resultados finais em [FINAL-TESTS.txt](FINAL-TESTS.txt).
Ambiente de 11 containers em [distributed-evidence.json](distributed-evidence.json).
O extrato [EVIDENCE.txt](EVIDENCE.txt) preserva a baseline anterior às alterações.
PASS refere-se ao requisito/cenário delimitado na linha, não à aprovação da etapa.
FAIL inclui lacuna demonstrada por inspeção, explicitada como tal; NOT_TESTED indica
ausência de execução e BLOCKED reserva trabalho dependente de aprovação.

| ID / origem | Requisito | Componente | Teste / resultado executado | Evidência | Situação |
|---|---|---|---|---|---|
| R01 §6.1 | Dinheiro exato, escala/moeda e entradas inválidas | src/domain/money/money.ts; migrations/financial-sql.ts | test/unit/domain/money.test.ts; financial.test.ts `money constraints`: passaram | EVIDENCE: Money / money constraints | PASS |
| R02 §6.2 | Wallet única, saldo e versão | domain/wallet; repositories/wallet-repository.ts | wallet.test.ts; financial `actual runtime role`, `zero opening`, `wallet identity/version`: passaram | EVIDENCE: testes correspondentes | PASS |
| R03 §6.3/7 | BET/WIN/LOSS e terminais | financial-service.ts; financial-policy.ts | financial/http `BET rejection`, `LOSS`, `terminal records`: passaram | EVIDENCE: grupos financeiros/HTTP | PASS |
| R04 §7 | REFUND/ROLLBACK e ausência de dupla compensação | financial-policy.ts; índice SQL | financial `E`, `ROLLBACK of WIN`; pending-reference `K`: passaram | EVIDENCE: reversões concorrentes e saldo negativo | PASS |
| R05 §6.4 | Ledger imutável e sem órfãos | wallet-ledger-entry.ts; triggers/grants | financial `runtime ledger`, `owner cannot`, `ledger FK`: passaram | EVIDENCE: testes de SQL/ledger | PASS |
| R06 §9/13 | Reconstrução e diagnóstico de inconsistências | application/financial/reconciliation.ts | unit/financial/reconciliation.test.ts; assertBalance/check nas integrações: passaram | EVIDENCE: diagnóstico e cenários financeiros | PASS |
| R07 §9 | Idempotência HTTP e snapshot histórico | TransactionsController; transaction-repository | http `mandatory historical replay`, `idempotency header`, `50 identical`, pending-reference `I`: passaram | EVIDENCE: http_historical_replay / 50_http_duplicates_3_replicas / pending_http_historical_replay | PASS |
| R08 §6.5/10 | Inbox atômico e duplicatas persistentes | message-repositories.ts; transaction-consumer.ts | messaging `A`, `B`, `lost commit response`: passaram | EVIDENCE: sqs_50_duplicates / consumer_sigkill_after_commit | PASS |
| R09 §11 | Outbox, claims, leases, ID estável | outbox-store.ts; outbox-publisher.ts | messaging `D`, `E`, `expired outbox lease`, `event consumer persists dedup`: passaram | EVIDENCE: two_publishers / publisher_sigkill_after_send | PASS |
| R10 §10 | SQS FIFO real, grupos, redelivery e ACK | sqs.service.ts; command-envelope.ts; consumer | foundation `connects to SQS`; messaging `A/B/F`: passaram | EVIDENCE: três consumers e redelivery real | PASS |
| R11 §10/12 | Retry limitado e DLQ | retry.ts; consumer; queue-setup.ts | unit/messaging; messaging `G`, `invalid envelopes`: passaram | EVIDENCE: real FIFO DLQ | PASS |
| R12 §7.1 | Pendências, prazo, backoff, tentativas e concorrência | reference-scheduler.ts; pending-reference-repository.ts | 20 integrações de pending-reference: passaram | EVIDENCE: refund_before_bet / three_pending_workers / testes G–K | PASS |
| R13 §8/13 | Concorrência real em ≥3 processos | UoW; lock por wallet | financial A/B/C/E; HTTP concurrency; messaging F: passaram | EVIDENCE: PIDs/backend PIDs no relatório | PASS |
| R14 §3/11/13 | Recuperação comprovada por crash | consumer/publisher/scheduler | SIGKILL consumer B, publisher E, scheduler G/H/claim: passaram | EVIDENCE: scenarios de crash; limites em AUDIT | PASS |
| R15 §12 | Observabilidade | HttpMetrics; MessagingMetrics; FinancialMetrics; JsonLogger; UoW | Métricas pós-commit/replay/rollback/conflito e deadlock real passaram; validação de JSON/IDs/códigos/duração no runner distribuído | FINAL-TESTS: stage7 financial metrics e deadlock; distributed-evidence.logValidation/metricSnapshots | PASS |
| R16 §9 | Endpoints financeiros obrigatórios | interfaces/http/*controller.ts | 19 integrações HTTP passaram, incluindo validação, consultas, ledger e reconciliação | EVIDENCE: grupo Stage 4 | PASS |
| R17 §4 | Migrations reversíveis sem perda | migrations; scripts/migrate.ts | foundation up/down/up; financial official migration; pending legacy/backfill: passaram | EVIDENCE: migrations e rollback recusado com histórico | PASS |
| S07-01 pedido §3 | Três containers de API + workers e health checks no Compose isolado | docker-compose.distributed-test.yml | 11 containers saudáveis; IDs/PIDs e três backend PIDs da API verificados antes/depois do reinício | distributed-evidence: initialInstances / restartedInstances / three_container_identities_and_health | PASS |
| S07-02 pedido §6 | Pontos de falha e desconexão próxima ao commit | financial.test.ts; harness de UoW | Seis injeções distintas e pg_terminate_backend real antes de COMMIT; consulta de identidade e retry seguro; resposta perdida após commit em messaging | FINAL-TESTS: transactional_fault / real_disconnect_before_commit / lost commit response | PASS |
| S07-03 pedido §10 | Crash/reinício conjunto dos papéis com backlog | scripts/distributed-test-docker.ts; restart.ts | 11 saídas 137; seis mensagens, seis pendências e 18 eventos aguardando; 12 operações recuperadas e replay histórico | distributed-evidence: abruptExit / restart_seed_all_roles_down / restart_all_roles_recovered | PASS |
| S07-04 pedido §12 | Readiness recusa schema financeiro parcial; liveness separada | database.service.ts; health.controller.ts | Schema-only 503, migrations completas 200; dependências indisponíveis 503; live 200 | FINAL-TESTS: grupo Stage 1; distributed-evidence health | PASS |
| S07-05 pedido §13 | Carga reproduzível, percentis, throughput e reconciliação | test/distributed/load.ts; scripts/load-test.ts | 118 operações, 19 rejeições esperadas, zero erro operacional, 38 carteiras reconciliadas e 171 eventos publicados | distributed-evidence: controlled_load; load-evidence.json | PASS |
| ENV-01 pedido §1 | Auditar implantação principal sem atualizar dados | Compose principal | APIs stage1 unhealthy, só migration inicial, filas e workers ausentes; condição registrada e ambiente preservado | AUDIT: estado real; RESULT: riscos | PASS |

Os arquivos de teste abreviados acima ficam em test/integration/, salvo indicação
unit/. As referências EVIDENCE das linhas R01–R14/R16–R17 podem ser conferidas também
em FINAL-TESTS, com os mesmos nomes de teste na regressão final. R14 é complementado
pelo cenário conjunto S07-03. S07-02 não afirma desconexão física no exato instante
do COMMIT: testa a conexão terminada imediatamente antes e resposta perdida depois,
sempre consultando identidade persistida. Testes de unidade com mocks não substituem
PostgreSQL/SQS reais. ENV-01 certifica a auditoria, não a saúde ou upgrade do principal.
Resultado global e ressalvas: [RESULT.md](RESULT.md).
