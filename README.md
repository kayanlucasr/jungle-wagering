# Jungle Wagering — Distributed Wagering Processor

Distributed Wagering Processor em Bun, TypeScript strict e NestJS.

**Estado: API financeira da Etapa 4 implementada e validada em PostgreSQL real.**
Há endpoints REST, DTOs validados, paginação estável do ledger, replay HTTP persistente,
reconciliação e rastreamento de requests, reutilizando a unidade de trabalho ACID da Etapa 3.
Não há consumer SQS, publisher, worker de referências ou autenticação externa.

Rotas, exemplos, status HTTP, paginação e idempotência em [docs/HTTP_API.md](docs/HTTP_API.md).

Enunciado preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md). Matriz de reversões,
abertura zero e contrato futuro de replay em [docs/DOMAIN.md](docs/DOMAIN.md).

DDL aprovado após revisão integral em [docs/stage-3/REVIEW.md](docs/stage-3/REVIEW.md).
As propostas originais são preservadas como registro; a migration oficial incorpora
o mesmo SQL. Resultados e arquivos da implementação estão em [VALIDATION.md](VALIDATION.md).

## Pré-requisitos e versões

- Bun **1.4.4** (runtime, package manager e test runner).
- Docker Engine com containers Linux e Docker Compose **2.24+**; no Windows, Docker Desktop.
- Portas locais disponíveis para PostgreSQL e LocalStack, ou portas alternativas no `.env`.

Dependências diretas fixadas:

| Dependência | Versão |
|---|---|
| NestJS common/core/platform-express | 11.2.8 |
| MikroORM core/postgresql/migrations | 6.6.17 |
| AWS SDK client-sqs | 3.1159.0 |
| Smithy node-http-handler | 4.13.0 |
| decimal.js | 10.6.0 |
| reflect-metadata | 0.2.2 |
| rxjs | 7.8.2 |
| TypeScript | 5.9.3 |
| @types/bun | 1.4.4 |
| @types/express | 5.0.6 |

Imagens configuradas: `oven/bun:1.4.4`, `postgres:17.11-alpine` e
`localstack/localstack:4.12.0`. Dependências foram instaladas com Bun e estão em
`bun.lock`. As três imagens foram baixadas e executadas: 7 testes de integração passaram,
a migration foi validada com up/down/up e três réplicas responderam live/ready com HTTP 200.

LocalStack 4.12.0 é uma versão Community fixada anterior à exigência de autenticação
da distribuição atual. Evita conta/token para o exercício local; não é uma recomendação
de produção. Ao atualizar a imagem, revisar os requisitos de licença/autenticação e
executar novamente os testes. Referências:
[release 4.12.0](https://github.com/localstack/localstack/releases/tag/v4.12.0) e
[mudança de distribuição](https://blog.localstack.cloud/the-road-ahead-for-localstack/).

## Instalação e configuração

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
```

Em shells POSIX, use `cp .env.example .env`. Bun carrega `.env` automaticamente.
O arquivo contém somente credenciais locais de exemplo. Não reutilizá-las fora do
ambiente de desenvolvimento. `.env` está excluído do Git e do contexto Docker.

Variáveis relevantes:

| Variável | Uso |
|---|---|
| NODE_ENV | development, test ou production |
| HOST / PORT | Bind HTTP; zero é permitido para porta efêmera em testes |
| LOG_LEVEL | debug, info, warn ou error |
| DB_HOST / DB_PORT / DB_NAME | Conexão PostgreSQL |
| DB_USER / DB_PASSWORD | Login runtime para execução no host |
| ADMIN_DB_USER / ADMIN_DB_PASSWORD | Administração, somente no job de bootstrap |
| MIGRATION_DB_USER / MIGRATION_DB_PASSWORD | Login restrito do job/comando de migrations |
| RUNTIME_DB_USER / RUNTIME_DB_PASSWORD | Login runtime usado pelo Compose |
| DB_POOL_MAX | Máximo de conexões por processo |
| DEPENDENCY_TIMEOUT_MS | Timeout de dependências; padrão 2000 |
| AWS_REGION | Região SQS |
| AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY | Credenciais locais SQS |
| SQS_ENDPOINT | Endpoint sem credenciais, query string ou path adicional |
| SQS_QUEUE_NAME / SQS_DLQ_NAME | Nomes FIFO distintos |
| SQS_MAX_RECEIVE_COUNT | Redrive após tentativas; padrão 5 |
| SQS_VISIBILITY_TIMEOUT_SECONDS | Visibilidade da fila principal; padrão 30 |
| POSTGRES_HOST_PORT / LOCALSTACK_HOST_PORT | Portas publicadas no host |
| APP_HOST_PORT | Vazio/zero: porta dinâmica; valor fixo apenas para uma réplica |

Configuração inválida impede o bootstrap e informa os nomes das variáveis, sem imprimir
seus valores. O Compose usa nomes DNS internos (`postgres`, `localstack`), independentemente
das portas publicadas no host.

## Execução completa em Docker Compose

```text
bun run stack:up
bun run services:status
docker compose port app 3000
```

Inicialização: PostgreSQL saudável → job `database-bootstrap` (fundação e acesso)
→ job `migrate` com proprietário restrito → aplicação. LocalStack e job `queues`
também devem estar prontos. A aplicação recebe somente credenciais runtime; nenhuma
migration ou sincronização roda em seu startup. `queues` cria automaticamente:

- `wager-transactions.fifo`: FIFO, deduplicação explícita, visibilidade 30s,
  long polling 20s, retenção 4 dias, redrive para DLQ após 5 recebimentos.
- `wager-transactions-dlq.fifo`: FIFO, retenção 14 dias.

Os parâmetros de visibilidade/tentativas vêm das variáveis. Repetir a inicialização
com os mesmos atributos é seguro; mudar atributos de filas existentes exige atualização
operacional explícita, sem apagar mensagens silenciosamente.

O banco persiste no volume `postgres-data`. LocalStack pode reconstruir as filas
no próximo `stack:up`; retenção persistente do broker não é oferecida nesta fundação.
Somente portas ligadas a `127.0.0.1` são publicadas. A imagem da aplicação executa
como usuário `bun`, com init e prazo de shutdown de 15 segundos.

Na máquina usada na validação, a porta 5432 já estava ocupada por outro processo.
O `.env` local (ignorado pelo Git) usa `POSTGRES_HOST_PORT=15432` e `DB_PORT=15432`;
o PostgreSQL dentro do Compose continua em 5432. O serviço existente foi preservado.

### Três réplicas

Deixe `APP_HOST_PORT` vazio/zero:

```text
bun run stack:scale
docker compose ps app
docker compose port --index 1 app 3000
docker compose port --index 2 app 3000
docker compose port --index 3 app 3000
```

Cada réplica tem sua porta de host dinâmica. Não há `container_name`, mutex global
ou porta de host fixa por réplica. A concorrência financeira foi validada separadamente
com três processos, pools e conexões independentes no teste das 50 duplicatas.

## Desenvolvimento com Bun no host

```text
bun run services:up
$env:ALLOW_DATABASE_BOOTSTRAP = '1'
bun run database:bootstrap
bun run migration:up
bun run queues:init
bun run dev
```

`services:up` inicia somente PostgreSQL e LocalStack. Para a aplicação no host,
use `DB_HOST=127.0.0.1` e `SQS_ENDPOINT=http://127.0.0.1:4566` (ou portas alteradas).
`bun run start` executa o fonte; `bun run start:prod` executa o build.

O comando `$env:...` acima é PowerShell; em POSIX use
`ALLOW_DATABASE_BOOTSTRAP=1 bun run database:bootstrap`. Configure os três pares de
credenciais do `.env.example`. Um `.env` antigo da Etapa 1 precisa ser ajustado para
usar login runtime no host. Operações financeiras recusam superuser, owner e roles
administrativas (`UNSAFE_DATABASE_ROLE`). O bootstrap inspeciona atributos e memberships
de roles existentes, não redefine senhas existentes nem apaga dados/volumes.

## Health checks e logs

```text
GET /health/live
GET /health/ready
```

- Liveness: 200 com `{"status":"ok"}`, mesmo sem banco/broker.
- Readiness: 200 apenas quando o PostgreSQL responde, a migration do namespace
  está aplicada e ambas as filas possuem configuração esperada.
- Falha de dependência: 503 com estados `up`/`down`, sem URLs, credenciais ou SQL.
- Nenhuma rota exige autenticação nesta etapa.
- Requests propagam/geram `x-correlation-id`; logs são JSON, sem body ou query string.

O container usa readiness como health check. Readiness indisponível não muda a
semântica da liveness nem implica restart automático de container apenas por estar unhealthy.

## Migrations

```text
bun run migration:status
bun run migration:up
```

`Migration20261028000100` cria somente o namespace `wagering`. O histórico é mantido
pelo MikroORM. A reversão faz `DROP SCHEMA ... RESTRICT`, sem CASCADE.

`Migration20261028000200` cria wallets, transações, ledger, inbox/outbox e suas proteções.
O down financeiro exige tabelas vazias, trava antes da verificação e não remove roles.
O bootstrap administrativo provisiona grupos separados; todas as conexões do migrator
assumem `wagering_owner`, enquanto o runtime não acessa o histórico MikroORM.

O script de rollback exige **todos** estes critérios:

- `NODE_ENV=test`;
- nome de banco `jungle_wagering_test` ou com prefixo `jungle_wagering_test_`;
- `ALLOW_MIGRATION_DOWN=1`.

Exemplo em PowerShell, somente após configurar um banco de teste descartável:

```powershell
$env:NODE_ENV = 'test'
$env:DB_NAME = 'jungle_wagering_test'
$env:ALLOW_MIGRATION_DOWN = '1'
bun run migration:down
```

O teste de integração faz up/down/up em um banco novo com nome aleatório e o remove
ao terminar. Não roda rollback em bancos de desenvolvimento existentes. A execução
registrada nesta entrega preservou o banco e o volume de desenvolvimento.

## Qualidade e testes

```text
bun run typecheck
bun run build
bun run test
bun run test:build
bun run test:integration:docker
```

O build usa o compilador TypeScript executado pelo Bun, preservando os decorators e
metadados esperados pelo NestJS. O resultado fica em `dist/`.

`test:build` compila e inicia um processo separado a partir do JavaScript emitido,
verificando live=200 e ready=503 sem dependências disponíveis.

`test` cobre validação de ambiente, logging e um servidor Nest real com drivers apontados
para dependências inacessíveis. Não substitui a suite de containers.

`test:integration:docker` cria um projeto Compose com nome aleatório, PostgreSQL em
filesystem descartável e LocalStack real. Sem portas de host ou volumes compartilhados.
Verifica conexão, transações SQL, filas, migrations reversíveis, endpoints e falha
individual de cada dependência. A suíte financeira usa login runtime real sem privilégios
administrativos, SQL inválido, rollback, três processos concorrentes, deadlock e reconciliação.
Somente o administrador do container de teste pode criar os bancos descartáveis.

Os E2E HTTP estão incluídos nessa suíte e usam três processos Nest com o JavaScript
compilado, pools e conexões independentes. Fora do Docker, executar `bun run build`
antes de `bun run test:integration`, além de configurar o ambiente administrativo de testes.

Para executar contra containers de teste já preparados, configure `NODE_ENV=test`,
um `DB_NAME` isolado e as conexões, inicialize as filas e execute
`bun run test:integration`. Sem pré-requisitos, a suite falha explicitamente; não transforma
testes não executados em sucesso/skip silencioso.

Validação efetuada neste ambiente: consulte [VALIDATION.md](VALIDATION.md).

## Troubleshooting

- **Bun não encontrado:** instale Bun 1.x ou use a imagem Docker. O binário em `.tools/`
  usado nesta sessão é local e ignorado pelo Git; não é pré-requisito do repositório.
- **Docker não encontrado/Engine parado:** instalar/iniciar Docker Desktop com containers
  Linux; então repetir a suite de integração. Não é resolvido por mocks.
- **Porta ocupada:** mudar `POSTGRES_HOST_PORT`/`LOCALSTACK_HOST_PORT`; ajustar também as
  variáveis de conexão usadas pelo Bun no host.
- **Readiness 503 com banco acessível:** executar `migration:up`; verificar filas,
  redrive, endpoint e região. Consultar `docker compose logs migrate queues`.
- **Volume PostgreSQL com outra senha/banco:** mudar `.env` não altera usuários de um
  cluster já inicializado. Usar outro projeto Compose/volume ou ajustar administrativamente;
  não apagar o volume existente como correção automática.
- **Fila existente com atributos diferentes:** revisar configuração e atualizar atributos
  explicitamente. Não remover fila com mensagens.
- **LocalStack atualizado pede token:** manter a versão fixada ou configurar a distribuição
  nova conforme sua documentação antes de migrar.
- **Rollback recusado:** o script permite apenas banco isolado de teste e opt-in explícito.

`bun run services:down` para os serviços do projeto e preserva o volume PostgreSQL.
Não executar `docker compose down -v` sobre dados a preservar.

Decisões e próximos passos: [ARCHITECTURE.md](ARCHITECTURE.md).
