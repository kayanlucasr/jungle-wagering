# Arquitetura — Etapas 1 a 4

## Escopo e autorização

O enunciado oficial, originalmente lido em `C:/Users/Undead/Downloads/README.md`, está
preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md). A Etapa 0 está registrada no chat.
O usuário autorizou a fundação na Etapa 1 e o domínio/testes na Etapa 2. Na Etapa 3,
aprovou o plano, revisou integralmente os três SQLs e autorizou explicitamente sua execução.

Há regras financeiras puras, persistência ACID, ledger protegido, idempotência persistente,
API REST e reconciliação estruturada. A Etapa 4 usa as camadas e proteções aprovadas na
Etapa 3, sem migrations ou novos privilégios. Não há consumer, publisher, worker de
referências ou autenticação externa. A Etapa 5 não foi iniciada.

## Organização e dependências

Monólito com camadas pragmáticas e princípios hexagonais:

```text
src/
  app.module.ts                    composição de providers
  bootstrap.ts                     servidor, contexto HTTP e lifecycle
  main.ts                          entrypoint Bun
  domain/                          Money, Wallet, transações, ledger e política financeira
  application/financial/           serviço financeiro, portas, hash e reconciliação
  interfaces/http/                 health e tradução de exceções
  infrastructure/config/          configuração validada e imutável
  infrastructure/persistence/     MikroORM, transações e migrations
  infrastructure/messaging/       cliente SQS e verificação de filas
  infrastructure/observability/   logs JSON
scripts/                          migrations, filas, probes e runner de testes
test/unit/                        domínio, configuração, logs e bootstrap HTTP
test/integration/                 PostgreSQL/LocalStack reais
test/support/                     fixtures sem credenciais reais
```

Para este repositório vazio, a organização por camadas sugerida na Etapa 1 reduz
navegação e arquivos de composição no início. Preserva os boundaries propostos na
Etapa 0. Domain foi criado na Etapa 2; Application, entidades e repositories foram
criados com conteúdo real na Etapa 3. Não há arquivos de workers vazios.

Dependências: Interfaces → Application → Domain. Infrastructure implementa
portas da Application. Domain não importa NestJS, MikroORM ou AWS SDK.
Controllers e entidades persistidas não concentram decisões financeiras.

## Stack e justificativas

- Bun 1.4.4 para instalação, execução, compilador TS e testes.
- NestJS 11.2.8, MikroORM 6.6.17 e TypeScript 5.9.3: linhas fixadas para evitar
  introduzir simultaneamente versões principais novas. TypeScript strict e verificações
  adicionais de opcionais e índices.
- MikroORM PostgreSQL: Unit of Work e locks transacionais explícitos. Integração
  via providers Nest locais, sem pacote de integração adicional nesta fundação.
- AWS SDK v3 SQS com Smithy NodeHttpHandler: timeout explícito e sem retries ocultos
  na readiness.
- decimal.js usado pelo Money com configuração privada, precisão exata e strings canônicas.
- JSON logger próprio com superfície pequena, sem dependência adicional.
- Build via TypeScript, executado por Bun, com metadata de decorators preservada.
- LocalStack Community 4.12.0 fixado para execução local sem conta externa. Sua atualização
  requer revisar autenticação/licença e repetir a suite; não se usa `latest`.

Versões instaladas e comandos estão no README e VALIDATION.

## Persistência implementada

`DatabaseService` inicializa metadados ORM sem exigir conexão no bootstrap. Isso permite
liveness com dependências indisponíveis. Readiness abre conexão real e valida o namespace
instalado. Não há criação automática de banco, schema synchronization ou migrations no
bootstrap. O Compose executa um job de migration antes de iniciar a aplicação.

- `allowGlobalContext=false`.
- RequestContext separado por request HTTP.
- Helper `transaction` cria fork e usa `EntityManager.transactional`.
- Operações futuras de fila/job devem ter fork/contexto próprio.
- Pool limitado por processo; dimensionar total considerando réplicas e workers.
- Timeout de conexão, statement e lock configurados.
- Nenhuma entidade monetária provisória foi introduzida.

Migration `20261028000100`: cria namespace `wagering`; down usa RESTRICT.
Migration `20261028000200`: incorpora exatamente o up/down financeiro aprovado,
com cinco tabelas, três domains, vinte triggers e nove índices explícitos.

O job administrativo `database-bootstrap` cria a fundação e provisiona acesso, separado
do job `migrate`. Grupos NOLOGIN `wagering_owner` e `wagering_runtime` possuem logins
distintos. Todas as conexões do migrator assumem o owner pelo parâmetro de conexão;
runtime não acessa o histórico de migrations. A unidade de trabalho verifica a role
efetiva e recusa superuser, privilégios administrativos ou membership no owner.

Entidades ORM usam EntitySchema e campos escalares; FKs/constraints pertencem à migration.
Mappers explícitos convertem registros em factories de reidratação, sem expor ORM ao
domínio. NUMERIC usa strings, BIGINT usa bigint; padding de escala não arredonda valores.
Snapshot JSON é copiado e serializado sem undefined antes de passar ao ORM, cujo tratamento
de parâmetros modifica objetos. O snapshot congelado do domínio nunca é entregue ao ORM.

O domain monetário usa NUMERIC sem typmod, limite de 18 inteiros/2 decimais e CHECK de
escala/finitude. Isso evita arredondamento silencioso de NUMERIC(20,2) antes do CHECK.
O domínio TypeScript continua exigindo strings canônicas e moeda reconhecida pelo runtime.
No banco, currency tem formato de três letras e compatibilidade financeira por constraints.

Triggers imediatos protegem identidade, estados terminais e snapshots; triggers diferidos
vinculam cada mudança de saldo ao ledger e cada transação financeira ao seu efeito.
O ledger é append-only: sem UPDATE/DELETE/TRUNCATE, por grants e triggers. O down recusa
tabelas com dados e usa ACCESS EXCLUSIVE antes da verificação, sem CASCADE.

## HTTP e observabilidade implementados

- Sem prefixo de rota, preservando os caminhos oficiais.
- Health público: live não consulta dependências; ready consulta banco e filas.
- Readiness verifica FIFO, redrive, ARN da DLQ e visibility timeout.
- Exceções traduzidas sem raw SQL, URLs ou payloads.
- Correlation ID validado/gerado e devolvido em header.
- Logs JSON de request contêm método, status, duração e correlation ID; não body/query.
- Shutdown hooks para SIGTERM/SIGINT fecham pool e cliente SQS.

Etapa 4: WalletsController e TransactionsController são adapters finos; chamam os
serviços de comandos/consultas e mapeadores, sem calcular saldo ou acessar EntityManager.
DTOs são validados explicitamente, sem nova biblioteca: whitelist, campos obrigatórios,
Money existente, referências e identificadores Unicode preserváveis em PostgreSQL.
Header Idempotency-Key é obrigatório e único, nunca substituído por campo de body.

FinancialQueryService usa as mesmas portas/UoW em snapshot somente leitura. Ledger tem
keyset crescente por versão e limite superior fixado na primeira página; cursor Base64URL
é versionado, vinculado à wallet e portátil entre instâncias. Não é token de autorização
nem possui assinatura criptográfica. Ledger imutável permite percurso estável sem OFFSET.

O filtro global distingue 400/404/409 de indisponibilidade 503, sem expor erros de driver.
Respostas financeiras usam 200 PROCESSED, 202 pendente, 422 REJECTED ou 500 FAILED persistido.
Replay terminal usa exclusivamente o resultado persistido; status HTTP é derivado dele,
sem necessidade de outro snapshot HTTP ou alteração de schema. O body histórico é estável,
exceto idempotentReplay; correlation/request IDs pertencem à nova requisição.

Request ID é gerado por request; logs incluem IDs financeiros validados, duração e status,
sem chave/hash/payload completo. HttpMetrics mantém somente contadores de observabilidade
por processo, incluindo inconsistências de reconciliação, sem uso em integridade financeira.
Não foi adicionado exporter, novo endpoint de métricas ou infraestrutura de monitoramento.
Os contratos completos e seus limites estão em [docs/HTTP_API.md](docs/HTTP_API.md).

Métricas financeiras, DLQ, retries e outbox lag ainda não estão implementadas porque os
fluxos correspondentes não existem nesta etapa. Não se declara observabilidade final completa.

## Infraestrutura implementada

Compose principal: PostgreSQL persistente, LocalStack, jobs one-shot de bootstrap/migrate/queues
e aplicação. Sem Docker socket montado no LocalStack: SQS não precisa dele.

Aplicação sem host port fixa por padrão. `--scale app=3` atribui portas dinâmicas,
sem `container_name`. Todos os processos compartilharão código e PostgreSQL;
entrypoints de workers serão adicionados apenas quando autorizados.

Compose de teste separado: sem portas/volumes compartilhados, projeto aleatório,
PostgreSQL descartável e banco adicional aleatório criado para up/down/up.
Não remove bancos ou volumes de desenvolvimento.

## Concorrência implementada — Etapa 3

Pessimistic locking por wallet, READ COMMITTED, transação curta e sem chamadas de rede.
Repositório usa `LockMode.PESSIMISTIC_WRITE` dentro de transação ativa.
Ordem: wallet → transação atual → validação da referência. Worker não pode manter
lock da transação enquanto aguarda wallet. Retry limitado para deadlock e falhas retryable.
Wallets distintas avançam em paralelo; nenhuma garantia depende de mutex do processo.

`PostgresFinancialUnitOfWork` cria fork/transação por chamada. SQL manual usa
`EntityManager.execute`, que encaminha o contexto transacional. Wallet é atualizada
antes da conclusão da transação e inserção do ledger. A Promise só resolve após o commit
e os triggers diferidos. Deadlock/serialização têm no máximo três tentativas inteiras;
timeout vira PERSISTENCE_UNAVAILABLE, sem rejeição financeira. Uma resposta perdida após
commit deve ser recuperada repetindo a mesma identidade.

## Idempotência persistente implementada — Etapa 3

Chave global e UNIQUE(provider_id,external_transaction_id); hash SHA-256 v1 calculado
pela Application sobre array canônico aprovado. Não se aceita hash do cliente. Consulta
antes e depois do lock; INSERT ON CONFLICT DO NOTHING com reconsulta em novo statement
resolve disputas entre wallets distintas sem continuar uma transação abortada.

Mesma chave/identidade/hash retorna o registro existente. Divergência ou identidades
cruzadas produzem IDEMPOTENCY_CONFLICT. Replay terminal e primeira resposta usam o snapshot
persistido, sem reconstruí-lo a partir do saldo atual. Replay de PENDING ou PENDING_REFERENCE
devolve a pendência, sem executar transição. O contrato HTTP da Etapa 4 está documentado
em docs/HTTP_API.md. Os testes de retomada usam somente harness interno, sem worker.

A exclusão conjunta de REFUND/ROLLBACK diretos recebeu aprovação explícita após revisão.
É uma restrição adicional ao item 7.4 do enunciado (unicidade por tipo), adotada para
impedir dupla compensação. ROLLBACK de REFUND continua permitido e não reabre a BET.

## Inbox/outbox — estruturas preparadas, workers futuros

Tabelas, índices, vínculos e proteção de identidade/finalização existem; runtime tem
somente SELECT nessas duas tabelas. Nenhum worker ou publicação é executado. As portas
da unidade de trabalho podem receber repositories dessas tabelas usando o mesmo contexto
transacional quando a mensageria for autorizada.

Planejamento futuro: inbox, transação, saldo, ledger e eventos no mesmo commit SQL.
Ack depois do commit; referência pendente retomada por worker do banco.

Outbox com claim `FOR UPDATE SKIP LOCKED`, lease e publicação fora da transação financeira.
Crash após envio pode duplicar publicação; eventId estável e consumidores idempotentes
protegem efeitos. A garantia será at-least-once, sem promessa de exactly-once.

## Identidade externa

Não implementar usuários/senhas próprios. O ponto de extensão futuro é uma porta
`ProviderIdentityPort` na Application, conectada a guard OIDC/JWKS na interface HTTP,
com validação de identidade e autorização do provider. A porta ainda não é um arquivo
vazio nem um guard que simula proteção. Health fica público. O canal SQS é interno,
mas os campos de provedor continuarão sujeitos à validação de domínio.

## Domínio implementado — Etapa 2

Money, Wallet, WagerTransaction, FinancialPolicy e WalletLedgerEntry são imutáveis;
transições retornam novas instâncias. IDs e instantes são fornecidos pelo chamador.
O domínio não consulta infraestrutura nem produz publicações.

Abertura zero tem versão 1 e ledger vazio; abertura positiva produz OPENING/CREDIT
com versão 1. Reversões rejeitadas não consomem o direito de reversão. REFUND e
ROLLBACK diretos da mesma BET são mutuamente exclusivos por política de segurança
adicional documentada. ROLLBACK de REFUND permanece permitido com validação de saldo.

Detalhes, matriz, códigos e contrato futuro de persistência/replay em
[docs/DOMAIN.md](docs/DOMAIN.md).

## Reconciliação e evidências — Etapa 3

`FinancialService.reconcile` consulta wallet/ledger/transações em READ ONLY REPEATABLE READ.
O diagnóstico puro reconstrói o saldo desde zero, considera OPENING e a exceção de abertura
zero, confere versões, equações, contextos, timestamps e efeitos das transações. Retorna
issues estruturadas, sem reparar saldo. Totais históricos usam bigint de centavos, podendo
exceder a faixa de Money sem perder precisão; saída monetária e contagens são strings.

Os cinco cenários A–E foram executados em PostgreSQL real, incluindo 50 duplicatas em
três processos/pools independentes, com um débito. Há testes reais de deadlock/retry,
timeout, snapshots concorrentes, permissões e falhas de integridade no commit.
Resultados e limitações em [VALIDATION.md](VALIDATION.md).

O [pacote de revisão](docs/stage-3/REVIEW.md) preserva a aprovação e o SQL original.
A implementação não modifica o domínio da Etapa 2. A validação usa bancos descartáveis;
o banco e os containers de desenvolvimento existentes não foram migrados/reiniciados.

## Evidências HTTP e preparação para a Etapa 5

Os E2E usam três processos Nest executando o JavaScript compilado, pools e conexões
PostgreSQL independentes, sem mocks financeiros. Validam 50 duplicatas HTTP com um
débito, disputa de saldo, chave global, reversões concorrentes, wallets independentes,
paginação estável sob inserção e replay de 80.00 com saldo atual de 130.00.

A unidade de trabalho passou a classificar falhas transitórias também em consultas.
Falha não classificada após conclusão do trabalho pode representar commit incerto:
retorna indisponibilidade e exige repetição da identidade, sem rejeição financeira ou
retry automático dessa situação desconhecida. Constraints permanecem erro de integridade.

Próxima etapa: implementar inbox/outbox na mesma unidade de trabalho, com grants de
escrita específicos; definir consumer/publisher, retries/DLQ e retomada de referências.
Testar crash após commit/antes do ack e publishers concorrentes. Autorização externa
do provider continua pendente. Esses fluxos exigem autorização própria e não estão
cobertos por promessa de entrega exactly-once. Nenhum deles foi antecipado nesta etapa.
