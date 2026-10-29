# Etapa 7 — auditoria inicial, 29/10/2026

Registro histórico anterior à autorização. O resultado posterior está em
[RESULT.md](RESULT.md); a matriz foi atualizada após a implementação.

**Parecer: INCOMPLETO.** A regressão existente passou: 176 testes unitários e 91 de
integração, sem falhas (2.759 assertions). Isso confirma a base testada das etapas
1–6, mas não satisfaz todos os cenários adicionais da Etapa 7. Nenhuma mudança de
produção, migration, privilégio ou política financeira foi realizada nesta auditoria.

## Ambiente e reprodução

Host Windows/PowerShell; Bun 1.4.4 em `.tools/package/bin/bun.exe`; TypeScript 5.9.3;
Docker client/server 29.9.2; Compose v5.6.1. Containers de teste: Bun 1.4.4,
PostgreSQL 17.11-alpine e LocalStack 4.12.0, conforme Dockerfile/Compose fixados.

Comandos, na raiz, com Bun e Docker no PATH:

```powershell
bun run test:build
bun test test/unit
docker version --format '{{.Client.Version}} {{.Server.Version}}'
docker compose version
docker compose config --quiet
docker compose ps --all --format '{{.Service}}|{{.Name}}|{{.State}}|{{.Health}}'
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select version(); select name from public.mikro_orm_migrations order by id;"'
docker compose exec -T localstack awslocal sqs list-queues --region us-east-1
bun run test:integration:docker
git diff --check
```

No sandbox, o smoke inicialmente encontrou EPERM ao criar subprocesso e Docker teve
acesso negado ao named pipe. Reexecução com acesso aprovado ao host passou; essas
tentativas iniciais não são defeitos da aplicação nem aprovações de testes.

| Verificação | Resultado atual |
|---|---|
| Typecheck e build | PASS, incluídos em test:build |
| Smoke compilado | PASS: live 200, ready sem dependências 503, término 143 |
| Unitários | 176 PASS, 0 FAIL, 1.545 assertions |
| Integração | 91 PASS, 0 FAIL, 1.214 assertions; 60,73 s |
| Integração por grupo | 7 fundação, 30 financeiros, 19 HTTP, 20 referências, 15 mensageria |
| Compose principal | Configuração válida |
| Whitespace | Sem erros; avisos de normalização LF/CRLF em arquivos já alterados |

O runner `jungle-financial-test-155e0211` terminou com exit 0 e removeu seus containers
e rede. PostgreSQL em tmpfs, sem portas de host/volumes compartilhados. Cada suíte
criou um banco adicional descartável e exerceu migrations/roles reais. Não foram
executados `down -v`, upgrade ou operações financeiras no ambiente principal.

Evidências selecionadas e resultados individuais em [EVIDENCE.txt](EVIDENCE.txt).
Logs brutos locais ignorados: `.cache-stage7-baseline-{build,unit,docker}.log`.

## Estado real das etapas anteriores

Foram consultados o enunciado [CHALLENGE.md](../CHALLENGE.md), README, ARCHITECTURE,
VALIDATION, documentação de domínio/HTTP/mensageria/referências, revisões de DDL,
árvore de fontes/testes/scripts e os dois Composes. O working tree já continha
alterações rastreadas e arquivos novos das etapas anteriores; foram preservados.

As etapas 1–6 têm código exercitado pela regressão atual. **Implantação principal
está defasada**: PostgreSQL e LocalStack healthy; três APIs `jungle-wagering:stage1`
running/unhealthy; somente `Migration20261028000100` no histórico; `list-queues`
sem filas; nenhum consumer, publisher ou scheduler implantado. As APIs registram
503 no probe. Jobs migrate/queues antigos estão exited. Não se presume que a
presença de serviços/arquivos prove uma implantação atual funcional.

No teste descartável, as quatro migrations foram aplicadas; up/down/up e recusa de
rollback destrutivo passaram. A reversibilidade é estrutural em banco vazio; não
autoriza apagar histórico financeiro. Não há autorização para atualizar o principal
como parte desta validação; ele não é necessário para testar a Etapa 7 isoladamente.

## Evidências financeiras e de recuperação

| Cenário executado | Evidência atual |
|---|---|
| Duas BET 80.00 sobre 100.00 | Testes financeiros A e HTTP concurrency passaram: uma processada, uma rejeitada, 20.00 e um débito; reconciliação conferida |
| 50 duplicatas HTTP | PIDs 31/53/77, backend PIDs 100/101/102; uma transação, um débito, saldo 90.00 |
| Carteiras independentes | Lock explícito em A não impediu commit de B, testes financeiros/HTTP/SQS/scheduler passaram |
| REFUND/ROLLBACK concorrentes | Uma compensação, outra rejeitada, política aprovada preservada |
| Saldo negativo/reversão | Rejeição e constraints passaram; sem ledger indevido |
| Replay histórico | BET observada em 80.00, saldo posterior 130.00, replay em 80.00 |
| Inbox | 50 entregas, 49 duplicatas, um débito; SIGKILL após commit antes do ACK recuperou via inbox |
| Dois publishers | PIDs 587/608; 32 publicações, 32 event IDs únicos |
| Publisher crash | SIGKILL após send; outro processo recuperou lease, mesmo event ID e duas tentativas |
| Scheduler | PIDs 101/102/103, backend PIDs 138/139/140; uma resolução e um crédito |
| Scheduler crash | SIGKILL antes do commit desfez efeitos; depois do commit não duplicou; claim recuperado |
| Pendência resolvida e replay | Snapshot terminal 100.00, saldo posterior 150.00, quatro entradas |
| Reconciliação | Históricos dos cenários críticos conferidos; fixtures unitárias diagnosticam corrupção sem desativar triggers |

Os processos independentes acima rodam dentro do container do runner. São evidência
real de multiprocessamento e conexões independentes, mas **não** de três containers
de aplicação mais workers coexistindo no Compose de teste. SIGKILL é encerramento
abrupto; os testes de SIGTERM são separados. A perda de resposta ao commit é simulada
após commit real; não prova desconexão física durante COMMIT. A republicação com ID
estável e a deduplicação persistente do subscriber são verificadas em testes separados;
não se afirma entrega exatamente uma vez pelo SQS.

## Observabilidade e lacunas

Logs JSON possuem timestamp, level, service, instanceId, IDs e duração em diversos
fluxos. Testes de logging e proteção contra vazamento passaram. Ainda faltam campos
consistentes por operação: publisher registra event ID como messageId; erro HTTP
registra errorName sem o código já mapeado; consumer não inclui transactionId no log
final. Revisão posterior confirmou que o consumer já incluía transactionId; esse
achado específico da inspeção inicial estava incorreto. Os demais campos faltantes
foram tratados após autorização, conforme RESULT.md.

HttpMetrics conta requests, duração e reconciliação; não conta transações por status
ou conflitos de idempotência. MessagingMetrics.processed conta comandos confirmados,
incluindo rejeições de negócio, e não equivale a transações PROCESSED. Não há contador
explícito de retries/conflitos de lock na UoW. Há duplicatas, falhas transitórias,
publicações, outbox depth/age e pendências. Exporter/dashboard não é necessário para
sanar essas lacunas; os snapshots existentes podem ser ampliados.

DatabaseService.checkReady verifica apenas a existência do namespace wagering. O
teste de fundação aprova readiness com somente a migration inicial e zero tabelas
financeiras. Assim, esse PASS comprova o contrato antigo de fundação, não a capacidade
financeira atual. Validar negativamente schema parcial e ajustar o probe é necessário.
Workers verificam mais colunas no startup, mas não possuem health checks no Compose.

Não foi executado teste de carga da Etapa 7: total, taxa de sucesso, rejeições, erros,
p50/p95/p99, throughput e lag sob carga estão NOT_TESTED. Não há números inferidos a
partir do tempo agregado da suíte nem afirmação de capacidade de produção.

Não foi criada a bateria explícita para todos os seis pontos de falha transacional.
Há rollback após wallet/ledger/outbox, constraints no commit e resposta perdida;
faltam casos individualizados antes/depois do INSERT e desconexão real próxima ao
commit. Reinício conjunto de APIs, consumers, publishers e schedulers com trabalho
pendente no mesmo ambiente também permanece NOT_TESTED.

## Entrega desta auditoria e próximos passos

Novos arquivos: este relatório, [MATRIX.md](MATRIX.md), [EVIDENCE.txt](EVIDENCE.txt) e
[PLAN.md](PLAN.md). VALIDATION recebeu somente uma nota com link. Nenhum defeito de
runtime foi corrigido nesta auditoria; zero falhas na regressão não elimina as
lacunas de cobertura/observabilidade descritas acima. Não há defeito financeiro
crítico reproduzido nesta execução.

O plano inclui impacto/arquivos e critérios de aceite para completar esta etapa.
Mudança de infraestrutura de teste requer a aprovação prevista no pedido. Depois
da autorização, executar o plano incrementalmente e atualizar matriz/evidências com
resultados reais. A Etapa 8 não foi iniciada; recomenda-se planejá-la somente após
fechar os critérios pendentes da Etapa 7.
