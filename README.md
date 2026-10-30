# Jungle Wagering — Distributed Wagering Processor

Serviço financeiro distribuído para processar apostas de provedores com dinheiro
exato, idempotência persistente e ledger auditável. HTTP e SQS compartilham o mesmo
processador transacional PostgreSQL. A entrega da fila é at-least-once.

**Remediação 8.1:** [FINAL_REVIEW.md](FINAL_REVIEW.md). Guard de extensão, classes
Inbox/Outbox e patches transitivos foram incorporados após aprovação.
O enunciado original está preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md).

## Tecnologias e ambiente

| Componente | Versão fixada/verificada |
|---|---|
| Bun | 1.4.4; desafio exige Bun 1.x |
| TypeScript | 5.9.3, strict |
| NestJS | 11.2.8 |
| MikroORM | 6.6.17, PostgreSQL e migrations |
| PostgreSQL | 17.11-alpine, container real |
| LocalStack | 4.12.0, SQS FIFO local |
| AWS SDK SQS | 3.1159.0 |
| decimal.js | 10.6.0 |
| Docker/Compose usados na auditoria | 29.9.2 / v5.6.1 |

É necessário Docker Engine com containers Linux, Compose com suporte a condições
health/completed e Bun no PATH. No Windows foi usado Docker Desktop/PowerShell.
PostgreSQL e SQS não precisam estar instalados no host. As imagens são fixadas;
não se recomenda atualizar versões sem repetir a validação. As dependências estão
em `bun.lock`; consulte a auditoria de dependências antes de expor o serviço.

## Arquitetura

```text
src/domain/                 Money, Wallet, WagerTransaction, ledger e política
src/application/financial/  comandos, consultas, hash, reconciliação e portas
src/application/messaging/  envelopes e eventos de integração tipados
src/infrastructure/         PostgreSQL, SQS, schedulers, configuração e métricas
src/interfaces/http/        controllers, DTOs, respostas e erros
src/workers/                entrypoint separado por papel
scripts/                    bootstrap, migrations, probes e runners Docker
```

Controllers traduzem o contrato HTTP. API e consumer chamam `FinancialService`;
o scheduler reaproveita sua avaliação financeira. Repositories implementam as
portas da aplicação. O domínio não depende de NestJS, ORM ou SDK AWS. Fluxos,
limites de confiança e trade-offs estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Instalação e execução em uma máquina limpa

Os comandos abaixo pressupõem checkout novo, portas livres e ausência de banco de
uma instalação anterior. Preserve um `.env` existente; não o sobrescreva para
atualizar uma instalação. Os valores do exemplo são apenas credenciais locais.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
bun install --frozen-lockfile
bun run stack:scale
bun run services:status
docker compose port --index 1 app 3000
docker compose port --index 2 app 3000
docker compose port --index 3 app 3000
```

`stack:scale` inicia três APIs, três consumers, dois publishers e três schedulers.
As portas HTTP são dinâmicas e ligadas a 127.0.0.1. Use a porta anunciada para cada
API; `APP_HOST_PORT` deve continuar vazio/zero ao escalar. PostgreSQL e LocalStack
usam 5432 e 4566 no host por padrão; altere `POSTGRES_HOST_PORT` e
`LOCALSTACK_HOST_PORT` se ocupadas. `bun run stack:up` inicia uma instância por papel.

A ordem de inicialização é PostgreSQL saudável → bootstrap administrativo →
migrations com owner restrito → aplicação/workers; filas são provisionadas após
LocalStack saudável. A aplicação nunca executa DDL no startup. O runtime da imagem
final usa o usuário `bun` e recebe somente credenciais PostgreSQL de runtime.

Para encerrar, preservando o volume PostgreSQL:

```text
docker compose down
```

Não use `down -v` em dados a preservar. O estado persistente do LocalStack não é
oferecido por este Compose: reiniciar o broker pode exigir recriar filas; não é uma
promessa de durabilidade equivalente à AWS. O banco principal desta máquina está
com uma instalação antiga; a auditoria não o atualizou. Para avaliar sem afetá-lo,
use os runners descartáveis da seção Testes.

## Configuração

`.env.example` documenta todas as variáveis. Grupos principais:

| Variáveis | Responsabilidade |
|---|---|
| DB_HOST/PORT/NAME, DB_USER/PASSWORD, DB_POOL_MAX | Conexão/pool por processo |
| ADMIN_DB_* | Somente bootstrap administrativo |
| MIGRATION_DB_* | Somente migrations, com owner restrito |
| RUNTIME_DB_* | Login não administrativo dos containers de aplicação |
| AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SQS_ENDPOINT | LocalStack local |
| SQS_*QUEUE_NAME, SQS_*DLQ_NAME | Quatro filas FIFO distintas |
| SQS_WAIT_SECONDS, SQS_VISIBILITY_TIMEOUT_SECONDS, SQS_MAX_RECEIVE_COUNT | Polling, visibilidade e limite de recebimentos |
| CONSUMER_CONCURRENCY, MESSAGING_RETRY_*, OUTBOX_* | Concorrência, retry, claims/leases e publicação |
| PENDING_REFERENCE_* | TTL, orçamento, backoff, polling e timeout de sessão |
| HOST, PORT, LOG_LEVEL, DEPENDENCY_TIMEOUT_MS | Bind, logging e timeouts |

Configuração inválida falha sem imprimir valores sensíveis. Dentro do Compose,
os endereços são `postgres:5432` e `http://localstack:4566`, independentemente das
portas de host. Dimensione o total de conexões considerando APIs e todos os workers.
Os defaults/credenciais locais não são uma configuração de produção.

## Banco, migrations e atualização de instalações

As quatro migrations versionadas criam namespace, modelo financeiro, permissões de
mensageria e deadline persistido de referências. Bootstrap, migrator e runtime têm
papéis separados. Runtime não pode ser superuser/owner e não acessa o histórico de
migrations. As entidades ORM mapeiam NUMERIC para string e versões para bigint.

```text
bun run migration:status
```

Esse comando precisa das credenciais de migrator e de conexão adequadas ao host.
Na inicialização via Compose, jobs fazem o provisionamento e o upgrade. Para
trabalhar no host, prepare as credenciais do `.env.example`, então:

```powershell
bun run services:up
$env:ALLOW_DATABASE_BOOTSTRAP = '1'
bun run database:bootstrap
bun run migration:up
bun run queues:init
bun run dev
```

Não execute esse fluxo indiscriminadamente em uma instalação existente. Antes da
migration de deadlines, drene/pare os writers antigos: o schema passa a exigir prazo
em PENDING_REFERENCE. O backfill usa created_at + 24h; pendências antigas podem já
estar vencidas ao iniciar o scheduler. Revise [docs/PENDING_REFERENCES.md](docs/PENDING_REFERENCES.md).

Rollback é estrutural e recusa apagar histórico financeiro. O comando `migration:down`
exige NODE_ENV=test, banco `jungle_wagering_test` ou com esse prefixo e
ALLOW_MIGRATION_DOWN=1. Os testes verificam up/down/up em bancos novos e recusas com
dados; não é permitido esvaziar ledger para tornar um rollback possível.

## API REST

| Método | Rota |
|---|---|
| POST | /wallets |
| GET | /wallets/:walletId |
| GET | /wallets/:walletId/ledger?limit=50&cursor=... |
| POST | /wagering/transactions |
| GET | /wagering/transactions/:transactionId |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId |
| POST | /wallets/:walletId/reconciliation |
| GET | /health/live |
| GET | /health/ready |

Exemplos de bodies; use a URL/porta obtida com `docker compose port`:

```json
{"playerId":"player-demo","initialBalance":{"amount":"100.00","currency":"BRL"}}
```

Após criar a wallet, envie uma BET para `/wagering/transactions`, com
`Content-Type: application/json` e `Idempotency-Key: provider-demo:bet-1`:

```json
{
  "providerId":"provider-demo",
  "externalTransactionId":"bet-1",
  "playerId":"player-demo",
  "walletId":"ID_DA_WALLET_CRIADA",
  "roundId":"round-demo",
  "gameId":"game-demo",
  "kind":"BET",
  "money":{"amount":"80.00","currency":"BRL"}
}
```

Dinheiro sempre usa string decimal com duas casas; versões são strings no JSON.
DTOs recusam campos desconhecidos, tipos incorretos e OPENING externo. O header
Idempotency-Key é obrigatório e único. Respostas distinguem 400 inválido, 404 ausente,
409 conflito, 422 rejeição financeira, 202 pendente, 200 processado e 503 transitório.
FAILED persistido retorna 500 com snapshot; erros inesperados são sanitizados.
Contratos completos, paginação e exemplos em [docs/HTTP_API.md](docs/HTTP_API.md).

**Autenticação externa não implementada:** os endpoints financeiros estão abertos
na rede local. NoopProviderIdentityGuard é a extensão explícita para futuro OIDC/JWKS;
permite acesso sem criar identidade confiável. Health não usa esse guard;
SQS é tratado como canal interno confiável, com validação dos campos do provedor.

## Processamento financeiro e reversões

| Operação | Efeito |
|---|---|
| BET | Débito; saldo insuficiente gera REJECTED/INSUFFICIENT_FUNDS |
| WIN | Crédito |
| LOSS | Registra PROCESSED sem alterar saldo, versão ou ledger |
| REFUND | Crédito integral de uma BET válida processada |
| ROLLBACK | Inverso de BET, WIN ou REFUND; débito sem fundos gera REVERSAL_INSUFFICIENT_FUNDS |
| OPENING | Interno; abertura positiva cria crédito/transação/ledger atomicamente |

Abertura zero tem versão 1 e ledger vazio. Cada mudança de saldo incrementa a versão
e insere exatamente um lançamento. Estados terminais e ledger são imutáveis no
banco; a reconciliação reconstrói o saldo em snapshot consistente e nunca repara
uma divergência automaticamente.

A política atual permite **uma reversão direta processada por referência**, unindo
REFUND e ROLLBACK na mesma exclusão. Ela é mais restritiva que a unicidade por
referência/tipo do item 7.4 do desafio. A manutenção dessa interpretação foi aprovada
na Etapa 8.1: preserva a unicidade por tipo e evita dupla compensação econômica;
a restrição adicional continua explícita ao avaliador. ROLLBACK de REFUND é permitido
e não reabre o direito sobre a BET original. Nenhuma regra foi alterada na auditoria.

## Idempotência

Idempotency-Key é global; `(providerId, externalTransactionId)` também é único.
O hash v1 usa SHA-256 de JSON de array em ordem documentada, com dinheiro canônico
e referência ausente como null; não inclui a chave nem metadados de transporte.
Chave/identidade/hash compatíveis retornam o registro existente. Divergências geram
409, incluindo mesma identidade externa com outra chave e chave entre wallets.

Replay terminal usa o snapshot original de saldo/versão/instante. Movimentos
posteriores e reinicialização não o recalculam. Pendências retornam 202 sem forçar
resolução. PostgreSQL, não cache em memória ou deduplicação do SQS, garante unicidade.

## SQS, Inbox e Outbox

Filas de comandos/eventos e suas DLQs são FIFO. MessageGroupId deriva da wallet;
IDs de deduplicação são estáveis. O consumer valida o envelope, adquire Inbox,
processa o financeiro e grava ledger/outbox/inbox em um único commit. Só então
executa DeleteMessage. Rejeição financeira confirmada também recebe ACK.

O publisher faz claim SQL com SKIP LOCKED, lease e fencing; a chamada SQS ocorre
fora da transação financeira e após seu commit. Dois publishers podem coexistir.
Crash depois de enviar e antes de marcar permite republicação do mesmo eventId;
subscribers precisam deduplicar persistentemente. Não se promete exactly-once no SQS.

Retries têm backoff exponencial/jitter e limite; mensagens inválidas/permanentes ou
esgotadas seguem para DLQ. Outbox esgotada permanece durável no PostgreSQL e bloqueia
a sequência daquela wallet até intervenção; não é descartada. Operação e replay de
DLQ estão em [docs/MESSAGING.md](docs/MESSAGING.md).

## Referências pendentes

REFUND/ROLLBACK antes da referência persistem PENDING_REFERENCE e são retomadas por
scheduler, sem depender de replay HTTP. Defaults: TTL 24h, 20 avaliações totais,
base 1s e teto 300s com jitter. Prazo é persistido/imutável. Limite/TTL esgotado gera
REJECTED/REFERENCE_NOT_FOUND, sem ledger; indisponibilidade SQL não consome tentativa.
Claim e resolução usam a mesma transação curta e ordem wallet → transação. SIGKILL
libera locks e outra instância retoma. Detalhes em [docs/PENDING_REFERENCES.md](docs/PENDING_REFERENCES.md).

## Testes e reprodução isolada

```text
bun run test:build
bun run test
bun run test:integration:docker
bun run test:distributed:docker --evidence-dir docs/stage-81
bun run test:load --evidence-dir docs/stage-81
bun audit --json
```

Os runners Docker usam projetos aleatórios, PostgreSQL tmpfs e LocalStack próprios,
sem portas de host, dados manuais ou volumes principais. A suíte distribuída executa
três APIs, três consumers, dois publishers e três schedulers em containers distintos;
verifica A–E, duplicatas, FIFO, SIGKILL/reinício, backlog, replay e reconciliação.
`test:load` repete somente a carga em outro projeto. `--evidence-dir` salva novas
execuções separadamente; sem a opção, o destino histórico continua docs/stage-7.

Unitários usam mocks quando apropriado; integração/distribuídos usam PostgreSQL e
SQS reais. SIGKILL e SIGTERM são casos diferentes. Falha próxima ao COMMIT é conferida
pela identidade persistida antes do retry. Resultados recentes, comandos, contagens
e limites estão em [VALIDATION.md](VALIDATION.md) e na [matriz atual](docs/stage-81/CONFORMANCE.md).
Overrides fixam Ajv 8.18.0 e Multer 2.5.0. Repita bun audit antes de atualizações ou
exposição do serviço; ausência de advisories conhecidos não certifica segurança total.

## Decisões e limitações

- Locks pessimistas por wallet, transações curtas e retry inteiro limitado para
  deadlock/serialização. Não há lock global financeiro ou rede dentro da UoW.
- NUMERIC/string/decimal.js para dinheiro e bigint para versões/somas históricas.
- InboxMessage/OutboxMessage têm factories, rehydrate e transições imutáveis usadas
  pelos repositories. Claims, leases, tentativas e fencing continuam no PostgreSQL.
- FAILED existe no domínio/schema e no replay; o fluxo normal não converte uma
  indisponibilidade transitória ou expiração de referência em FAILED.
- Métricas são snapshots JSON por processo a cada 10s, sem exporter/agregação/SLA.
  Não substituem a auditoria SQL nem garantem contagem exata após commit incerto.
- LocalStack e carga pequena não certificam AWS real, alta disponibilidade ou produção.
- Sem frontend, IdP, double-entry, restore/failover ou teste de perda física de disco.
- Overrides transitivos ultrapassam ranges fixados pelos pais; foram aprovados e
  precisam de revisão nas próximas atualizações dos frameworks.

## Evidências e preparação da entrega

[FINAL_REVIEW.md](FINAL_REVIEW.md) contém o parecer, prioridades e orientações de
entrega. [CONFORMANCE.md](docs/stage-81/CONFORMANCE.md) rastreia o enunciado original;
[RESULT.md](docs/stage-81/RESULT.md) registra a remediação e suas verificações. Os registros
das etapas anteriores foram preservados. Logs `.cache-*.log`, dist, node_modules,
.tools e .env são locais/ignorados; não devem integrar um pacote de entrega.
Nenhum arquivo foi excluído pela auditoria; veja o inventário de limpeza antes de
aprovar remoções. Nenhum commit ou publicação é feito automaticamente.
