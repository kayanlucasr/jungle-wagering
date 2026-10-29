# Etapa 6 — plano para aprovação

Status: plano e DDL aprovados pelo usuário em 29/10/2026; implementação autorizada.
Este arquivo preserva a proposta revisada. As alterações não commitadas da Etapa 5 foram
preservadas. Resultados de execução estão em VALIDATION.md e docs/PENDING_REFERENCES.md.

## Verificação anterior às alterações

- Enunciado preservado, arquitetura, validações, política, estados, repositories, UoW,
  inbox, outbox, consumer e publisher conferidos.
- Etapas 3/4/5 têm implementação e evidências; migrations aprovadas 001/002/003 foram
  aplicadas e seus privilégios exercitados na regressão PostgreSQL real descartável.
- Build, typecheck e smoke compilado: aprovados nesta análise.
- Unitários: 172 pass, zero falhas, 1.531 assertions.
- Integração PostgreSQL/LocalStack: 71 pass, zero falhas, 996 assertions.
- Runner `jungle-financial-test-73e38332`: exit 0 e limpeza dos próprios containers/rede.
- O banco de desenvolvimento não foi migrado ou alterado por esses testes. Sua atualização
  operacional é separada da validação em ambiente descartável.

## Política proposta

O item 7.1 do enunciado exige REJECTED ao esgotar a espera por referência; não FAILED.
Usar o FailureCode existente REFERENCE_NOT_FOUND, reservado para expiração em DOMAIN.md.
O motivo operacional exato (TTL ou orçamento) estará nos logs/métricas; prazo, contador,
completed_at e snapshot persistidos permitem auditar a decisão.

Defaults propostos, configuráveis: TTL de 24h, 20 avaliações totais incluindo a primeira
submissão que gerou pendência, backoff base 1s/teto 300s com equal jitter, polling 1s e
lote de até 20 transações curtas por ciclo. O enunciado não fixa esses números. O limite
de avaliações pode encerrar antes das 24h; são dois limites independentes. Testes usam
relógio/jitter controlados e limites menores.

O deadline nasce na primeira transição para PENDING_REFERENCE e fica persistido/imutável,
inclusive depois de terminal. Alterar a configuração de TTL não estende pendências antigas.
Ao atingir o prazo, rejeitar sem movimento, mesmo que a referência fique disponível depois.
Antes do prazo, cada avaliação tenta a política financeira normal; se ainda pendente ao
atingir o orçamento, rejeitar. Uma referência terminal válida encontrada na última avaliação
pode ser processada; falha de infraestrutura faz rollback e não consome avaliação financeira.

Backfill proposto: pendências legadas recebem created_at + 24h, preservando next_attempt_at
existente e usando created_at quando nulo. Pendências antigas já vencidas poderão ser
rejeitadas após ativar o scheduler. A migration não altera seu status nem dados financeiros.

Referências são buscadas por (providerId, referenceExternalTransactionId). Uma transação
com o mesmo externalId em outro provider não é referência válida nem motivo para rejeição
imediata: o namespace correto continua ausente. Contexto/tipo/valor incompatíveis na
referência correta e referência REJECTED/FAILED são rejeitados pela FinancialPolicy atual.

## Claim e ordem exata dos locks

Cada tentativa usa uma chamada à FinancialUnitOfWork.write em READ COMMITTED:

1. Consultar wallets com uma pendência elegível por next_attempt_at ou deadline. Adquirir
   `FOR UPDATE OF w SKIP LOCKED` exclusivamente na wallet, com limite de uma wallet.
   O EXISTS em wager_transactions é leitura MVCC; não trava linhas de transação.
2. Com a wallet já travada, selecionar/reconsultar uma pendência elegível daquela wallet
   e adquirir o lock da transação. Revalidar status, tentativas, prazo e elegibilidade.
3. Consultar referência e histórico por leitura MVCC; reutilizar FinancialPolicy.process.
   Não adquirir uma segunda wallet para examinar referência incompatível.
4. Persistir decisão, saldo/versão/ledger quando aplicáveis, reagendamento ou conclusão e
   eventos outbox; commit único. Somente depois emitir o log de resultado confirmado.

SQL conceitual de claim (parâmetros vinculados, ainda não implementado):

```sql
SELECT w.id FROM wagering.wallets w
WHERE EXISTS (
  SELECT 1 FROM wagering.wager_transactions t
  WHERE t.wallet_id = w.id AND t.status = 'PENDING_REFERENCE'
    AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ? OR t.reference_deadline_at <= ?)
)
ORDER BY w.id
LIMIT 1 FOR UPDATE OF w SKIP LOCKED;
```

Essa ordem é wallet → transaction, igual à Etapa 3. O consumer toma inbox antes da wallet,
mas o scheduler não escreve/trava inbox; logo não cria a aresta wallet → inbox de um ciclo.
O publisher não solicita lock de wallet enquanto segura claim de outbox. Referência usa
leitura comum, sem inverter locks entre wallets; a unicidade SQL de reversões permanece.

Não há lease persistente novo: claim e tentativa são uma única transação curta e local,
sem polling, espera de timer ou rede SQS dentro dela. SIGKILL desfaz a tentativa e libera
locks; outra instância encontra a mesma pendência. Timeouts statement/lock existentes e
idle_in_transaction_session_timeout local limitam uma sessão abandonada. Polling/backoff
do worker ocorre fora da transação. Três workers podem trabalhar em wallets diferentes,
sem mutex global e sem manter transação aberta enquanto esperam referência.

## Mudança mínima de schema

DDL integral proposto em:

- [01-pending-reference-up.proposed.sql](01-pending-reference-up.proposed.sql)
- [02-pending-reference-down.proposed.sql](02-pending-reference-down.proposed.sql)

Acrescentar somente reference_deadline_at, constraint de consistência, trigger de
imutabilidade, índice parcial de prazos e grant UPDATE apenas da coluna nova. Reutilizar
processing_attempts, next_attempt_at, last_attempt_at e updated_at. Sem tabela de jobs,
novos estados, códigos financeiros, lease columns ou alterações dos SQLs aprovados.

Aplicar em janela com writers drenados/parados, pois o schema passa a exigir deadline
na transição para pendência e a versão antiga da aplicação não o preenche. Locks de DDL
seguem wallets → transactions; são administrativos. Down recusa apagar deadlines históricos.
Na preparação, a proposta ainda não havia sido executada nem validada pelo parser.
Na implementação, o PostgreSQL real apontou eventos de triggers diferidos após o backfill.
A migration os valida com SET CONSTRAINTS ALL IMMEDIATE e restaura ALL DEFERRED antes do
DDL seguinte, sem desativar constraints ou mudar o schema aprovado. Os SQLs propostos
originais abaixo permanecem inalterados como registro da aprovação.

## Integração e arquivos previstos

- FinancialService: extrair apenas a execução/persistência financeira comum para reutilizar
  em submit e resolução interna explícita. Replay HTTP/SQS continua sem iniciar avaliação.
- Portas, repositories e UoW: claim por wallet, leitura dos metadados e save com schedule;
  conclusão limpa next_attempt_at atomicamente, como já exige transactions_terminal_ck.
- Novo scheduler e entrypoint: processo separado, parâmetros validados, SIGTERM, logs e
  métricas de pendências, tentativas, resolução, expiração, falhas e duração até desfecho.
- Correlação: ler o contexto durável do primeiro WagerTransactionPendingReference na outbox.
  Pendência legada sem evento usa identificador de correlação determinístico documentado.
- Eventos: pending somente na entrada; Processed/Rejected e WalletBalanceChanged conforme
  decisão financeira no mesmo commit. Manter UNIQUE(transaction_id,event_type,event_version).
- Nova migration versionada, EntitySchema/mappers e testes necessários ao campo de prazo.
- environment.ts, .env.example, package.json, docker-compose.yml, workers/main.ts: configuração
  e serviço de scheduler escalável. Não alterar consumer/publisher além da composição necessária.
- Testes unitários, integração de referências, harness de processos, regressão financeira/HTTP/
  mensageria e atualização de README/DOMAIN/ARCHITECTURE/VALIDATION.

Áreas previstas: src/application/financial/, src/application/pending-reference/,
src/infrastructure/persistence/{repositories,entities,mappers,migrations}/,
src/infrastructure/config/, src/infrastructure/observability/, src/workers/ e test/.

## Critérios de aceite e riscos

Executar cenários A–K do pedido com PostgreSQL/LocalStack: REFUND antes de BET, ROLLBACK
antes de WIN, referência inválida/rejeitada, TTL/orçamento, três processos, SIGKILL antes
e após commit, replay histórico, reinício e exclusão REFUND/ROLLBACK já aprovada. Adicionar
crash após adquirir wallet, recuperação de sessão abandonada, independência entre wallets,
indisponibilidade PostgreSQL e conclusão financeira com LocalStack indisponível/outbox durável.
Reexecutar a regressão integral e reconciliar saldo/ledger nos casos financeiros.

Riscos: prazo legado possivelmente vencido, mudança de schema incompatível com writers
antigos, necessidade de limpar next_attempt_at ao terminalizar, disputa de wallets quentes,
cadeias/ciclos de referências aguardando até expiração e configuração de orçamento/TTL.
Falha de infraestrutura não gera rejeição de negócio por si só; durante indisponibilidade
do PostgreSQL não é possível persistir desfecho. TTL é avaliado assim que o banco volta.

Não avançar para Etapa 7; não alterar a política de reversões nem credenciais/dados financeiros
existentes. A autorização solicitada cobre este plano e o DDL apresentado; execução de
validação em banco descartável não implica migrar o banco de desenvolvimento.

Referências técnicas:
[SELECT/locking PostgreSQL 17](https://www.postgresql.org/docs/17/sql-select.html),
[timeouts de sessão](https://www.postgresql.org/docs/17/runtime-config-client.html).
