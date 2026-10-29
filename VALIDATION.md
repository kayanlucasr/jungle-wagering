# Relatório de implementação e validação — Etapas 1 e 2

Data: 28/10/2026, America/Sao_Paulo.

## 1. Resumo

As seções iniciais preservam o histórico da Etapa 1. A seção final registra a Etapa 2
e seus resultados atuais, sem substituir as evidências das execuções anteriores.

Fundação criada: NestJS/Bun, TypeScript strict, ambiente validado, logging JSON,
exceptions globais, correlation ID, lifecycle, conexão MikroORM, cliente SQS,
health checks, migrations, Dockerfiles/Compose e testes.

**Validação local e com containers aprovada.** Após atualização do WSL e reinício do
Docker Desktop, os 7 testes reais de integração passaram e três réplicas da aplicação
responderam HTTP 200 em liveness e readiness. Os bloqueios anteriores estão preservados
abaixo como histórico; a seção final registra a execução bem-sucedida mais recente.
Até o encerramento da Etapa 1, nenhuma regra financeira havia sido implementada.
O usuário optou por deixar as tabelas financeiras para aprovação posterior.

## 2. Arquivos

O repositório estava vazio; todos estes arquivos foram criados:

```text
.dockerignore
.env.example
.gitattributes
.gitignore
ARCHITECTURE.md
Dockerfile
README.md
VALIDATION.md
bun.lock
docker-compose.yml
docker-compose.test.yml
mikro-orm.config.ts
package.json
tsconfig.json
tsconfig.build.json
scripts/healthcheck.ts
scripts/init-queues.ts
scripts/integration-docker.ts
scripts/migrate.ts
scripts/smoke-build.ts
src/app.module.ts
src/bootstrap.ts
src/main.ts
src/infrastructure/config/environment.ts
src/infrastructure/messaging/sqs.service.ts
src/infrastructure/observability/json-logger.ts
src/infrastructure/persistence/database.service.ts
src/infrastructure/persistence/orm-options.ts
src/infrastructure/persistence/migrations/Migration20261028000100.ts
src/interfaces/http/exception.filter.ts
src/interfaces/http/health.controller.ts
test/integration/foundation.test.ts
test/support/config.ts
test/unit/bootstrap.test.ts
test/unit/environment.test.ts
test/unit/logger.test.ts
```

Artefatos locais ignorados: `.tools/` (Bun e CLI Compose portáteis), `node_modules/`
e `dist/`. Não foi feita instalação global nem inicialização de repositório Git.

## 3. Dependências e versões

Instaladas com Bun 1.4.4; 234 pacotes, incluindo transitivas. Dependências diretas:

- NestJS common/core/platform-express 11.2.8.
- MikroORM core/postgresql/migrations 6.6.17.
- AWS SDK client-sqs 3.1159.0; Smithy node-http-handler 4.13.0.
- decimal.js 10.6.0; reflect-metadata 0.2.2; rxjs 7.8.2.
- TypeScript 5.9.3; @types/bun 1.4.4; @types/express 5.0.6.

CLI Compose portátil usado para validação estática: 2.40.3.
Imagens configuradas, ainda não executadas: Bun 1.4.4, PostgreSQL 17.11-alpine,
LocalStack 4.12.0. PostgreSQL foi fixado na minor atual da linha 17 conforme a
[política oficial de versões](https://www.postgresql.org/support/versioning/).

## 4. Comandos executados

Inspeção: Get-Content, Get-ChildItem, rg, Get-Command, where.exe e Get-Service.
Verificações de ambiente: node --version, npm --version e procura por Bun/Docker.
Nenhuma dependência foi instalada com npm.

Bootstrap local do Bun: download do pacote oficial `@oven/bun-windows-x64` pelo
registro npm, extração em `.tools/` e `bun --version` → 1.4.4.
Consulta ao registro npm para fixar versões compatíveis.

Com o diretório do Bun adicionado apenas ao PATH do processo PowerShell:

```text
bun install
bun run typecheck
bun run test
bun run build
bun run test:build
bun run test:integration:docker
```

Também foram executados:

```text
.tools/docker-compose.exe version
.tools/docker-compose.exe -f docker-compose.yml config --quiet
.tools/docker-compose.exe -f docker-compose.test.yml config --quiet
```

Os arquivos YAML também foram lidos pelo parser YAML do Bun.

## 5. Resultados da primeira execução (histórico)

| Verificação | Resultado |
|---|---|
| Instalação Bun + lockfile | Aprovada |
| TypeScript strict | Aprovado, exit 0 |
| Build TypeScript | Aprovado, exit 0 |
| Suite local | 25 testes, 0 falhas, 46 assertions |
| Bootstrap do JS compilado em processo separado | Aprovado |
| Liveness do JS compilado sem dependências | HTTP 200 |
| Readiness do JS compilado sem dependências | HTTP 503 |
| Encerramento do processo do smoke | SIGTERM; exit 143 observado no Windows |
| Configuração Compose principal | Aprovada pelo CLI Compose |
| Configuração Compose de integração | Aprovada pelo CLI Compose |
| Runner Docker de integração | Exit 1 explícito: Docker Engine indisponível |
| PostgreSQL/LocalStack reais | Não executados |
| Up/down/up real da migration | Não executado |
| Escala real com três containers | Não executada |

O primeiro typecheck identificou scripts com await no topo sem classificação de módulo;
foi corrigido com `moduleDetection=force`. As execuções posteriores passaram.
O primeiro smoke do build foi impedido pelo sandbox ao criar subprocesso (EPERM);
reexecutado com a permissão apropriada, passou. Não houve rejeição de aprovação automática.

O smoke não comprova shutdown financeiro, ack ou drenagem de mensagens: esses workers
ainda não existem. O retorno 143 registra o término por sinal; não é apresentado como
prova de todos os comportamentos de shutdown em Linux.

## 6. Containers na primeira execução (histórico)

Nenhum container foi iniciado por esta implementação. Não foi possível consultar um
Docker Engine. O CLI Compose portátil valida configuração, mas não fornece um daemon.
Não houve remoção de containers, volumes ou bancos existentes.

## 7. Migrations

`Migration20261028000100`:

- up: `CREATE SCHEMA wagering`.
- down: `DROP SCHEMA wagering RESTRICT`.
- Sem tabelas financeiras.
- Histórico administrado pelo MikroORM.
- Rollback por script restrito a banco de teste com opt-in explícito.
- Teste de up/down/up escrito para banco criado com nome aleatório em container de teste.

Nenhuma migration foi executada contra um banco existente nesta sessão.

## 8. Problemas e limitações da primeira execução (histórico)

- Docker Desktop/Engine ausente impede os critérios de aceite que dependem de containers.
- Tags das imagens e interação real entre versões ainda exigem pull/build/run.
- Readiness positiva, filas e reversibilidade real estão cobertas por testes escritos,
  mas não passaram por execução neste ambiente.
- LocalStack 4.12.0 é deliberadamente anterior à distribuição com token obrigatório;
  revisar ao atualizar. Não se reivindica suporte atual dessa versão.
- Configuração PostgreSQL local usa proprietário do banco; privilégios de runtime
  deverão ser restritos junto do schema financeiro aprovado.

## 9. Decisões

- Organização inicial por camadas, sem diretórios/arquivos vazios.
- Domain/application não receberam implementações antecipadas.
- MikroORM sem conexão obrigatória no bootstrap; readiness faz consultas reais.
- RequestContext por request e fork por transação.
- Sem sincronização de schema; migration via job separado.
- Criação das filas em job one-shot, sem consumer.
- Portas dinâmicas por réplica da aplicação.
- Testes Docker em projeto isolado, sem portas ou volumes compartilhados.
- Sem autenticação artesanal; extensão futura OIDC documentada.

## 10. Pendências na primeira execução (histórico)

1. Disponibilizar Docker Engine com containers Linux.
2. Executar `bun run test:integration:docker` e resolver eventuais falhas reais.
3. Executar `bun run stack:up` e `bun run stack:scale`, verificando readiness das réplicas.
4. Aprovar o schema financeiro e as interpretações pendentes antes de suas migrations.
5. Solicitar autorização para a próxima etapa; não houve avanço para a Etapa 2.

Sem esses testes de containers, a Etapa 1 não é declarada integralmente validada.

## Revalidação Docker solicitada pelo usuário — 28/10/2026

- Docker CLI instalado: 29.9.2; contexto `desktop-linux`.
- Docker Compose instalado: 5.6.1.
- `docker compose -f docker-compose.yml config --quiet`: exit 0.
- `docker compose -f docker-compose.test.yml config --quiet`: exit 0.
- `docker version` e `docker ps`: o daemon retorna `Docker Desktop is unable to start`.
- `bun run test:integration:docker`: exit 1 antes de executar testes, por Engine indisponível.
- Os logs de `com.docker.backend.exe` registram:
  `engine linux/wsl failed to start: checking preconditions: WSL update required`.
- `wsl --version` não é reconhecido pelo WSL instalado, confirmando o bloqueio de
  pré-requisito descrito pelo Docker.

Não foram iniciados containers, executadas migrations reais ou testadas três réplicas.
Nenhuma configuração global, distribuição WSL ou volume foi alterado.

Próximo passo no host: atualizar WSL com `wsl --update` (PowerShell como administrador,
se solicitado pelo Windows), reiniciar Docker Desktop e verificar `docker info`.
Se a atualização exigir reinicialização do Windows, concluí-la antes dos testes.
Depois executar a suite e a stack descritas acima.
Referências: [backend WSL do Docker](https://docs.docker.com/desktop/features/wsl) e
[comandos WSL da Microsoft](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).

## Validação concluída após atualização do WSL — 28/10/2026

Ambiente: WSL 3.0.1.0, kernel 6.18.40.1-1, Docker Engine Linux 29.9.2 e Compose 5.6.1.
O backend ainda mantinha o erro anterior; `docker desktop restart --timeout 55` concluiu
com sucesso e `docker info` passou a responder com servidor 29.9.2/linux.

### Execuções e resultados atuais

| Comando/verificação | Resultado |
|---|---|
| `bun run test:integration:docker` | Exit 0; 7 testes, 0 falhas, 15 assertions |
| Build Linux com `bun install --frozen-lockfile` | Aprovado; typecheck/build aprovados |
| PostgreSQL real | Conexão e transação SQL aprovadas |
| Migration em banco descartável | up/down/up aprovado; nenhuma tabela financeira |
| SQS real em LocalStack | FIFO, DLQ, ARN, redrive e visibility timeout aprovados |
| Health com dependências disponíveis | Live e ready HTTP 200 |
| PostgreSQL inacessível / SQS saudável | Ready HTTP 503, estados corretos |
| SQS inacessível / PostgreSQL saudável | Ready HTTP 503, estados corretos |
| Fila obrigatória inexistente | Ready HTTP 503 |
| `docker compose up -d --build --wait --wait-timeout 150` | Build aprovado; primeira subida bloqueada por porta 5432 ocupada |
| `docker compose up -d --wait --wait-timeout 150` | Exit 0 após usar porta de host 15432 |
| `docker compose up -d --wait --wait-timeout 120 --scale app=3` | Exit 0; três réplicas healthy |

A suite usou o projeto isolado `jungle-stage1-test-84e231cb`; o runner removeu seus
containers e rede após sucesso. Up/down/up ocorreu somente no banco aleatório de teste.

### Conflito de porta resolvido

A porta 5432 já tinha um processo ouvindo no host. Sem interrompê-lo, foi criado o `.env`
local a partir do exemplo, com `DB_PORT=15432` e `POSTGRES_HOST_PORT=15432`, após verificar
que 15432 estava disponível. Nenhuma alteração no schema ou no código foi necessária.

### Estado final deixado em execução

| Container | Estado | Acesso no host |
|---|---|---|
| jungle-wagering-app-1 | healthy | http://127.0.0.1:32768 |
| jungle-wagering-app-2 | healthy | http://127.0.0.1:32770 |
| jungle-wagering-app-3 | healthy | http://127.0.0.1:32769 |
| jungle-wagering-postgres-1 | healthy | 127.0.0.1:15432 |
| jungle-wagering-localstack-1 | healthy | http://127.0.0.1:4566 |
| jungle-wagering-migrate-1 | Exited (0) | Job concluído |
| jungle-wagering-queues-1 | Exited (0) | Job concluído |

Foram feitas seis consultas HTTP no host, live e ready em cada réplica: todas HTTP 200.
Readiness retornou `postgres=up` e `sqs=up` em todas. As portas das réplicas são dinâmicas
e podem mudar quando containers forem recriados; consultar `docker compose port`.
O histórico PostgreSQL contém `Migration20261028000100`.

### Pendências atuais

- Aprovação do schema financeiro continua pendente por decisão expressa do usuário.
- Nenhuma implementação da Etapa 2 foi iniciada.
- A topologia com três réplicas foi validada; concorrência financeira não foi testada,
  pois não há processamento financeiro nesta etapa.
- Mantêm-se as limitações documentadas de LocalStack fixado e permissões PostgreSQL
  locais; a validação não equivale a homologação de segurança para produção.

## Etapa 2 — domínio financeiro e testes unitários, 28/10/2026

### Autorização e escopo

O usuário autorizou exclusivamente Money, Wallet, WagerTransaction, FinancialPolicy,
WalletLedgerEntry, erros de domínio e testes unitários. A matriz de reversões recebeu
aprovação provisória, com exclusão entre REFUND e ROLLBACK diretos sobre a mesma BET,
preservando ROLLBACK de REFUND e o direito de nova reversão após tentativa rejeitada.

Não houve aprovação para migrations financeiras. Nenhuma migration ou tabela foi criada,
alterada ou executada nesta etapa. Não foram implementados endpoints financeiros,
consumer, publisher, worker, idempotência persistente ou concorrência distribuída.

### Arquivos criados

```text
src/domain/errors/domain-error.ts
src/domain/invariants.ts
src/domain/money/money.ts
src/domain/wallet/wallet.ts
src/domain/ledger/wallet-ledger-entry.ts
src/domain/wagering/wager-transaction-kind.ts
src/domain/wagering/wager-transaction-status.ts
src/domain/wagering/wager-transaction.ts
src/domain/wagering/financial-policy.ts
test/support/domain.ts
test/unit/domain/money.test.ts
test/unit/domain/wallet.test.ts
test/unit/domain/wallet-ledger-entry.test.ts
test/unit/domain/wager-transaction.test.ts
test/unit/domain/financial-policy.test.ts
docs/CHALLENGE.md
docs/DOMAIN.md
```

Arquivos modificados: README.md, ARCHITECTURE.md e este VALIDATION.md.
Nenhuma dependência foi adicionada ou atualizada. package.json, bun.lock e configurações
de infraestrutura permaneceram sem alterações. A cópia do enunciado em docs/CHALLENGE.md
foi comparada por SHA-256 com o arquivo original: conteúdo idêntico byte a byte.

### Decisões implementadas

- Dinheiro em strings canônicas, aritmética exata com Decimal privado e limite explícito.
- Objetos imutáveis, transições por retorno de nova instância e datas por cópia.
- Wallet com versão bigint; resultado terminal serializa versão como string.
- Abertura zero: versão 1, sem OPENING e sem ledger; soma vazia reconcilia a zero.
- Abertura positiva: bundle OPENING/CREDIT, mantendo versão 1.
- Movimentação efetiva retorna wallet e ledger correspondente; zero é no-op no agregado.
- LOSS/rejeição não produzem movimento; saldo de reversão insuficiente tem código próprio.
- Política não consulta infraestrutura nem gera IDs/instantes implicitamente.
- Snapshot terminal JSON-safe imutável, preservado na reidratação e após novas movimentações.
- Contrato futuro de persistência/replay e exigência de SQL completo antes de migrations
  estão documentados em docs/DOMAIN.md.

### Comandos executados e resultados finais

Com o Bun local no PATH do processo:

```text
bun run typecheck
bun run build
bun run test
```

| Verificação final | Resultado |
|---|---|
| Typecheck strict | Exit 0 |
| Build | Exit 0 |
| Suite unitária completa | 146 passaram, 0 falhas, 1281 assertions, 8 arquivos |
| Novos testes do domínio | 121, incluídos no total acima |
| Testes anteriores de configuração/log/bootstrap | 25, incluídos no total acima |
| Imports do domínio | Apenas decimal.js e arquivos do próprio domínio |
| Migrations financeiras | Nenhuma criada, modificada ou executada |

Durante o desenvolvimento, o typecheck detectou widening de enums em tabelas de teste;
foi corrigido preservando tuplas literais e usando LedgerDirection. A adição da proteção
de autorreferência revelou três fixtures que reutilizavam o external ID; os IDs das fixtures
foram corrigidos. A execução final passou integralmente, sem remover esses cenários.

Foram testados precisão/overflow, entradas inválidas, moedas, imutabilidade, versões,
estados terminais, referências incompatíveis/pendentes, todas as combinações de dupla
compensação, ROLLBACK de WIN/REFUND, falta de saldo, reversões rejeitadas e falhas,
abertura zero/positiva e reconstrução do saldo em sequências. O fixture financeiro
reconcilia a wallet após cada decisão e confere a cadeia before/after/versão.

Os testes de integração Docker da Etapa 1 não foram reexecutados nesta etapa: não houve
mudança em HTTP, infraestrutura ou migrations. Os 7 resultados anteriores continuam
registrados separadamente e não são contabilizados nos 146 testes desta execução.
Nenhum comando de ciclo de vida dos containers foi executado nesta etapa.

### Riscos e preparação para a Etapa 3

O domínio está preparado para futura orquestração transacional. A garantia distribuída
depende de carregar a wallet, transação atual e histórico completo sob lock e confirmar
uma única identidade persistente. A política pura não bloqueia reaplicação de snapshots
PENDING obsoletos nem garante unicidade global de wallets em memória.

A exclusão de reversões cruzadas é uma política adicional de segurança, mais restritiva
que o texto por referência/tipo; sua justificativa e a ambiguidade residual estão no documento
de domínio. ROLLBACK de REFUND não reabre o direito histórico de reverter a BET original.

Antes de criar migrations financeiras, apresentar o SQL completo com constraints,
índices, funções, triggers, permissões e testes de integridade para nova aprovação.
Persistência de snapshots, idempotência HTTP, processamento distribuído e mensageria
continuam pendentes. A Etapa 3 não foi iniciada e exige autorização explícita.

## Preparação da Etapa 3 — 28/10/2026

O usuário aprovou o plano técnico após a análise inicial. O DDL completo foi preparado
em `docs/stage-3/`, ainda aguardando aprovação específica antes das migrations.

Arquivos novos: `REVIEW.md`, `00-access.proposed.sql`, `01-financial-up.proposed.sql` e
`02-financial-down.proposed.sql`. README e ARCHITECTURE receberam links e estado atual.
Nenhum arquivo de runtime, domínio, testes, infraestrutura ou migrations foi alterado.

Na análise inicial deste pedido, foram reexecutados `bun test test/unit` e
`bun run typecheck` com o Bun local: **146 pass, 0 fail, 1.281 assertions; typecheck exit 0**.
Esses resultados validam o código existente, não o DDL proposto.

Revisão estática do up: cinco tabelas, três domains, dez funções, vinte triggers e nove
índices explícitos, além dos índices gerados pelas constraints UNIQUE/PK. Foi verificada
a correspondência nominal de CREATE/DROP de tabelas/domains/funções, e a presença de
validações/grants previstos no pacote. Isso não equivale a parsing ou execução PostgreSQL.

Nenhum SQL do pacote foi executado. Não foram criadas roles, alterados privilégios ou
aplicadas/revertidas migrations. Não foram executados testes financeiros de integração,
concorrência ou reconciliação persistente. A matriz desses testes está no pacote de revisão.

## Entrega e validação da Etapa 3 — 28/10/2026

Esta seção substitui o estado pendente da preparação acima. Após apresentação integral
dos três SQLs e parecer técnico, o usuário autorizou explicitamente a execução. Foram
implementados persistência financeira, unidade de trabalho, idempotência, reconciliação
e separação de privilégios. O domínio da Etapa 2 não foi alterado. Nenhuma dependência
foi adicionada e nenhum componente da Etapa 4 foi implementado.

### Arquivos criados

```text
src/application/financial/errors.ts
src/application/financial/financial-service.ts
src/application/financial/payload-hash.ts
src/application/financial/ports.ts
src/application/financial/reconciliation.ts
src/infrastructure/persistence/access-sql.ts
src/infrastructure/persistence/entities/financial-records.ts
src/infrastructure/persistence/financial-unit-of-work.ts
src/infrastructure/persistence/mappers/financial-mappers.ts
src/infrastructure/persistence/migrations/financial-sql.ts
src/infrastructure/persistence/migrations/Migration20261028000200.ts
src/infrastructure/persistence/provision-access.ts
src/infrastructure/persistence/repositories/ledger-repository.ts
src/infrastructure/persistence/repositories/transaction-repository.ts
src/infrastructure/persistence/repositories/wallet-repository.ts
scripts/bootstrap-database.ts
test/integration/financial.test.ts
test/support/financial-process.ts
test/unit/financial/reconciliation.test.ts
```

### Arquivos modificados

```text
.env.example
docker-compose.yml
package.json
scripts/integration-docker.ts
scripts/migrate.ts
src/app.module.ts
src/infrastructure/persistence/database.service.ts
src/infrastructure/persistence/orm-options.ts
test/integration/foundation.test.ts
README.md
ARCHITECTURE.md
VALIDATION.md
docs/DOMAIN.md
docs/stage-3/REVIEW.md
```

O teste da fundação registra apenas sua migration original, preservando os sete cenários
da Etapa 1. A suíte financeira usa outro banco aleatório e testa a migration financeira
com owner e runtime distintos. `.env` e volumes/containers de desenvolvimento existentes
foram preservados. `dist/` foi regenerado pelo build e continua ignorado pelo Git.

### Migrations, SQL aprovado e privilégios

- `Migration20261028000100`: aplicada na preparação dos bancos descartáveis; seu ciclo
  up/down/up original continua passando no teste da fundação.
- `Migration20261028000200`: aplicada, revertida e reaplicada pelo Migrator oficial,
  usando o grupo proprietário não-login `wagering_owner`.
- O comando compilado `dist/scripts/migrate.js` também completou up/down/up num banco
  descartável separado, usando login restrito de migrations.
- Down com dados foi recusado; saldo, ledger e histórico de migrations permaneceram intactos.
- Não houve migration, rollback, limpeza ou exclusão de dados no banco de desenvolvimento.
- O bootstrap administrativo compilado passou, inclusive em segunda execução com o
  schema financeiro já instalado. Não redefiniu senhas nem recriou roles existentes.
- Comparação em memória confirmou que os três SQLs incorporados são byte a byte iguais
  às propostas aprovadas. Os hashes SHA-256 dos arquivos originais permanecem:

```text
00: 5CA3224CE064748BAA3E67A36EA2876552FA90742A9CB23B6DAB9CF61E3C642E
01: 668AAF2E275F93336E2719A522B295E1C3B7CB8B480300639446FE2843F71EAD
02: 3EA66C3BD57846601D2A15F0BED581920FD70814F963F20C74FA7B3B36F4A4DD
```

Cinco tabelas, três domains, dez funções, vinte triggers e nove índices explícitos,
além dos índices de PK/UNIQUE. Proteções verificadas no PostgreSQL:

- wallet única por player/moeda, identidade imutável, saldo não negativo e versão coerente;
- dinheiro exato, finito, dentro da faixa e sem arredondamento de escala excedente;
- identidade externa e idempotency key global únicas;
- transações terminais e snapshots imutáveis, sem transição de volta a PENDING;
- ledger sem UPDATE/DELETE/TRUNCATE, com moeda, equação, contexto e efeito correspondentes;
- PROCESSED financeiro sem ledger ou wallet alterada sem ledger recusados no commit;
- nenhum ledger para LOSS, PENDING, REJECTED ou FAILED;
- uma reversão direta processada por referência, conjuntamente entre REFUND/ROLLBACK;
- preparação inbox/outbox com identidade e estados finais protegidos.

O login runtime real abriu wallets, atualizou saldos, persistiu estados e inseriu ledger.
UPDATE/DELETE/TRUNCATE no ledger, DDL e leitura do histórico MikroORM foram negados.
Inbox/outbox têm apenas SELECT para runtime nesta etapa. Triggers também recusaram
mutação do ledger pelo owner sem desativação administrativa. A unidade de trabalho
recusou o próprio owner (`UNSAFE_DATABASE_ROLE`), prevenindo uso acidental de credenciais
administrativas no processamento financeiro.

### Repositories, unidade de trabalho e idempotência

Adapters: `PostgresWalletRepository`, `PostgresTransactionRepository` e
`PostgresLedgerRepository`, com EntitySchema e mapeadores explícitos. O domínio recebe
Wallet/WagerTransaction/WalletLedgerEntry reidratados, sem entidades ORM. As colunas
NUMERIC são strings; versões no domínio são bigint e no snapshot JSON são strings.

Cada operação cria fork/transação próprios em READ COMMITTED. Ordem de locks:
wallet → transação atual. A referência terminal é imutável e lida sob o lock da wallet.
SQL manual usa EntityManager.execute com contexto transacional. Wallet, conclusão da
transação e ledger são persistidos no mesmo commit; o retorno aguarda triggers diferidos.
Deadlock e serialização têm até três tentativas inteiras. Timeout é indisponibilidade
transitória e não gera rejeição financeira persistida.

Hash SHA-256 v1 sobre array canônico aprovado. Mesma chave/identidade/hash retorna o
registro existente; divergência, chave global disputada ou identidades cruzadas geram
IDEMPOTENCY_CONFLICT. ON CONFLICT DO NOTHING com nova consulta trata a disputa sem
continuar uma transação abortada. Primeira resposta e replay retornam resultado persistido,
preservando o saldo observado original após movimentos posteriores. PENDING e
PENDING_REFERENCE retornam pendência, sem executar worker ou reprocessar por duplicata.

### Evidências dos cinco cenários de concorrência

| Cenário | Resultado executado |
|---|---|
| A: duas BET 80.00, saldo 100.00 | Uma PROCESSED, uma REJECTED/INSUFFICIENT_FUNDS, saldo 20.00 e exatamente um débito. |
| B: 50 duplicatas | Três processos Bun, pools e conexões PostgreSQL independentes; um transactionId, um resultado terminal, uma execução nova e 49 replays, um débito, saldo 90.00 para BET 10.00 sobre 100.00. |
| C: wallets independentes | B concluiu enquanto A permanecia explicitamente bloqueada por outra transação; saldos e lançamentos separados. |
| D: falha após UPDATE, antes do ledger | Rollback de saldo/versão/transação; nenhuma movimentação parcial. Retry posterior aplicou um único débito. |
| E: REFUND e ROLLBACK simultâneos | Uma compensação e uma rejeição REFERENCE_ALREADY_REVERSED; saldo 100.00 e três entradas totais (abertura, BET, compensação). |

Evidência emitida pela última execução do runner oficial:

```json
{"scenario":"50_duplicates_3_processes","attempts":50,"processes":[30,31,32],"independentBackendPids":[101,102,106],"distinctTransactions":1,"debits":1,"balance":"90.00"}
```

Além dos cenários, um deadlock PostgreSQL real foi induzido com aquisição invertida
deliberada de duas wallets no teste. A unidade de trabalho repetiu a transação abortada
e ambas concluíram sem efeito financeiro. Um lock timeout real retornou indisponibilidade,
sem inserir transação ou rejeição. Essa aquisição invertida existe apenas no teste;
o fluxo de produção usa a ordem consistente por wallet.

### Reconciliação executada

Aberturas zero/positiva, BET/WIN/LOSS, rejeições, REFUND, ROLLBACK e históricos reais
foram reconstruídos com resultado consistente. A consulta em READ ONLY REPEATABLE READ
preservou um snapshot consistente enquanto outra conexão confirmou um débito, e recusou
escritas na própria sessão de leitura.

Nove testes unitários novos cobrem diagnósticos/hash, incluindo lacunas, duplicatas,
equações inválidas, cadeia quebrada, moeda incompatível, transação/ledger ausentes,
saldo materializado divergente e totais históricos superiores à faixa de uma wallet.
Nenhum diagnóstico alterou o saldo. Fixtures inválidas são testes puros; tentativas
equivalentes de persistência foram recusadas pelo PostgreSQL protegido.

### Comandos e resultados finais

```text
bun run typecheck
bun test test/unit
bun run test:build
bun run test:integration:docker
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.test.yml config --quiet
```

| Verificação | Resultado |
|---|---|
| TypeScript strict e build | Aprovados, exit 0 |
| Suite unitária | 155 pass, 0 fail, 1.417 assertions |
| Integração oficial PostgreSQL/LocalStack | 37 pass, 0 fail, 273 assertions |
| Total das suites finais | 192 testes, 0 falhas, 1.690 assertions |
| Smoke compilado em subprocesso | live=200, ready sem dependências=503, término por sinal exit 143 |
| SQL aprovado incorporado | 3/3 byte a byte iguais |
| Bootstrap compilado, inclusive repetição | Aprovado |
| Migration CLI compilada up/down/up | Aprovada em banco descartável vazio |
| Compose principal e de testes | Configuração válida |

O runner oficial usou o projeto aleatório `jungle-financial-test-3ad2d323`, PostgreSQL
17.11-alpine em tmpfs e LocalStack 4.12.0. Removeu seus containers e rede ao concluir,
exit 0. O projeto descartável usado nas iterações foi separado dos serviços existentes.
Os três processos do cenário B rodaram no mesmo container de testes, com processos,
pools e conexões independentes; não se apresenta isso como três containers de aplicação.

### Ajustes encontrados pela execução real

- `down({to:...})` também incluía a migration alvo; o teste foi corrigido para selecionar
  explicitamente apenas a migration financeira, preservando o namespace.
- MikroORM normaliza objetos de parâmetros em lugar; o mapper passou a copiar o snapshot
  imutável e omitir undefined antes da inserção. A representação original não é modificada.
- JSONB reordena propriedades; a primeira resposta passou a usar a leitura persistida,
  assim como o replay. As 50 respostas passaram a ter o mesmo resultado serializado.
- Bootstrap repetido passou a verificar a fundação já aplicada antes de pedir seu up.
- O primeiro smoke local foi bloqueado por EPERM/uv_spawn no sandbox; a execução autorizada
  com permissão de subprocesso passou. O acesso ao Docker também exigiu permissão de pipe.
  Nenhuma revisão automática de aprovação rejeitou as execuções solicitadas.

Nenhum desses ajustes mudou o DDL, os privilégios aprovados ou a política financeira.
Resultados intermediários com falha não foram contabilizados como aprovações finais.

### Riscos, pendências e preparação da Etapa 4

- A exclusão conjunta de REFUND/ROLLBACK é uma restrição adicional à redação por tipo
  do item 7.4, revisada e aceita explicitamente; continua documentada para o avaliador.
- Banco/volume de desenvolvimento não foram migrados. O operador deverá atualizar um
  `.env` antigo e executar os jobs documentados para habilitar seu ambiente, sem apagar dados.
- Mudar a senha no `.env` não altera logins já provisionados. Rotação é administrativa.
- Não houve teste de carga ou SLO; os testes comprovam os cenários cobertos, não throughput.
- Perda real de conexão exatamente durante o commit não foi injetada; a recuperação
  prevista continua sendo repetir a mesma identidade, sem compensação automática.
- BIGINT limita versões a 9223372036854775807; Application e banco recusam overflow.
- Não há endpoints/replay HTTP completos, identidade externa operacional, consumer SQS,
  publisher, worker de referências, retry/DLQ de mensagens ou métricas financeiras completas.
- Para a Etapa 4, estender a sessão transacional com inbox/outbox e grants específicos,
  definir contratos de aceite/replay e workers, depois testar crash após commit/antes
  do ack e publishers concorrentes. A Etapa 4 não foi iniciada.

## Entrega e validação da Etapa 4 — 28/10/2026

Esta seção registra a implementação solicitada de API REST, contratos HTTP e replay.
Antes das alterações foram conferidos enunciado, autorização do schema, migrations e
evidências da Etapa 3. Typecheck, 155 testes unitários e os 37 de integração foram
reexecutados: todos passaram. O plano foi apresentado antes da implementação e coube
nas camadas aprovadas. Não houve migration nova, mudança de grants, dependência nova
ou alteração do domínio financeiro. Não houve avanço para a Etapa 5.

### Endpoints e contratos

Implementados os sete endpoints financeiros, preservados os dois health checks:

```text
POST /wallets
GET /wallets/:walletId
GET /wallets/:walletId/ledger
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wagering/transactions
POST /wallets/:walletId/reconciliation
GET /health/live
GET /health/ready
```

Contratos, exemplos e decisões em [docs/HTTP_API.md](docs/HTTP_API.md). Dinheiro como
MoneyProps com string canônica de duas casas; versões como strings; timestamps ISO UTC.
Wallet inclui id/playerId/currency/balance/version/timestamps. Ledger inclui transactionId,
direção, money, before/after, versão e timestamp, em `{items,nextCursor}`. GET de transações
retorna identidade/estado e resultado terminal persistido, sem chave/hash ou entidade ORM.
Reconciliação usa storedBalance/calculatedBalance/difference/consistent/checkedEntries,
com metadados adicionais e issues. Contagem checkedEntries é number não financeiro com
guarda de inteiro seguro; dinheiro e versões não são convertidos para number.

### Arquivos criados

```text
src/application/financial/financial-query-service.ts
src/application/financial/ledger-cursor.ts
src/interfaces/http/financial-dtos.ts
src/interfaces/http/financial-responses.ts
src/interfaces/http/http-metrics.ts
src/interfaces/http/transactions.controller.ts
src/interfaces/http/wallets.controller.ts
test/integration/http.test.ts
test/support/http-process.ts
test/unit/http-contracts.test.ts
docs/HTTP_API.md
```

### Arquivos modificados

```text
src/app.module.ts
src/bootstrap.ts
src/application/financial/errors.ts
src/application/financial/ports.ts
src/application/financial/reconciliation.ts
src/infrastructure/observability/json-logger.ts
src/infrastructure/persistence/financial-unit-of-work.ts
src/infrastructure/persistence/repositories/ledger-repository.ts
src/interfaces/http/exception.filter.ts
test/unit/bootstrap.test.ts
README.md
ARCHITECTURE.md
VALIDATION.md
```

`dist/` foi regenerado pelo build e continua ignorado. `.env`, banco, volume e serviços
de desenvolvimento foram preservados. Os scripts SQL e a política da Etapa 3 permaneceram
inalterados; a validação usa apenas bancos PostgreSQL descartáveis com migrations existentes.

### Idempotência e paginação HTTP

- Idempotency-Key obrigatório, único, validado e fonte da verdade; body com chave/hash
  ou propriedades desconhecidas é recusado antes do processamento.
- O FinancialService e hash canônico v1 existentes são reutilizados. Nenhuma garantia
  financeira depende de memória, Map, fila ou resposta HTTP armazenada em paralelo.
- Primeira resposta e replay derivam do resultado persistido. POST retorna 200 para
  PROCESSED, 202 para PENDING/PENDING_REFERENCE, 422 para REJECTED, 500 para FAILED persistido.
- Mudança de chave/identidade/payload ou identidades cruzadas retorna conflito 409.
- Replay pendente não processa novamente. Quando o estado muda por processamento interno,
  um replay posterior retorna o terminal. O teste conclui a pendência usando domínio,
  locks e UoW aprovados em harness de teste; nenhum worker/endpoint alternativo foi criado.
- Ledger usa keyset por versão, com limite superior fixado no primeiro snapshot; novos
  lançamentos ficam fora daquele percurso. Cursor validado, vinculado à wallet e portátil
  entre réplicas, sem OFFSET, assinatura ou promessa de autorização criptográfica.

### Erros e observabilidade

Payload/header/cursor inválido: 400. Recurso ausente: 404. Conflito de identidade ou wallet
duplicada: 409. Rejeição financeira: 422 com failureCode e snapshot persistidos. Falha
transitória: 503 TEMPORARILY_UNAVAILABLE, sem marcar operação REJECTED. Erro interno
inesperado: 500 INTERNAL_ERROR, sem SQL/stack/configuração. FAILED auditável existente
tem body financeiro e failureCode permanente; GET do registro continua retornando 200.

O filtro global preserva correlationId e inclui requestId. Logs de conclusão registram
duração, status e IDs financeiros validados, sem body, query, chave, hash ou credenciais.
Contadores locais por processo estão preparados para exporter futuro e não são usados
para dedup/integridade. Divergências de reconciliação geram evento e contador próprios,
além de resposta estruturada; nenhuma correção automática é executada.

### Evidências de concorrência HTTP

Os E2E iniciam três processos Nest reais usando o código compilado em dist. Cada réplica
tem pool próprio, conexão independente e login runtime restrito. Todos compartilham o
mesmo banco descartável; os IDs de processo e backend são verificados como distintos.
Não são três containers; são três processos servidores HTTP completos no container de testes.

| Cenário executado | Resultado |
|---|---|
| Abertura duplicada em duas réplicas | 201 e 409; uma wallet por player/moeda. |
| Duas BET 80.00 sobre 100.00 | 200 e 422; saldo 20.00, um débito e abertura no ledger. |
| 50 requisições idênticas em três réplicas | Cinquenta respostas 200, um transactionId, uma execução nova e 49 replays, um débito e saldo 90.00. |
| Chave global entre wallets diferentes | 200 e 409; apenas uma wallet movimentada. |
| REFUND/ROLLBACK simultâneos | 200 e 422; uma única compensação. |
| Wallets independentes | B concluiu enquanto A permaneceu bloqueada por conexão independente. |
| Inserção durante paginação | Percurso original devolveu versões 1/2/3 sem duplicação; nova consulta incluiu versão 4. Cursor funcionou em outra réplica. |
| Timeout PostgreSQL real por HTTP | 503 sem detalhes internos, sem transação/rejeição persistida e sem efeito parcial. |

Evidência da execução final:

```json
{"scenario":"50_http_duplicates_3_replicas","attempts":50,"processIds":[31,56,78],"backendPids":[100,108,109],"distinctTransactions":1,"debits":1,"balance":"90.00"}
```

### Evidência do replay histórico e pendências

Wallet 100.00 → BET 20.00 retorna 80.00 → WIN 50.00 retorna saldo atual 130.00 → replay
da BET em outra réplica retorna 80.00, versão e completedAt originais; saldo atual continua
130.00 e o ledger permanece com três entradas (OPENING/BET/WIN).

```json
{"scenario":"http_historical_replay","observedAfterBet":"80.00","currentAfterWin":"130.00","replayBalance":"80.00","ledgerEntries":3}
```

Também passaram replay PENDING (202), PENDING_REFERENCE (202), GET de estado atual,
replay após conclusão interna (200), replay histórico de REJECTED (422) depois de novo
crédito, e replay de FAILED persistido (500) sem novo lançamento. Os dois GETs de transação
devolveram a mesma representação histórica por ID interno e provider/external ID.

### Comandos e resultados finais

```text
bun run typecheck
bun test test/unit
bun run test:build
bun run test:integration:docker
```

| Verificação | Resultado |
|---|---|
| TypeScript strict | Aprovado, exit 0 |
| Build e smoke compilado | Aprovados; live=200, ready sem dependências=503, término por sinal exit 143 |
| Suite unitária | 167 pass, 0 fail, 1.505 assertions |
| Integração e E2E PostgreSQL/LocalStack | 56 pass, 0 fail, 735 assertions |
| Composição dos 56 testes | 7 fundação + 30 financeiros + 19 HTTP |
| Total final | 223 testes, 0 falhas, 2.240 assertions |

O runner oficial final usou o projeto novo `jungle-financial-test-a1359da0`, PostgreSQL
17.11-alpine em tmpfs e LocalStack 4.12.0. Removeu seus containers e rede e terminou com
exit 0. O projeto usado nas iterações foi separado do desenvolvimento e removido ao final.

Os E2E também cobrem whitelist, campos obrigatórios, dinheiro como string, precisão,
moeda, OPENING externo, referências inválidas, header ausente/duplicado, IDs inválidos,
NUL/surrogate isolado, recursos ausentes, não exposição de hashes/chaves/SQL/stack e
IDs de rastreamento. Os testes originais de integridade, privilégios, migrations up/down/up,
deadlock/retry e reconciliação continuaram passando na mesma execução.

Durante a preparação do harness compilado, uma quebra de linha antes de `as` gerou
erro de sintaxe TypeScript; foi corrigida antes da execução final. As execuções com
erro não foram contabilizadas como sucesso. Nenhuma dependência/DDL/grant foi alterado.

### Pendências, riscos e preparação da Etapa 5

- Autenticação externa e autorização por provider permanecem fora do escopo; a API não
  oferece isolamento autorizado entre clientes. O uso validado nesta entrega é local/teste.
- Não há consumer, publisher, worker de referências, retry/DLQ de mensagens ou frontend.
  A conclusão de pendência demonstrada é somente um harness interno de teste.
- Não foi injetada perda real de conexão exatamente durante COMMIT; o caminho de erro
  evita rejeição permanente e exige repetição da identidade, mas esse ponto continua
  sem evidência específica de falha real de rede no instante do commit.
- Contadores são por processo, sem exporter/agregador. Não houve teste de carga/SLO.
- Reconciliação completa lê o histórico em snapshot; limites operacionais de históricos
  grandes e exportação de métricas devem ser dimensionados posteriormente.
- O cursor não é assinado nem autentica acesso; controles de autorização futuros devem
  validar a wallet independentemente do cursor.
- O banco de desenvolvimento e seu `.env` não foram atualizados. Os jobs documentados
  da Etapa 3 continuam responsáveis por preparar runtime/migrations no ambiente do operador.
- Para a Etapa 5: integrar inbox/outbox na mesma UoW, revisar grants específicos, implementar
  os workers autorizados e testar redelivery, crash após commit/antes do ack, publicação
  concorrente e pending references. Nenhum desses componentes foi iniciado automaticamente.

## Entrega e validação da Etapa 5 — 29/10/2026

O usuário autorizou a Etapa 5 após o plano e a inspeção inicial. A base foi reexecutada
antes da implementação: 167 testes unitários (1.505 assertions) e 56 de integração
(735 assertions), todos aprovados. As aprovações das migrations financeiras das Etapas
3/4 foram confirmadas no histórico documentado. A aplicação das migrations e os grants
foram verificados em PostgreSQL real descartável, usando owner e runtime separados.

### Implementação e contratos

- O mesmo FinancialService atende HTTP e SQS; FinancialSession agora contém inbox/outbox
  no mesmo contexto SQL dos repositories financeiros. Não foi criado outro motor financeiro.
- PK persistente `(consumer_name,message_id)`, hash de envelope canônico, comparação de
  identidade e conclusão do inbox no commit financeiro. Replay não cria novo ledger/evento.
- Quatro subclasses de IntegrationEvent: WagerTransactionProcessed, WagerTransactionRejected,
  WalletBalanceChanged e WagerTransactionPendingReference. IDs/JSON persistidos não mudam
  nas tentativas de publicação. Abertura positiva também emite eventos; LOSS/rejeição não
  emitem mudança de saldo. Abertura zero não emite eventos.
- Consumer usa SDK AWS v3, long polling, concorrência configurável, agrupamento por wallet,
  heartbeat de visibilidade, ACK depois de commit confirmado e consulta ao inbox após
  resposta de commit perdida. Invalid/permanent/temporary/business rejection são distintos.
- Publisher separado usa SKIP LOCKED, owner/attempt/lease e marcação condicionada ao claim
  vigente. Rede SQS fica fora das transações PostgreSQL. Eventos são sequenciados por wallet;
  um evento pendente/esgotado não pode ser ultrapassado na mesma wallet.
- Retry exponencial com equal jitter e limites configuráveis. Mensagens esgotadas vão à
  FIFO DLQ; redrive nativo cobre falhas anteriores à transferência explícita. Falhas de
  publicação esgotadas ficam duráveis na outbox, com métrica própria e recuperação operacional.
- SIGTERM/SIGINT interrompem polling e drenam trabalho, com prazo no entrypoint; SIGKILL
  recupera por redelivery e expiração de lease. Logs JSON e métricas por processo, sem payloads.

Contratos JSON, configuração FIFO/DLQ, taxonomia operacional, limites e procedimento de
reprocessamento estão em [docs/MESSAGING.md](docs/MESSAGING.md).

### Migration e privilégios reais

Migration `20261029000100` registrada no migrator oficial. Não altera o SQL aprovado da
Etapa 3: acrescenta position identity/índice de ordenação e last_error_code na outbox;
concede INSERT em inbox/outbox e UPDATE apenas nas colunas operacionais indicadas no DDL;
ajusta check_message_reference para permitir o evento PENDING_REFERENCE. Ledger permanece
imutável e runtime não recebe DELETE/TRUNCATE/DDL nem acesso ao histórico de migrations.

Up/down/up das migrations 002/003 foi executado como owner e restaurou as cinco tabelas
e vinte triggers. Grants foram consultados e usados com login runtime não administrativo;
DELETE/TRUNCATE de inbox/outbox e mutações de ledger continuaram recusados. Os testes de
constraints, locks, snapshots, reversões e idempotência das etapas anteriores passaram.
O down da migration nova exige inbox/outbox vazios e não apaga eventos para viabilizar rollback.

### Arquivos criados

```text
docs/MESSAGING.md
src/application/messaging/command-envelope.ts
src/application/messaging/integration-event.ts
src/application/messaging/ports.ts
src/infrastructure/messaging/outbox-publisher.ts
src/infrastructure/messaging/queue-setup.ts
src/infrastructure/messaging/retry.ts
src/infrastructure/messaging/transaction-consumer.ts
src/infrastructure/observability/messaging-metrics.ts
src/infrastructure/persistence/migrations/Migration20261029000100.ts
src/infrastructure/persistence/outbox-store.ts
src/infrastructure/persistence/repositories/message-repositories.ts
src/workers/main.ts
test/integration/messaging.test.ts
test/support/messaging-process.ts
test/unit/messaging.test.ts
```

### Arquivos modificados

```text
.env.example
ARCHITECTURE.md
README.md
VALIDATION.md
docker-compose.yml
package.json
scripts/init-queues.ts
src/application/financial/financial-service.ts
src/application/financial/ports.ts
src/infrastructure/config/environment.ts
src/infrastructure/messaging/sqs.service.ts
src/infrastructure/observability/json-logger.ts
src/infrastructure/persistence/financial-unit-of-work.ts
src/infrastructure/persistence/orm-options.ts
src/interfaces/http/transactions.controller.ts
src/interfaces/http/wallets.controller.ts
test/integration/financial.test.ts
```

Nenhum arquivo foi removido; nenhuma dependência foi adicionada ou atualizada. bun.lock,
domínio financeiro e SQL aprovado da Etapa 3 foram preservados. dist foi regenerado e
continua ignorado. O teste legado de grants agora verifica a escrita autorizada na Etapa 5
e a proibição de DELETE/TRUNCATE. A fixture de evento usa um tipo próprio para continuar
testando imutabilidade/unique sem colidir com WalletBalanceChanged gerado automaticamente.

### Cenários reais de mensageria

| Cenário | Resultado executado |
|---|---|
| A — 50 duplicatas | DeduplicationIds de transporte diferentes forçaram 50 entregas; 49 replays, um inbox, um débito, saldo 90.00 e dois eventos da operação. |
| B — crash do consumer | Processo recebeu SIGKILL após commit e antes de ACK. Novo processo detectou duplicata persistente; um inbox e um débito. |
| C — falha pré-commit | Erro injetado após todas as escritas financeiras/outbox; rollback deixou saldo 100.00, nenhum inbox/transação/débito da aposta. Novo processo aplicou uma vez, saldo 90.00. |
| D — dois publishers | Processos iniciados por uma barreira simultânea, ambos publicaram; 32 eventos únicos, sequência crescente por wallet, sem claim incorreto. |
| E — crash do publisher | SIGKILL depois do SendMessage e antes de published_at; novo publisher recuperou lease expirado, mesmo eventId/payload e attempts=2. |
| F — três consumers | Três processos/pools/backend PIDs distintos; nove wallets concluíram enquanto outra estava sob lock externo. Depois do unlock, todos os históricos reconciliaram com um débito por wallet. |
| G — DLQ | Falhas pré-commit repetidas atingiram FIFO DLQ com corpo/identificadores e ErrorCode preservados; nenhum efeito financeiro parcial ou inbox confirmado. |
| H — reinício | Consumers/publishers parados e recriados com comandos/eventos pendentes; quatro eventos publicados e saldo/ledger íntegros. |
| Envelope e conflito | Dinheiro number, schema inválido e messageId com payload divergente foram para DLQ; REJECTED financeiro válido recebeu ACK e não gerou evento de saldo. |
| LOSS e referência | Eventos tipados corretos; saldo/versão sem alteração; referência permaneceu pendente, sem antecipar worker da Etapa 6. |
| Subscriber idempotente | Entregas duplicadas de eventId via SQS com DeduplicationIds diferentes produziram uma única linha de projeção, usando inbox SQL na mesma transação e sem UNIQUE na projeção. |
| Lease e orçamento | Publisher antigo não conseguiu marcar/reagendar claim expirado; orçamento esgotado permaneceu durável e pôde ser recuperado com orçamento explicitamente maior. |
| Commit incerto | Commit real seguido de resposta simulada como indisponível foi resolvido por consulta ao inbox antes do ACK, sem repetir movimento. |
| SIGTERM em voo | Worker aguardou operação bloqueada, concluiu commit/ACK após unlock e não buscou o comando seguinte. |
| Entrypoints compilados | Consumer e publisher de dist validaram dependências, processaram trabalho real e encerraram com worker_stopped e exit 0. |

Evidências da execução oficial final:

```json
{"scenario":"sqs_50_duplicates","deliveries":50,"duplicates":49,"debits":1,"balance":"90.00"}
{"scenario":"consumer_sigkill_after_commit","inbox":1,"debits":1,"redeliveryDuplicate":1}
{"scenario":"two_publishers","processIds":[210,231],"published":32,"uniqueEvents":32}
{"scenario":"publisher_sigkill_after_send","eventId":"2ca28e30-a9d1-4b58-a2db-a138db40fe16","attempts":2,"recoveredByNewProcess":true}
{"scenario":"three_sqs_consumers","processes":[294,295,296],"backendPids":[204,205,206],"independentWallets":9,"lockedWalletPreserved":true}
```

### Comandos e resultados finais

O Bun local foi localizado em `.tools/package/bin/bun.exe`; os comandos abaixo foram
executados por esse binário, usando a mesma versão 1.4.4 da imagem Docker:

```text
bun run test:build
bun test test/unit
bun run test:integration:docker
docker compose config --quiet
git diff --check
```

| Verificação | Resultado |
|---|---|
| Typecheck strict | Aprovado, inclusive no build Docker |
| Build e smoke compilado | Aprovados; live=200, ready sem dependências=503, término por sinal exit 143 |
| Unitários | 172 pass, 0 fail, 1.531 assertions |
| Integração real | 71 pass, 0 fail, 996 assertions |
| Composição das integrações | 7 fundação + 30 financeiras + 19 HTTP + 15 mensageria |
| Total | 243 testes, 0 falhas, 2.527 assertions |
| Compose | Configuração válida com API/consumer/publisher separados |

O runner final usou `jungle-financial-test-83237743`, PostgreSQL 17.11-alpine em tmpfs e
LocalStack 4.12.0. Finalizou com exit 0 e removeu seus containers/rede. O projeto de
iteração `jungle-stage5-validation` também foi removido. Nenhum down -v foi usado.
Logs locais ignorados: `.cache-stage5-final-unit.log` e `.cache-stage5-final-docker.log`.

### Intercorrências, riscos e Etapa 6

- O Docker ficou indisponível durante o desenvolvimento, com status stopped e start
  contraditório; foi recuperado com Docker Desktop restart. A execução oficial posterior
  foi feita em infraestrutura descartável nova. A causa interna do backend não foi confirmada.
- Smoke local inicial teve EPERM ao criar subprocesso no sandbox; a repetição fora dele
  passou. A primeira integração com mudanças teve uma fixture legada colidindo com o
  evento real, corrigida antes do resultado final. Nenhuma falha intermediária foi contada
  como sucesso e não houve rejeição de revisão automática de aprovação.
- Três consumers e dois publishers foram processos Bun independentes dentro do container
  de testes; não se apresenta isso como cinco containers. O Compose de desenvolvimento
  está configurado para escalar serviços separados, mas não foi atualizado por esses testes.
- `.env`, volume e schema de desenvolvimento não foram migrados ou alterados por esta
  entrega. O restart do Docker reiniciou o Engine; os testes não apagaram seus dados.
- A perda de resposta após commit é injetada após um commit PostgreSQL real; não houve
  falha física de rede exatamente durante COMMIT. A duplicação além da janela do broker
  foi simulada por DeduplicationIds diferentes, sem esperar a janela de cinco minutos.
- Subscribers de produto não foram criados. O consumidor de eventos usado para comprovar
  dedup é um harness de projeção transacional; integrações futuras devem persistir eventId.
- Tentativas de publicação são limitadas; evento esgotado bloqueia sua wallet até intervenção,
  sem descarte. Métricas são locais ao processo, sem agregador/exporter, carga ou SLO.
- Autenticação externa permanece pendente. Não houve backfill de eventos anteriores.
- Etapa 6 não foi iniciada: worker avançado de referências, backoff/TTL de pendências e
  desfecho por referência inexistente continuam pendentes de implementação específica.

## Entrega e validação da Etapa 6 — 29/10/2026

Esta seção substitui a pendência da Etapa 6 registrada acima. O usuário aprovou o plano
e o DDL completos de docs/stage-6/. A base foi reexecutada antes da implementação: build,
typecheck, smoke, 172 testes unitários e 71 integrações, todos aprovados. O plano adotou
claim transacional wallet → transaction, sem lease adicional, e expiração REJECTED conforme
o item 7.1 do enunciado. Não houve autorização ou avanço para a Etapa 7.

### Implementação e arquivos

Criados na preparação e implementação desta etapa:

```text
docs/PENDING_REFERENCES.md
docs/stage-6/REVIEW.md
docs/stage-6/01-pending-reference-up.proposed.sql
docs/stage-6/02-pending-reference-down.proposed.sql
src/application/pending-reference/policy.ts
src/application/pending-reference/ports.ts
src/infrastructure/observability/pending-reference-metrics.ts
src/infrastructure/pending-reference/reference-scheduler.ts
src/infrastructure/persistence/migrations/Migration20261029000200.ts
src/infrastructure/persistence/migrations/pending-reference-sql.ts
src/infrastructure/persistence/repositories/pending-reference-repository.ts
test/integration/pending-reference.test.ts
test/support/pending-reference-process.ts
test/unit/pending-reference.test.ts
```

Modificados nesta etapa, sobre o estado da Etapa 5 já existente no workspace:

```text
.env.example
ARCHITECTURE.md
README.md
VALIDATION.md
docker-compose.yml
docs/DOMAIN.md
docs/MESSAGING.md
package.json
src/app.module.ts
src/application/financial/financial-service.ts
src/application/financial/ports.ts
src/infrastructure/config/environment.ts
src/infrastructure/observability/json-logger.ts
src/infrastructure/persistence/entities/financial-records.ts
src/infrastructure/persistence/financial-unit-of-work.ts
src/infrastructure/persistence/mappers/financial-mappers.ts
src/infrastructure/persistence/orm-options.ts
src/infrastructure/persistence/repositories/transaction-repository.ts
src/workers/main.ts
test/integration/financial.test.ts
```

As mudanças não commitadas da Etapa 5 foram preservadas. Nenhuma dependência foi adicionada,
nenhum arquivo foi removido, bun.lock e as migrations anteriores permaneceram inalterados.
O teste financeiro de up/down/up inclui a migration nova e agora verifica vinte e um triggers.

### Arquitetura, estados, locks e eventos

FinancialService.submit e resolveNextPendingReference compartilham evaluate/persistDecision
e a FinancialPolicy existente. A resolução reidrata a mesma transação e nunca cria outra
identidade. Claim por FOR UPDATE OF wallet SKIP LOCKED com EXISTS MVCC, seguido de lock
da transação elegível daquela wallet. Referência/histórico são leituras MVCC, sem travar
outra wallet. Scheduler não trava inbox e publisher não solicita wallet durante claim.

Claim e decisão ficam no mesmo commit SQL curto. Não há sleep, espera por referência ou
chamada SQS dentro dele. Rollback libera o claim; idle_in_transaction_session_timeout
local cobre sessão abandonada. Não se adicionou lease persistente nem um contador fictício
de leases recuperados. Os testes comprovam recuperação de lock após crash e timeout mesmo
com o processo antigo ainda vivo. Polling e backoff de infraestrutura ficam fora da UoW.

PENDING_REFERENCE pode permanecer pendente ou concluir como PROCESSED/REJECTED. Não há
regressão para PENDING nem transição de terminal. FAILED não representa expiração ou erro
transitório nesta implementação. Referências rejeitadas/incompatíveis usam os códigos
existentes da FinancialPolicy; TTL/orçamento usam REJECTED/REFERENCE_NOT_FOUND.

Defaults aprovados: TTL de 24h, 20 avaliações totais incluindo o aceite inicial, backoff
base 1s/cap 300s com equal jitter, polling 1s e lote de 20 transações independentes.
Deadline persistido não é estendido por mudança de configuração. A última avaliação antes
do deadline pode resolver; se ainda pendente, esgotar o orçamento rejeita. Deadline vencido
prevalece sobre referência tardia. Falha de infraestrutura faz rollback e não consome
avaliação financeira. Next_attempt_at é limpo ao terminalizar, no mesmo UPDATE do snapshot.

WagerTransactionPendingReference é emitido só na entrada. Processed/Rejected e, quando
há ledger, WalletBalanceChanged são inseridos atomicamente na conclusão. Event IDs da
outbox permanecem estáveis. Correlação original vem do evento de pendência persistido;
legado sem esse evento usa pending-<md5(transactionId)> como fallback determinístico.
Replays HTTP/SQS não iniciam avaliação e retornam o snapshot histórico após terminal.

### Migration executada e privilégios

Migration 20261029000200 acrescenta reference_deadline_at, CHECK de consistência, trigger
de imutabilidade, índice parcial e UPDATE da coluna nova. Não modifica triggers financeiros
anteriores ou a política de reversão. O teste construiu uma pendência real no schema da
Etapa 5, aplicou a migration, conferiu backfill de created_at + 24h e reagendamento, sem
movimento/alteração de status na migration. Down com prazo histórico foi recusado e o
registro ficou intacto. Up/down/up em banco vazio continuou passando na regressão financeira.

O teste legado expôs uma limitação real do DDL inicialmente proposto: após UPDATE, eventos
de constraint triggers diferidos impediam ALTER TABLE/CREATE INDEX subsequentes. A migration
valida esses eventos com SET CONSTRAINTS ALL IMMEDIATE e restaura ALL DEFERRED antes do
DDL seguinte. Não desativa triggers, não divide o commit e não muda o schema aprovado.
As propostas originais foram preservadas; o ajuste de execução está explícito na migration.

Runtime recebeu o grant restrito da coluna; UPDATE do ledger e CREATE de schema continuam
negados. Alterar um deadline preenchido falhou no PostgreSQL com 23514. A transação terminal
permanece imutável e excluída do claim. Writers antigos devem ser drenados antes do upgrade.

### Testes reais novos

| Cenário | Resultado |
|---|---|
| A — REFUND antes da BET | Inbox confirmou e SQS recebeu ACK enquanto PENDING_REFERENCE. Depois da BET, scheduler processou a mesma identidade; saldo 100.00 e três entradas no ledger. |
| B — ROLLBACK antes da WIN | WIN elevou saldo e a pendência aplicou o débito inverso; saldo 100.00, três entradas e mesmo transactionId. |
| C — referência incompatível | Player, wallet, moeda, round, valor e kind produziram rejeições específicas, sem ledger adicional. |
| Namespace do provider | Mesmo externalId em outro provider não foi usado; referência correta continuou ausente até expiração, sem alias ou dupla compensação. |
| D — referência REJECTED | Pendência rejeitada com REFERENCE_NOT_PROCESSED, saldo/ledger sem alteração adicional. |
| Referência ainda pendente | Cadeia ROLLBACK → REFUND → BET reagendou sem repetir evento de pendência e depois resolveu; saldo 90.00 e quatro entradas. |
| Referência tardia | BET após deadline não reviveu REFUND; REJECTED persistido e nenhum crédito indevido. |
| E — TTL e orçamento | Deadline e três avaliações totais testados separadamente; REJECTED/REFERENCE_NOT_FOUND, snapshot, next_attempt_at nulo e nenhuma movimentação. Trocar TTL na configuração não alterou prazo persistido. |
| F — três schedulers | Três processos/pools/backend PIDs independentes, barreira de início; uma resolução, um crédito de REFUND e processing_attempts=2. |
| G — crash antes do commit | SIGKILL após escritas financeiras/outbox deixou rollback de saldo/ledger/status/contador/eventos. Outro processo retomou e aplicou uma vez. |
| H — crash após commit | SIGKILL antes do ciclo operacional terminar; reinício não repetiu crédito, tentativa ou evento terminal. |
| I — replay HTTP | Replay pendente não incrementou contador. Depois da resolução e outro crédito, replay retornou saldo histórico 100.00; saldo atual 150.00, quatro entradas. Payload divergente manteve 409. |
| J — reinício de todas as instâncias | Três workers parados e três recriados localizaram seis pendências persistidas; referências posteriores resolveram sem replay de clientes. |
| K — reversões concorrentes | REFUND e ROLLBACK pendentes da mesma BET: exatamente uma PROCESSED e outra REJECTED, saldo 100.00 e uma compensação. |
| Crash após claim | SIGKILL liberou o claim sem consumir tentativa; outra instância concluiu. |
| Sessão abandonada | Processo antigo permaneceu vivo; timeout idle real do PostgreSQL liberou a transação e permitiu recuperação por outro worker. |
| Wallets independentes | Wallet A travada externamente foi pulada; B concluiu enquanto A continuava bloqueada. |
| PostgreSQL indisponível para a tentativa | Lock exclusivo real na tabela causou timeout SQL e PERSISTENCE_UNAVAILABLE; nenhum orçamento consumido ou rejeição financeira; tentativa seguinte concluiu. |
| SQS indisponível | Entrypoint compilado do scheduler iniciou com endpoint SQS inacessível e confirmou a resolução. Publisher falhou no endpoint real indisponível e depois publicou os três eventos duráveis da pendência no LocalStack. |

Evidências do runner oficial final:

```json
{"scenario":"refund_before_bet","pendingAck":true,"result":"PROCESSED","balance":"100.00","ledger":3}
{"scenario":"three_pending_workers","processes":[105,106,107],"backendPids":[147,145,146],"resolutions":1,"refundLedger":1}
{"scenario":"pending_crash_after_commit","status":"PROCESSED","attempts":2,"refundLedger":1}
{"scenario":"pending_http_historical_replay","terminalBalance":"100.00","currentBalance":"150.00","ledger":4}
```

### Resultado final da regressão

```text
bun run typecheck
bun test test/unit
bun run test:build
bun run test:integration:docker
docker compose config --quiet
git diff --check
```

| Verificação | Resultado executado |
|---|---|
| Typecheck/build | Aprovados, no host e no build Linux Docker |
| Smoke compilado | live=200; ready sem dependências=503; término por sinal exit 143 |
| Unitários | 176 pass, zero falhas, 1.545 assertions |
| Integração PostgreSQL/LocalStack | 91 pass, zero falhas, 1.214 assertions |
| Composição | 7 fundação + 30 financeiros + 19 HTTP + 15 mensageria + 20 referências |
| Total | 267 testes, zero falhas, 2.759 assertions |
| Compose e whitespace | Configuração válida; diff sem erros |

O runner oficial `jungle-financial-test-a94e0eaa` terminou com exit 0 e removeu os próprios
containers/rede. PostgreSQL 17.11-alpine em tmpfs, LocalStack 4.12.0 e Bun 1.4.4, sem mocks
financeiros substituindo banco/broker. Logs locais ignorados: .cache-stage6-final-build.log,
.cache-stage6-final-unit.log e .cache-stage6-final-docker.log. Nenhum down -v foi usado.

### Riscos, limites e Etapa 7

- Desenvolvimento não foi migrado: .env, volume e dados financeiros existentes foram
  preservados. Upgrade requer writers drenados e revisão de pendências legadas já vencidas.
- Testes de concorrência/crash usam processos Bun independentes dentro do container de
  testes, não três containers implantados. O Compose está configurado para escalar schedulers.
- TTL/backoff usam relógio/jitter injetados nos testes; operação real pressupõe relógios UTC
  sincronizados. Não há SLA, benchmark de carga ou exporter/agregação de métricas.
- Indisponibilidade PostgreSQL foi um lock/timeout real; SQS foi endpoint TCP inacessível.
  Não se desligou todo o PostgreSQL/LocalStack de desenvolvimento para simular indisponibilidade.
- Ciclos de referências aguardam até limite/TTL; não há detecção de ciclos ou ordenação
  topológica. Namespace de provider diferente não é pesquisado como referência alternativa.
- Sem lease durável, não há contador exato de claims recuperados; recuperação de lock/estado
  foi comprovada funcionalmente, sem inferir contagens que o banco não registra.
- Execuções intermediárias tiveram uma comparação de enum tipada incorretamente, o caso de
  triggers diferidos no DDL e uma fixture que tratava timestamp SQL bruto como Date. Foram
  corrigidos antes do resultado final; as falhas não foram contadas como aprovação.
- Nenhum novo motor, código de falha financeira, regra de reversão, frontend ou autenticação externa
  foi acrescentado. Não houve commit/push ou avanço automático para a Etapa 7. O escopo da
  próxima etapa deve ser definido pelo pedido específico; autenticação, observabilidade
  agregada e carga continuam limitações documentadas, sem serem assumidas como seu escopo.

## Etapa 7 — auditoria inicial, 29/10/2026

Parecer **INCOMPLETO**. Regressão atual: typecheck/build/smoke aprovados; 176 testes
unitários e 91 de integração passaram, zero falhas, 2.759 assertions. Projeto isolado
`jungle-financial-test-155e0211` removido pelo runner, exit 0. Ambiente principal
preservado: APIs antigas unhealthy, apenas migration inicial, sem filas ou workers.

Relatório e limites em [docs/stage-7/AUDIT.md](docs/stage-7/AUDIT.md), rastreabilidade
em [MATRIX.md](docs/stage-7/MATRIX.md), resultados individuais em
[EVIDENCE.txt](docs/stage-7/EVIDENCE.txt) e plano pendente de aprovação em
[PLAN.md](docs/stage-7/PLAN.md). Não houve implementação de runtime nesta auditoria.
Ainda faltam carga/percentis, bateria completa de falhas e ambiente com três containers
API mais workers; lacunas de métricas e readiness constam da matriz. Não se aprovou
integralmente a Etapa 7 nem se iniciou a Etapa 8.

## Etapa 7 — execução após autorização, 29/10/2026

**APROVADO COM RESSALVAS no escopo local.** Este resultado sucede a auditoria inicial
incompleta acima. Build/typecheck/smoke aprovados; 176 unitários + 101 integrações =
277 testes PASS, zero FAIL, 2.849 assertions. Integração final no projeto descartável
`jungle-financial-test-bdbbd37c`, exit 0. Novos testes incluem schema parcial, seis
pontos de rollback, terminação real da conexão antes de commit, contadores pós-commit
e protocolo FIFO com dedup, visibilidade, redelivery e long polling reais.

O runner `jungle-distributed-test-146a4069` passou 11 cenários entre containers mais
preparação de backlog, recuperação e carga (14 verificações). Três APIs, três
consumers, dois publishers e três schedulers foram verificados saudáveis. Os 11
containers sofreram SIGKILL/exit 137; após reinício recuperaram seis mensagens,
seis pendências e 18 eventos, sem duplicação financeira. Carga de 118 operações:
19 rejeições financeiras esperadas, zero erro operacional, 38 carteiras reconciliadas,
171 eventos publicados e outbox final vazia. O comando standalone `bun run test:load`
também passou, no projeto separado `jungle-distributed-test-1e158f6f`.

Relatório: [RESULT.md](docs/stage-7/RESULT.md). Matriz: [MATRIX.md](docs/stage-7/MATRIX.md).
Resultados individuais: [FINAL-TESTS.txt](docs/stage-7/FINAL-TESTS.txt). JSONs e hashes
estão no mesmo diretório. Projetos de teste removidos sem down -v. Principal preservado,
sem upgrade de schema ou workers. A falha inicial de binding ANY(?) no harness foi
corrigida para IN (?) e reexecutada; não foi contada como aprovação. Limites de commit,
métricas por processo, LocalStack e capacidade de produção estão explícitos no relatório.
