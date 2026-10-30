# Matriz após remediação 8.1 — enunciado original

Fonte exclusiva dos requisitos: [CHALLENGE.md](../CHALLENGE.md). Data: 29/10/2026.
Fonte atual: remediações aprovadas de identidade, dependências e classes de mensageria;
política financeira, migrations e Composes preservados.

PASS = verificação executada e aprovada; FAIL = teste/verificação de conformidade
executada e reprovada; BLOCKED = execução impedida por dependência/ambiente;
NOT_TESTED = não executada. FAIL de inspeção de conformidade não é contabilizado
como falha de um teste Bun. Resultados funcionais e conformidade literal são distintos.

Evidências: **T** = [TESTS.txt](TESTS.txt), resultados individuais atuais de 183
unitários/101 integrações; **D** = [distributed-evidence.json](distributed-evidence.json),
11 cenários + preparação/recuperação/carga atuais; **P** =
[delivery-smoke.json](delivery-smoke.json), imagem final/Compose em instalação nova;
**A** = [RESULT.md](RESULT.md), remediação, inspeções e limites. Caminhos de
teste abreviados abaixo são de test/unit/ ou test/integration/, como indicado.

| ID / seção original | Requisito | Implementação / arquivos | Teste/verificação executada e resultado | Evidência reproduzível | Status | Risco residual |
|---|---|---|---|---|---|---|
| C01 §4 | Bun 1.x | package.json; Dockerfile | bun --version=1.4.4 e build em oven/bun | T; clean-install.txt | PASS | Binário local portátil não é parte da entrega |
| C02 §4 | TypeScript strict | tsconfig.json; tsconfig.build.json | typecheck e build executados, exit 0 | T | PASS | Não substitui testes de runtime |
| C03 §4 | NestJS | app.module.ts; bootstrap.ts; controllers | Nest 11.2.8 instalado; HTTP real e smoke compilado passaram | T; P | PASS | Sem IdP, ver C45 |
| C04 §4 | PostgreSQL real | orm-options.ts; Docker Compose | PostgreSQL 17.11, ACID/SQL reais; instalação nova passou | T; P | PASS | Sem failover/backup/perda física de disco testados |
| C05 §4 | ORM permitido | MikroORM 6.6.17; repositories/mappers | Dependência instalada e transactional/locks exercidos | T; A | PASS | SQL explícito convive com EntitySchema por decisão documentada |
| C06 §4/10 | SQS FIFO via LocalStack | sqs.service.ts; queue-setup.ts | LocalStack 4.12.0; protocolo FIFO/filas/redrive passaram | T fifo_protocol; D | PASS | Não equivale à AWS real |
| C07 §4 | Docker Compose | três Composes; Dockerfile | config válido; instalação limpa do Compose principal isolado passou | P; A | PASS | Principal existente continua antigo |
| C08 §4 | Migrations versionadas/reversíveis | migrations/; scripts/migrate.ts | up/down/up em banco vazio e recusa de down destrutivo passaram | T official migration/backfills | PASS | Down com histórico é deliberadamente recusado |
| C09 §5.8/8/13 | ≥3 instâncias independentes | docker-compose.distributed-test.yml; orm-options | Três containers API, pools/backend PIDs distintos; 11 papéis saudáveis | D three_container_identities_and_health; P | PASS | PID Docker é init; backend identifica conexão real |
| C10 §6.1/5.1 | Money exato/imutável, moedas, entradas inválidas | domain/money/money.ts; financial-sql.ts | Unitários Money e SQL escala/overflow/NaN/negativos passaram | T | PASS | Escala fixa de dois para o exercício |
| C11 §6.0–6.4 | Encapsulamento/factories/rehydrate do domínio financeiro | domain/wallet, wagering, ledger | Imutabilidade/factories e reidratação sem movimento passaram | T domain/* | PASS | Registros ORM são DTOs distintos do domínio |
| C12 §7 | BET/WIN/LOSS/REFUND/ROLLBACK | FinancialPolicy; FinancialService | Regras positivas/negativas e HTTP passaram | T; D A–E | PASS | Restrição adicional de reversão, C22 |
| C13 §6.3/9 | OPENING interno e abertura atômica | FinancialPolicy.openWallet; DTO/envelope | Positiva com ledger, zero sem ledger e OPENING externo recusado | T financial/http/domain/messaging | PASS | POST /wallets não oferece replay por chave |
| C14 §6.3 | Estados terminais imutáveis | WagerTransaction; triggers | PROCESSED/REJECTED/FAILED recusam transições/SQL; replay FAILED testado | T | PASS | FAILED persistível; não é destino automático de toda mensagem inválida |
| C15 §6.4/5.5 | Ledger append-only | ledger domain/repository; grants/triggers | Runtime e owner sem desativar proteção não alteram/apagam/truncam | T runtime ledger/owner cannot | PASS | Administrador com poder de DDL é limite de confiança |
| C16 §6.5/6.0 | Classes Inbox/Outbox com factories/estado encapsulado | domain/messaging/*; message-repositories.ts; outbox-store.ts | Factories, rehydrate, imutabilidade, terminais e retry sem dupla contagem testados; integração SQL/crash passou | T message-state; T/D mensageria | PASS | Claims/leases/fencing permanecem SQL; assinaturas adaptadas ao protocolo existente |
| C17 §6.2/5.9 | Saldo não negativo no schema | financial-sql.ts; Wallet | Constraints SQL, duas BET e rollback sem saldo passaram | T; D A/E; P | PASS | Escopo de privilégios inspecionado |
| C18 §6.2 | Versão inicial 1; só muda com saldo | Wallet; wallet repository; triggers | Zero/positiva, LOSS/rejeição/no-op e versões ilegais passaram | T | PASS | Limite BIGINT guardado na aplicação/banco |
| C19 §6.2/6.4 | Saldo ↔ ledger ↔ snapshot no mesmo commit | UoW; triggers diferidos | Seis falhas transacionais e constraints no COMMIT passaram | T transactional_fault | PASS | Não prova proteção contra administrador que desative triggers |
| C20 §7.2/7.5 | Referência com mesmo contexto e valor integral | FinancialPolicy.validateReference; SQL | Provider/player/wallet/moeda/round/valor inválidos recusados | T pending C/provider namespace | PASS | gameId não é requisito de igualdade de referência |
| C21 §7.3 | Kinds de referência elegíveis | FinancialPolicy; guard SQL | REFUND só BET; ROLLBACK BET/WIN/REFUND; demais rejeitados | T | PASS | Referência ausente pode aguardar |
| C22 §7.4 | Unicidade por referência/tipo | validateReference; transactions_one_reversal_uq | Repetição do mesmo tipo bloqueada; cruzada também bloqueada; manutenção aprovada na Etapa 8.1 | T reversões; D D; RESULT | PASS | Restrição adicional documentada; aprovação interna não é aceite externo do avaliador |
| C23 §7.3 | ROLLBACK de REFUND | FinancialPolicy; check_ledger_entry | Débito inverso permitido com fundos e sem reabrir BET; SQL/reconciliação passaram | T ROLLBACK of REFUND | PASS | C22 limita compensação direta adicional |
| C24 §7.9 | Rejeição de reversão que negativaria saldo, código distinto | FinancialPolicy; FailureCode | REVERSAL_INSUFFICIENT_FUNDS sem ledger ou mudança de saldo | T; D E | PASS | Terminais rejeitados não são reabertos |
| C25 §7.1 | PENDING_REFERENCE, scheduler, backoff, TTL/limite e REJECTED | pending policy/repository/scheduler | 20 integrações de pendência e três schedulers reais passaram | T; D pending/restart | PASS | Relógio sincronizado em operação; ciclos terminam por TTL/orçamento |
| C26 §9/5.2 | Idempotency-Key global persistente | FinancialService.identify; índice global | Chave entre wallets, payload divergente, identidade/chaves cruzadas passaram | T; D idempotency | PASS | Sem alias de chave; clientes precisam manter identidade |
| C27 §9 | Hash canônico do payload de negócio | payload-hash.ts | v1/ordem estável/null/alterações de negócio testados | T Canonical payload hash | PASS | Array de ordem fixa é a canonicalização documentada |
| C28 §7.7/9 | Replay histórico preservado | terminal_result; financial-responses.ts | Saldo posterior diferente, pendência resolvida e restart mantêm snapshot | T; D historical/restart | PASS | Headers de tracing pertencem à requisição atual |
| C29 §6.3/5.9 | Identidade externa única | índice provider_id/external_transaction_id | Unicidade SQL e 50 duplicatas HTTP/SQS passaram | T; D B | PASS | Namespace é do provider |
| C30 §5.6/5.7/8 | Concorrência por wallet sem lock global/lost update | wallet repository; UoW | Duas BET e B com A bloqueada passaram em processos/containers | T; D A/C | PASS | Multiwallet arbitrária não é use case implementado |
| C31 §6.5/10/11 | Inbox + financeiro + ledger + outbox atômicos | FinancialService.submit; repositories | Falhas/inbox/50 duplicatas/SIGKILL passaram | T; D SQS | PASS | Forma de classes difere, C16 |
| C32 §11/5.4 | Outbox pós-commit; publishers concorrentes | outbox-store/publisher | Dois publishers, lease/fencing, send antes da marcação e recuperação passaram | T two_publishers/publisher crash; D | PASS | Outbox esgotada exige intervenção, sem descarte |
| C33 §10 | ACK somente após commit | TransactionConsumer | SIGKILL após commit antes do ACK: redelivery sem segundo efeito | T consumer_sigkill_after_commit | PASS | Redrive nativo pode aplicar após crashes repetidos |
| C34 §10 | Retry limitado/backoff/DLQ | retry.ts; consumer; queue-setup | FIFO DLQ real, envelopes inválidos, rejeição ACKada e retries passaram | T; D | PASS | DLQ copy/ACK não é exatamente uma vez |
| C35 §3/11/13 | Recuperação após crash/reinício | consumer/publisher/scheduler; runners | SIGKILL de fronteira e 11 containers com exit 137; backlog retomado | T; D abruptExit/restart | PASS | Partição física no exato COMMIT não reproduzida |
| C36 §9 | POST/GET wallets e GET ledger paginado | WalletsController; query service | Rotas, abertura, conflito e cursor estável entre réplicas passaram | T HTTP | PASS | Cursor não é credencial/autorização |
| C37 §9 | POST transação e dois GETs | TransactionsController | Consulta interna/externa, status/replay/erros passaram | T HTTP | PASS | Acesso local sem autenticação, C45 |
| C38 §9/13 | Reconciliação, divergência diagnosticada/log/métrica | reconciliation.ts; WalletsController | Históricos e fixtures inconsistentes passaram, sem reparo silencioso | T; D carga; P | PASS | Corrupção é fixture isolada, não desativação de triggers |
| C39 §9/12 | Liveness público separado | HealthController | 200 mesmo com dependências inacessíveis | T smoke/bootstrap; D; P | PASS | Liveness não indica banco pronto |
| C40 §9/12 | Readiness PostgreSQL/SQS | DatabaseService; SqsService | Schema-only=503, schema completo/filas=200; cada dependência inacessível=503 | T foundation; D; P | PASS | Probe não audita toda ACL/trigger de produção |
| C41 §9 | DTOs/contratos de entrada corretos | financial-dtos; parseCommand | Whitelist, tipos, Money, referência, headers repetidos e limites passaram | T unit/HTTP/messaging | PASS | Sem coerção monetária |
| C42 §9/7.2 | Erros financeiros/operacionais distinguíveis | exception filter; submissionStatus; FailureCode | 400/404/409/422/202/500/503 e snapshots rejeitados passaram | T HTTP | PASS | Erro desconhecido é sanitizado, detalhes só por diagnóstico seguro |
| C43 §12 | Logs JSON com IDs aplicáveis e sem dados sensíveis | JsonLogger; bootstrap; workers | Unitários de redaction e validação JSON/IDs/códigos/duração passaram | T; D logValidation | PASS | Não é scanner universal de segredos ou tracing distribuído completo |
| C44 §12 | Métricas status/duplicatas/retries/DLQ/locks/outbox lag/latência | FinancialMetrics; Http/Messaging/Pending metrics | Transições pós-commit, rollback/replay e deadlock real; snapshots observados | T financial metrics/deadlock; D metricSnapshots | PASS | Voláteis por processo; sem exporter e possíveis lacunas em commit incerto |
| C45 §2 | Opção sem IdP com extensão explícita em código | NoopProviderIdentityGuard; AppModule; controllers financeiros | Teste de composição nega todas as sete rotas financeiras e mantém health público; HTTP real preservado | T identity-extension; T HTTP; P | PASS | Guard no-op não autentica nem autoriza; local somente |
| C46 §11 | Eventos mínimos e IntegrationEvent abstrata/subclasses | application/messaging/integration-event.ts | Processed inclusive LOSS, Rejected, PendingReference, BalanceChanged apenas com ledger | T messaging/typed events | PASS | Não há evento financeiro para replay ou abertura zero |
| C47 §10 | SIGTERM drena em andamento | workers/main.ts; consumer | SIGTERM com operação bloqueada e entrypoints compilados passaram | T SIGTERM drains/production worker | PASS | Deadline pode encerrar abruptamente; integridade não depende do hook |
| C48 §13 | 50 duplicatas simultâneas e disputa 100/80/80 | financeiros/HTTP/distributed | Um débito entre 50; uma BET 80 processada e outra rejeitada | T; D A/B; P | PASS | Somente carga pequena local |

Todas as 48 verificações estão PASS após a remediação aprovada. Os 284 testes Bun finais e a suíte distribuída sustentam os resultados; as falhas iniciais estão preservadas em INITIAL-FAILURES.json e explicadas em RESULT.md. Não se promete ausência de vulnerabilidades futuras ou aceite externo de toda interpretação de negócio. AWS real, failover, restore, perda de disco e IdP completo não foram testados e não são requisitos obrigatórios desta entrega. Parecer em FINAL_REVIEW.md (raiz).
