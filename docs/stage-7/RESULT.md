# Etapa 7 — validação final, 29/10/2026

**Parecer: APROVADO COM RESSALVAS para o escopo local do desafio.** Os critérios de
aceite foram demonstrados nas suítes executadas. A implantação principal continua
defasada e preservada; esta aprovação não é de deploy nem de capacidade de produção.
Não houve nova funcionalidade de negócio, migration, grant ou mudança financeira.

## Resultado e evidências reproduzíveis

A auditoria inicial [AUDIT.md](AUDIT.md) foi seguida da aprovação expressa do
[plano](PLAN.md). A matriz atual está em [MATRIX.md](MATRIX.md). Resultados por teste
e cenários de falha estão em [FINAL-TESTS.txt](FINAL-TESTS.txt); IDs, estados, saídas
137, métricas e logs selecionados em [distributed-evidence.json](distributed-evidence.json).
A execução independente do comando de carga está em [load-evidence.json](load-evidence.json).
[source-hashes.json](source-hashes.json) identifica os arquivos exatos executados.
O working tree já estava alterado nas etapas anteriores; não houve commit ou push.

| Verificação final | Resultado |
|---|---|
| Typecheck/build/smoke emitido | PASS; live 200, ready sem dependências 503, saída por sinal 143 |
| Unitários | 176 PASS, 0 FAIL; 1.545 assertions |
| Integração PostgreSQL/LocalStack | 101 PASS, 0 FAIL; 1.304 assertions; 72,96 s |
| Composição da integração | 8 fundação, 38 financeiros, 19 HTTP, 16 mensageria, 20 referências |
| Total Bun test | 277 PASS, 0 FAIL; 2.849 assertions |
| Runner distribuído | 11 cenários funcionais + preparação de backlog + recuperação + carga: 14 verificações PASS |
| Carga standalone | Uma repetição independente PASS, sem somá-la como novo teste distinto |
| Bloqueados/não executados nos critérios de aceite | Nenhum; limites experimentais descritos adiante |
| Limpeza dos projetos de teste | PASS; containers/rede exclusivos removidos, sem down -v |

Comandos executados na raiz, com Bun e Docker no PATH:

```text
bun run test:build
bun test test/unit
bun run test:integration:docker
bun run test:distributed:docker
bun run test:load
docker compose config --quiet
docker compose -f docker-compose.distributed-test.yml config --quiet
git diff --check
```

Ambiente: Windows/PowerShell, Bun 1.4.4, TypeScript 5.9.3, Docker client/server
29.9.2, Compose v5.6.1; PostgreSQL 17.11-alpine e LocalStack 4.12.0 reais. A imagem
de teste é construída pelo Dockerfile existente. Projeto de integração final
`jungle-financial-test-bdbbd37c`; distribuído `jungle-distributed-test-146a4069`;
carga independente `jungle-distributed-test-1e158f6f`. Cada um tem PostgreSQL/tmpfs
e LocalStack próprios, sem portas publicadas, volume de desenvolvimento ou socket
Docker montado. A aplicação usa role runtime restrita; administração é exclusiva
dos jobs/harness descartáveis. Migrations existentes são executadas só nos bancos
de teste. Credenciais locais sintéticas não são secrets de produção.

## Três instâncias e workers efetivamente executados

| API | Instance ID/container | PID inicial do container no host Docker | Backend PostgreSQL observado |
|---|---|---|---|
| app1 | 71c88e996cef | 66458 | 109 |
| app2 | 203f1907c033 | 65937 | 100 |
| app3 | 4cf059209025 | 66359 | 108 |

São três containers/processos com conexões próprias. O backend é vinculado ao
hostname por application_name, sem endpoint de diagnóstico exposto no produto.
O PID da tabela é State.Pid do Docker (init), não o PID interno do processo Bun.
Também rodaram três consumers, dois publishers e três schedulers: 11 containers de
aplicação/worker ao todo, saudáveis antes do teste, após reinício e ao final.
IDs/PIDs/timestamps de cada um estão no JSON de evidências. Workers de produção são
supervisionados apenas na imagem de teste para observar startup e heartbeat; esse
probe é liveness operacional e não comprova sozinho processamento financeiro.

## Concorrência, idempotência e integridade financeira

| Cenário entre containers | Resultado observado |
|---|---|
| A — duas BET 80.00 sobre 100.00 | Uma PROCESSED, outra REJECTED/INSUFFICIENT_FUNDS; saldo 20.00, versão 2, um débito e reconciliação consistente |
| B — 50 duplicatas HTTP | 50 respostas 200, uma original, 49 replays; uma identidade e um débito, saldo 90.00; corpos iguais salvo idempotentReplay |
| C — wallets independentes | B confirmou enquanto lock SQL explícito continuava retendo A; ambas reconciliaram após liberar A |
| D — REFUND/ROLLBACK concorrentes | Uma compensação, outra rejeitada; saldo 100.00 e três entradas contando abertura |
| E — reversão sem fundos | REJECTED/REVERSAL_INSUFFICIENT_FUNDS, saldo zero preservado, sem lançamento da rejeição |
| Variações de identidade/chave | Payload divergente, identidade com outra chave e chave entre wallets deram 409 |
| Replay após novo saldo | Snapshot 90.00 preservado com saldo atual 140.00 |
| Replay após resolução de pendência | Mesmo transactionId; snapshot 100.00 preservado com saldo atual 150.00 |
| Replay terminal após crash/reinício de todas as APIs | Operação persistida antes do crash retornou idempotentReplay=true e 90.00, com saldo atual 140.00 |
| Inbox/SQS | 50 envios com dedup IDs de transporte diferentes, uma inbox/identidade e um débito; logs confirmaram processamento e ACK das entregas |
| FIFO por carteira | Três comandos enviados em sequência tiveram ledger na mesma ordem, saldo 70.00 e quatro entradas |

A regressão também cobriu abertura zero/positiva, LOSS, versões, direção, equações,
before/after, referências inválidas/rejeitadas/pendentes/expiradas, TTL, backoff,
orçamento de tentativas, três schedulers concorrentes e reconciliação sob escrita.
Fixtures unitárias diagnosticam inconsistências; nenhum trigger foi desativado
para fabricar corrupção em banco existente. Ledger/grants/constraints continuam
protegendo imutabilidade e não-negatividade no PostgreSQL.

## Falhas transacionais e commit desconhecido

Seis pontos distintos do harness falharam em PostgreSQL real: antes do INSERT,
depois do INSERT, depois da wallet, depois do ledger, durante a preparação parcial
da outbox e depois de todas as escritas antes do commit. Cada caso conferiu saldo
100.00, ausência da identidade/inbox/ledger de débito e apenas os dois eventos de
abertura na outbox. Retry com a mesma identidade aplicou uma vez, saldo 90.00 e
reconciliação consistente. A instrumentação existe somente no teste.

Outra conexão foi terminada realmente com pg_terminate_backend imediatamente após
as escritas e antes do COMMIT. O cliente tratou a falha como resultado desconhecido,
consultou a identidade em conexão nova, encontrou ausência e só então repetiu. O
teste separado de resposta perdida depois de commit real encontrou a inbox e
confirmou sem repetir o efeito. Assim, tanto ausência quanto confirmação persistida
foram exercitadas; exceção de transporte não foi usada como prova de rollback.
Não se afirma falha física exatamente durante a execução do COMMIT no servidor.

## Crash e recuperação

| Fronteira | Evidência |
|---|---|
| Consumer após commit/antes do ACK | SIGKILL no processo independente; redelivery resolveu inbox persistente, sem segundo débito |
| Publisher após send/antes da marcação | SIGKILL; lease expirou, novo processo publicou com o mesmo event ID; fencing recusou owner antigo |
| Scheduler durante claim | SIGKILL liberou lock/claim; outro processo retomou sem consumir tentativa desfeita |
| Scheduler antes/depois do commit | Antes: rollback de saldo, ledger, status e eventos; depois: terminal não repetiu efeito |
| Todos os papéis | 11 containers receberam SIGKILL e saíram com código 137; reiniciaram com novos timestamps, sem confundir com SIGTERM |
| Backlog durante parada completa | Seis mensagens SQS, seis referências pendentes e 18 eventos outbox foram persistidos enquanto os 11 papéis estavam parados |
| Recuperação do backlog | Seis BET + seis REFUND concluíram; carteiras voltaram a 100.00, sem duplicação; outbox esvaziou e replays históricos continuaram estáveis |

Os crashes nas fronteiras exatas usam os harnesses de processos independentes da
integração, sem substituir o banco/broker. O cenário conjunto mata containers reais
no Compose novo. Dois publishers reais disputaram claims/leases. A regressão do
subscriber deduplica persistentemente o event ID mesmo quando a deduplicação do
SQS é contornada. Esse teste de efeito idempotente e o crash do publisher são casos
separados; não se afirma entrega exatamente uma vez pelo transporte.

## Observabilidade e defeitos corrigidos

| Achado comprovado | Severidade / correção | Validação |
|---|---|---|
| Readiness aprovava namespace sem tabelas financeiras | P2: probe agora exige acesso às cinco tabelas e colunas operacionais essenciais | Regressão schema-only=503, schema completo=200; live continua 200 sem dependências |
| Faltavam contadores financeiros por status, conflito de chave e retry/lock SQL | P2: FinancialMetrics na UoW, observada depois do commit; captura conflitos, retries, lock conflicts e falhas transitórias | Replay/rollback excluídos de novos efeitos; deadlock real incrementa retries/locks; conflito de chave e status conferidos |
| Publisher confundia eventId com messageId; erro HTTP omitia código estável; operação ausente em fluxos | P3: IDs separados, operation/result/errorCode e duração; API também publica snapshots | Validação de JSON/IDs/código/duração no runner distribuído |

O consumer já tinha transactionId; a suspeita inicial de ausência foi corrigida na
auditoria. Não houve defeito financeiro crítico reproduzido ou política financeira
alterada. A primeira execução distribuída falhou no harness porque MikroORM expandia
uma lista em ANY(?) de forma inválida; foi corrigido para IN (?) e repetido. Um erro
de tipagem no snapshot de métricas e no wrapper genérico também foi corrigido antes
da execução final. Nenhuma dessas falhas foi contada como aprovação.

O runner final validou 852 registros JSON, incluindo 83 logs de entregas confirmadas
do consumer e 289 de publicação. Snapshots por processo cobriram processed/rejected,
conflitos de idempotência, duplicatas, publicações, falhas transitórias, retries/locks,
outbox depth/lag, pendências e duração. Exemplos e valores reais estão nos JSONs e
nos testes de deadlock/métricas. Os logs de API/workers são emitidos a cada 10s.
Não foi adicionado Prometheus, Grafana, exporter ou dependência externa.

FinancialMetrics conta transições de comandos externos observadas após commit na
UoW, incluindo resolução de pendências; não conta OPENING nem replay como transação
nova. Reagendamento sem mudança de status não incrementa pendingReference novamente.
commits inclui UoWs sem efeito, como polling vazio, e não é quantidade de transações
financeiras. Contadores são voláteis e por processo; commit confirmado cuja resposta
foi perdida pode faltar na observação daquele processo. O ledger é a fonte de
auditoria, não esses contadores. O contador legado MessagingMetrics.processed continua
significando comandos confirmados, inclusive rejeições e duplicatas de negócio.

## Carga controlada

Um burst reproduzível com 24 wallets independentes, 20 BET disputando 100.00 em uma
wallet, 50 duplicatas HTTP em outra e 12 wallets recebendo duas entregas SQS cada.
Criação das 38 wallets fica fora da janela de carga. A janela inclui HTTP, envio e
ACK das mensagens e drenagem da outbox; reconciliação final ocorre depois. Não há
meta de RPS, warmup ou inferência de capacidade de produção. Percentis usam nearest
rank: ceil(p*N), com amostras separadas por canal.

| Medida | Execução distribuída | Repetição standalone |
|---|---|---|
| Operações de transporte | 118: 94 HTTP + 24 envios SQS | 118 |
| Sucesso HTTP | 75/94 = 79,79% | 75/94 = 79,79% |
| Rejeições financeiras esperadas | 19/94; saldo insuficiente | 19/94 |
| Erros operacionais | 0 | 0 |
| Transações externas distintas | 57: 38 processadas + 19 rejeitadas | 57 |
| Duração observada | 2.315,90 ms | 2.716,65 ms |
| Throughput de transporte | 50,95 operações/s | 43,44 operações/s |
| HTTP p50/p95/p99 | 456,04 / 687,89 / 708,47 ms | 648,80 / 825,90 / 895,03 ms |
| Envio SQS p50/p95/p99 | 357,17 / 364,62 / 367,24 ms | 353,33 / 372,76 / 373,55 ms |
| Primeira conclusão SQS p50/p95/p99 | 532,44 / 643,26 / 643,26 ms | 592,70 / 750,96 / 750,96 ms |
| Outbox antes da drenagem final | 79 pendentes; mais antigo 751,04 ms | 91 pendentes; mais antigo 800,55 ms |
| Outbox final | 0; 171 eventos publicados | 0; 171 eventos publicados |
| Reconciliação final | 38/38 consistentes | 38/38 consistentes |

HTTP 200 inclui 49 replays; a taxa de sucesso acima não significa percentual de
novos efeitos financeiros. Todas as respostas HTTP foram 200 ou 422 esperados.
Cada envio SQS inclui resolução de QueueUrl; a conclusão assíncrona vai do início
do envio até observação de inbox confirmada, com polling de até 50ms. A observação
de lag é uma amostra anterior à drenagem, não o pico do experimento. Throughput
usa operações de transporte, não transações distintas por segundo. A repetição
standalone comprova o comando de reprodução e não constitui benchmark estatístico.

## Arquivos alterados nesta etapa

Alterações anteriores preservadas não são atribuídas à Etapa 7. Arquivos novos ou
editados após a aprovação:

- Ambiente/reprodução: `docker-compose.distributed-test.yml`,
  `scripts/distributed-test-docker.ts`, `scripts/load-test.ts`, `package.json`.
- Cenários: `test/distributed/support.ts`, `scenarios.ts`, `restart.ts`, `load.ts`;
  `test/support/distributed-worker.ts`, `distributed-worker-health.ts`;
  `test/integration/financial.test.ts`, `foundation.test.ts`, `messaging.test.ts`.
- Runtime: `src/bootstrap.ts`, `src/infrastructure/persistence/database.service.ts`,
  `financial-unit-of-work.ts`, `orm-options.ts`; `src/infrastructure/observability/financial-metrics.ts`,
  `json-logger.ts`; `src/infrastructure/messaging/outbox-publisher.ts`,
  `transaction-consumer.ts`; `src/infrastructure/pending-reference/reference-scheduler.ts`;
  `src/interfaces/http/exception.filter.ts`, `src/workers/main.ts`.
- Documentação: README, ARCHITECTURE, VALIDATION e os arquivos `docs/stage-7/`.

## Critérios de aceite e ressalvas

| Critério do pedido | Situação / evidência |
|---|---|
| 1. Build e typecheck | PASS, FINAL-TESTS |
| 2. Unitários e integração críticos | PASS, 277 testes |
| 3. Três instâncias independentes | PASS, containers + backend PIDs |
| 4. Concorrência preserva saldo | PASS, A–E e reconciliação |
| 5. Idempotência impede duplicação | PASS, HTTP/SQS/restart/snapshot histórico |
| 6. Inbox/outbox recuperam | PASS, SIGKILL, redelivery, leases e subscriber idempotente |
| 7. Scheduler resolve sem duplicação | PASS, três workers e backlog |
| 8. Crash comprovado | PASS, SIGKILL por fronteira e 11 saídas 137 |
| 9. Reconciliação confirma históricos | PASS, cenários críticos + carga |
| 10. Logs/métricas permitem diagnóstico | PASS, regressões e snapshots verificados |
| 11. Sem defeito financeiro crítico conhecido | PASS nesta execução; nenhum reproduzido |

Requisitos de aceite não atendidos: nenhum na validação local executada. Ressalvas:

- O principal tem imagem antiga, só migration inicial, filas ausentes e nenhum worker.
  Foi auditado, não atualizado. Upgrade operacional exige tarefa/autorização própria.
- Sem IdP externo, exporter agregado, histórico durável de métricas, SLA ou teste de
  infraestrutura de produção; essas extensões não foram introduzidas por preferência.
- Falhas próximas ao COMMIT cobrem conexão terminada antes e resposta perdida depois;
  o instante exato de uma partição física durante COMMIT não foi reproduzido.
- LocalStack não prova todos os comportamentos/limites de AWS SQS. Não se testou perda
  física de disco, restore de backup, failover PostgreSQL ou perda do estado do broker.
- Health de workers do harness observa startup/heartbeat; progresso exige os cenários
  e métricas funcionais. O Compose principal conserva o desenho anterior de probes.
- A identidade do instanceId usa hostname/pid; não é identidade autenticada. Relógios
  reais precisam estar sincronizados; TTL/jitter possuem testes determinísticos.

Recomendações para planejar a Etapa 8: definir separadamente se o objetivo será deploy
controlado do principal, identidade externa ou operação/monitoramento. Não foi iniciada
nenhuma dessas frentes, nem houve avanço automático de etapa.
