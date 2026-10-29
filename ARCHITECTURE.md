# Arquitetura — Etapas 1 a 7

## Escopo e autorização

O enunciado oficial, originalmente lido em `C:/Users/Undead/Downloads/README.md`, está
preservado em [docs/CHALLENGE.md](docs/CHALLENGE.md). A Etapa 0 está registrada no chat.
O usuário autorizou a fundação na Etapa 1 e o domínio/testes na Etapa 2. Na Etapa 3,
aprovou o plano, revisou integralmente os três SQLs e autorizou explicitamente sua execução.

Há regras financeiras puras, persistência ACID, ledger protegido, idempotência persistente,
API REST e reconciliação estruturada. A Etapa 4 usa as camadas e proteções aprovadas na
Etapa 3, sem migrations ou novos privilégios. A Etapa 5 foi autorizada em 29/10/2026 e
acrescenta consumer FIFO, inbox, outbox e publisher separado. A Etapa 6 foi aprovada após
revisão de plano/DDL e acrescenta scheduler persistente de referências. Autenticação
externa continua fora do escopo. Detalhes em [docs/MESSAGING.md](docs/MESSAGING.md) e
[docs/PENDING_REFERENCES.md](docs/PENDING_REFERENCES.md).

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

Etapa 5: contadores por processo cobrem mensagens, duplicatas, falhas transitórias,
DLQ, publicações, duração acumulada e quantidade de operações; gauges mostram pendências,
eventos esgotados e idade do evento mais antigo. Snapshots JSON são emitidos a cada 10s.
Não há exporter/agregador externo ou medição de SLO.

## Infraestrutura implementada

Compose principal: PostgreSQL persistente, LocalStack, jobs one-shot de bootstrap/migrate/queues
e aplicação. Sem Docker socket montado no LocalStack: SQS não precisa dele.

Aplicação sem host port fixa por padrão. `--scale app=3` atribui portas dinâmicas,
sem `container_name`. Todos os processos compartilharão código e PostgreSQL;
entrypoints separados de consumer/publisher foram adicionados na Etapa 5 autorizada.

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

## Inbox/outbox — Etapa 5

As cinco tabelas financeiras permanecem. A migration nova `20261029000100` concede
INSERT e UPDATE apenas nas colunas operacionais de inbox/outbox, preservando as
restrições do ledger, identidades, snapshots e roles. Acrescenta `position` identity
na outbox, índice por aggregate/position e `last_error_code`. O trigger passa a aceitar
`WagerTransactionPendingReference` enquanto a transação está em PENDING_REFERENCE.
O down recusa registros de mensageria; não apaga eventos/diagnósticos para facilitar rollback.

FinancialSession agora contém repositories inbox/outbox ligados ao mesmo EntityManager.
FinancialService continua sendo o único processador usado pela API e pelo consumer.
Inbox é adquirido por `(consumerName,messageId)` antes dos locks financeiros; hash
incompatível é conflito. Novas operações criam eventos; replay não cria outro evento.
Inbox, transação, saldo, ledger e eventos têm um único commit. Commit incerto é
consultado em snapshot somente leitura antes de decidir por redelivery.

Outbox usa `FOR UPDATE SKIP LOCKED`, owner por processo, lease e fencing por owner/attempt.
Somente o evento não publicado mais antigo de cada wallet é elegível. Isso mantém
sequência entre publishers sem serializar wallets distintas. A sequência identity pode
ter lacunas por rollback; não é um contador financeiro. Publicação ocorre depois do commit
do claim, sem transação aberta durante a chamada SQS. Marcação exige confirmação de envio
e claim ainda vigente. Crash após envio permite republicação com o mesmo eventId.
O limite de tentativas deixa eventos esgotados duráveis e visíveis em métricas; bloqueia
a sequência daquela wallet até intervenção operacional. Não há descarte automático.

Consumer usa um receive por loop, com múltiplos loops configuráveis e grupos derivados
de walletId. Isso evita receber um batch da mesma wallet e ultrapassar uma mensagem que
falhou. Heartbeat renova visibilidade durante o processamento. Long polling tem timeout
de rede maior que a espera SQS; retries de mensagem são limitados, com backoff e jitter.
Mensagens inválidas não entram no FinancialService. Esgotadas, são copiadas à DLQ com
diagnóstico antes de remover a origem; redrive nativo cobre quedas antes dessa operação.
Rejeição de negócio confirmada recebe ACK, sem virar falha de infraestrutura.

SIGTERM/SIGINT abortam polling e aguardam operações em andamento. O entrypoint limita
drenagem por prazo; um processo morto recupera-se por rollback SQL, redelivery e leases.
Nenhuma garantia financeira depende desses hooks. Subscribers externos devem deduplicar
eventId persistentemente; o teste de projeção comprova esse padrão além da dedup do broker.

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

Etapa 5 implementou inbox/outbox, grants específicos, consumer/publisher e retries/DLQ,
com validação real de crashes e concorrência. A Etapa 6 implementou retomada de referências
com deadline persistido, TTL e orçamento de tentativas. Autorização externa do provider
permanece pendente. A garantia de transporte é at-least-once; a unicidade dos efeitos
financeiros permanece fundamentada no PostgreSQL.

## Scheduler de referências — Etapa 6

FinancialService.resolveNextPendingReference é a entrada interna explícita. Submit e
resolução compartilham evaluate/persistDecision e FinancialPolicy; nenhum segundo motor
foi criado. Replays nunca chamam o scheduler. Estados terminais continuam imutáveis.

O claim faz SELECT de wallet com EXISTS de pendência elegível e FOR UPDATE OF w SKIP LOCKED;
o EXISTS é leitura MVCC, sem lock da linha de transação. Só depois trava uma transação
pendente daquela wallet. Referência/histórico são consultas MVCC. Assim, wallet → transaction
permanece a ordem; referência de outra wallet não introduz uma segunda aquisição de wallet.
Scheduler não trava inbox; publisher não solicita wallet enquanto segura claim de outbox.

Claim, decisão, reagendamento/conclusão e outbox são uma única transação SQL curta, sem
rede SQS, polling ou espera por referência dentro dela. Não se acrescentou lease persistente:
rollback libera o claim. Statement/lock timeouts e idle_in_transaction_session_timeout
local protegem sessões abandonadas; o teste recupera mesmo com o processo antigo vivo.
Outra instância consulta o status persistido e nunca reexecuta uma transação terminal.

Migration 20261029000200 incorpora o DDL aprovado: reference_deadline_at, CHECK, trigger
de imutabilidade, índice parcial e UPDATE restrito da coluna nova. Backfill de pendências
legadas usa created_at + 24h, sem mudar status/saldo/ledger. Como o backfill dispara triggers
diferidos, a migration executa SET CONSTRAINTS ALL IMMEDIATE antes do DDL seguinte e restaura
ALL DEFERRED; não desativa proteções. É um ajuste de execução do DDL, sem mudança do schema
aprovado. O down recusa remover deadlines já preenchidos. Writers antigos devem ser drenados
antes do upgrade. Os SQLs propostos originais permanecem preservados em docs/stage-6/.

Novas pendências recebem prazo fixo na primeira transição e next_attempt_at. Defaults:
24h, 20 avaliações totais contando aceite inicial, base 1s/teto 300s com equal jitter,
polling 1s e lote de 20 transações independentes. Configuração de TTL nova não estende
prazos existentes. A resolução limpa next_attempt_at no mesmo UPDATE que terminaliza,
como exige transactions_terminal_ck. Em cada retry ainda pendente, somente metadados mudam;
o evento WagerTransactionPendingReference não é repetido. Ao concluir, Processed/Rejected
e, se houver ledger, WalletBalanceChanged entram na outbox no mesmo commit.

No deadline, REJECTED/REFERENCE_NOT_FOUND prevalece mesmo se a referência tiver chegado
depois. Antes do prazo, a última avaliação pode concluir uma referência válida; se continuar
ausente/pendente, rejeita por orçamento. Falha de infraestrutura faz rollback e não consome
tentativa financeira. A correlação vem do primeiro evento de pendência na outbox; legado
sem esse evento usa pending-<md5(transactionId)> como identificação determinística de fallback.

ReferenceScheduler e o entrypoint pending-reference são processos separados. O scheduler
depende de PostgreSQL e das migrations, sem acoplamento de disponibilidade ao SQS. Eventos
ficam duráveis até o publisher recuperar o broker. Logs incluem referência, prazo, próxima
tentativa, resultado confirmado, failure code e duração; métricas são locais ao processo.
Não há contador inventado de leases recuperados: sem leases persistidos, o rollback não
deixa um marcador distinguível de um claim nunca confirmado. A recuperação é demonstrada
pelos testes de crash/sessão abandonada. A Etapa 7 não foi iniciada.

## Validação distribuída e observabilidade — Etapa 7

Plano autorizado em 29/10/2026. O ambiente adicional em
`docker-compose.distributed-test.yml` usa três containers API, três consumers, dois
publishers e três schedulers, com PostgreSQL/tmpfs e LocalStack exclusivos. O runner
host controla SIGKILL/reinício sem montar Docker socket no teste e remove apenas o
projeto aleatório gerado. Não altera o Compose principal, migrations ou política.

Readiness agora consulta as cinco tabelas e as colunas operacionais essenciais, com
LIMIT 0, além das filas. Namespace sozinho não representa schema financeiro pronto.
Liveness permanece independente. Os probes dos workers no Compose de teste observam
startup/heartbeat do processo de produção, via supervisor exclusivo de testes.

FinancialMetrics pertence à infraestrutura e observa a UoW: status é contabilizado
após commit, com comparação do status anterior sob a transação existente. Replay,
reagendamento sem mudança de status e rollback não contam como novo efeito. OPENING
não é incluído nos contadores de comandos externos. Retry/deadlock/lock timeout e
conflitos de idempotência têm contadores específicos. A observação não participa de
qualquer decisão financeira nem tenta substituir a auditoria SQL. Commit incerto
pode não ser contabilizado no processo que perdeu a resposta.

APIs e workers emitem snapshots por processo a cada 10s. Publisher separa eventId do
messageId SQS; logs incluem operação, resultado, código de erro estável e duração
quando aplicáveis. application_name identifica a instância nas conexões PostgreSQL.
Sem exporter/serviço novo, endpoint de falha ou flag de crash em produção. Injeções
são adapters do harness usando o PostgreSQL real.

Resultados, hashes de fonte, contagens e limites em
[docs/stage-7/RESULT.md](docs/stage-7/RESULT.md). O parecer local não atualiza a
implantação principal nem certifica capacidade de produção. Etapa 8 não iniciada.
