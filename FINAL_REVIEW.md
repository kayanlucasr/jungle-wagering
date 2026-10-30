# Revisão final de entrega — Jungle Wagering

**Etapa 8.1 — 29/10/2026. Parecer: PRONTO COM RESSALVAS.**

## A. Resumo executivo

As remediações aprovadas foram implementadas e validadas. O ponto de extensão de
identidade está ligado ao HTTP; Inbox/Outbox têm classes e factories usadas pela
persistência; Ajv/Multer foram corrigidos por overrides controlados. A exclusão
conjunta de REFUND/ROLLBACK foi mantida conforme a decisão aprovada, sem alteração
de regra financeira, migration ou privilégio.

A classificação anterior NÃO PRONTO correspondia à auditoria antes da remediação.
O relatório original foi preservado em
[FINAL_REVIEW-HISTORICAL.txt](docs/stage-8/FINAL_REVIEW-HISTORICAL.txt).
A conclusão atual usa novas execuções e não transforma falhas iniciais em aprovação.

## B. Stack validada

Bun 1.4.4, TypeScript 5.9.3 strict, NestJS 11.2.8, MikroORM 6.6.17, PostgreSQL
17.11-alpine, LocalStack 4.12.0, AWS SDK SQS 3.1159.0 e decimal.js 10.6.0. Docker
29.9.2/Compose v5.6.1. Frameworks mantidos; overrides fixam Ajv 8.18.0 e Multer 2.5.0.

Instalação frozen em Docker sem cache: 233 pacotes de build e 221 de produção.
A imagem final iniciou três APIs com UID 1000, live/ready 200 e smoke financeiro
consistente. Nenhuma instalação de ferramenta global ou upgrade do principal foi feito.

## C. Conformidade e remediação

[Matriz atual](docs/stage-81/CONFORMANCE.md): **48 PASS, zero FAIL/BLOCKED** nos
requisitos do enunciado. Não há bloqueador P0/P1 conhecido pendente no escopo aprovado.
As diferenças de interpretação e os limites operacionais continuam explícitos.

| Achado | Resultado |
|---|---|
| P1-02 | NoopProviderIdentityGuard registrado em AppModule e aplicado somente a WalletsController/TransactionsController. Teste de composição verifica sete rotas financeiras e health independente. Não autentica nem cria identidade confiável. |
| P1-01 | Exclusão conjunta mantida por aprovação. Ela satisfaz a proibição de repetição pelo mesmo tipo; o texto não exige expressamente aceitar ambos os tipos contra a mesma BET e permite interpretações documentadas. Restrição adicional destacada ao avaliador, sem alegar aceite externo. |
| P2-01 | Ajv 8.18.0/Multer 2.5.0 resolvidos pelo lockfile; audit exit 0, {}. Overrides fora dos ranges dos pais foram aprovados e precisam ser reavaliados futuramente. |
| P2-02 | InboxMessage/OutboxMessage com construtores privados, factories, rehydrate, datas defensivas, payload imutável e transições usadas pelos repositories. Garantias concorrentes permanecem no SQL. |

A conclusão anterior de incompatibilidade financeira inequívoca foi qualificada:
um limite de uma reversão total também impede duas do mesmo tipo. A questão é a
restrição adicional de aceitação, não um débito/crédito duplicado comprovado. Manter
a regra foi a opção aprovada; ROLLBACK de REFUND continua possível, sujeito a fundos.

## D. Testes executados nesta etapa

| Verificação final | Resultado |
|---|---|
| Build/typecheck/smoke compilado | PASS; live 200, ready sem dependências 503, término por sinal 143 |
| Unitários | 183 PASS, 0 FAIL, 1.589 assertions em 14 arquivos |
| Integração PostgreSQL/LocalStack | 101 PASS, 0 FAIL, 1.304 assertions em 5 arquivos; 70,06s |
| Total distinto Bun test | **284 PASS, 0 FAIL, 2.893 assertions** |
| Runner distribuído | 11 cenários + seed assertivo + recovery + carga: 14 verificações PASS |
| Instalação/imagem final | Frozen lockfile limpo e três APIs não root aprovados |
| Audit das dependências | PASS, exit 0, sem advisories reportados na consulta |
| Rechecagem adicional do startup | Cenário F repetido isoladamente duas vezes com sucesso; repetições não somadas ao total distinto |

Detalhes: [TESTS.txt](docs/stage-81/TESTS.txt),
[RESULT.md](docs/stage-81/RESULT.md), [clean-install.txt](docs/stage-81/clean-install.txt),
[security-audit.json](docs/stage-81/security-audit.json) e
[source-hashes.json](docs/stage-81/source-hashes.json).
As 277 aprovações da etapa anterior permanecem históricas; estes são novos resultados.

## E. Correção financeira

Dinheiro exato, saldo não negativo, identidade/chave únicas, versões coerentes,
OPENING interno, LOSS/rejeições sem ledger, ledger append-only e terminais imutáveis
foram revalidados. Replay mantém snapshot após movimentos, resolução de pendência e
restart. O algoritmo de reconciliação confirma históricos e diagnostica fixtures
sem reparar dados silenciosamente ou desativar triggers em banco existente.

Seis falhas transacionais conferiram rollback de inbox/financeiro/ledger/outbox.
A desconexão antes de commit e a resposta perdida depois de commit real foram
tratadas com consulta da identidade antes de retry. Nenhuma exceção foi assumida
como prova de rollback e nenhuma compensação automática foi acrescentada.

## F. Concorrência e carga

Três APIs com conexões próprias e três consumers, dois publishers e três schedulers
foram testados. A–E passaram: disputa de duas BET 80.00 sobre 100.00 deixou 20.00,
50 duplicatas tiveram um débito, outra wallet avançou sob lock real, reversões
concorrentes não duplicaram compensação e reversão sem fundos foi rejeitada.

Carga local: 118 operações de transporte (94 HTTP e 24 envios SQS), 19 rejeições
financeiras esperadas, zero erro operacional, 38 carteiras reconciliadas, 171 eventos
publicados e outbox final vazia. Observados 40,98 operações/s; HTTP p50/p95/p99 de
417,92/641,83/675,35ms. Percentis nearest-rank e números completos estão no JSON.
Não são SLA, meta de RPS ou declaração de capacidade de produção. O cenário de carga
foi executado dentro do runner; o comando standalone não foi repetido na Etapa 8.1.

## G. Mensageria, recuperação e diagnóstico

Inbox/Outbox são classes efetivamente integradas, sem retirar as garantias SQL.
Claim incrementa tentativas, inclusive em crash; scheduleRetry não conta de novo.
A leitura prévia à transição não substitui os predicados de owner/attempt/lease
vigente no UPDATE. Não há rede sob transação financeira.

FIFO, redelivery, ACK após commit, publishers concorrentes, leases/fencing, retry,
DLQ e subscriber idempotente passaram. SIGKILL por fronteira foi revalidado; 11
containers reais encerrados com saída 137 recuperaram seis mensagens, seis pendências
e 18 eventos, sem dupla movimentação ou perda do snapshot histórico.

Duas ocorrências iniciais não foram ocultadas:

- Um consumer saiu antes do ready: rodada inicial 100 PASS/1 FAIL. O harness passou
  a expor saída precoce. A causa original não foi estabelecida; o caso passou na
  regressão completa final e em duas rechecagens isoladas.
- O contador periódico de conflitos não tinha sido observado antes do SIGKILL,
  apesar dos conflitos nos logs e dos cenários financeiros aprovados. O runner
  agora espera o snapshot com prazo antes do crash, sem enfraquecer a assertiva.

Registro: [INITIAL-FAILURES.json](docs/stage-81/INITIAL-FAILURES.json).
[distributed-evidence.json](docs/stage-81/distributed-evidence.json) confirma a barreira,
os resultados finais e a limpeza. A checagem extra de startup foi inicialmente
impedida por indisponibilidade da revisão automática por limite de uso; após retomada,
foi aprovada e executada, conforme [startup-recheck.json](docs/stage-81/startup-recheck.json).

## H. Arquivos e Git

Novos: src/domain/messaging/inbox-message.ts, outbox-message.ts,
src/interfaces/http/noop-provider-identity.guard.ts, dois arquivos unitários e docs/stage-81.
Alterados: AppModule/controllers, message-repositories, outbox-store, package.json/
bun.lock, diagnóstico do teste de messaging, barreira do runner e documentação atual.
O [relatório detalhado](docs/stage-81/RESULT.md) explica o impacto.

Não foram modificados financial-policy.ts, migrations, privilégios, os Composes
existentes ou .env. Evidências das etapas anteriores foram preservadas. Não houve
limpeza de artefatos, exclusão de documentos, commit, reset/clean, push ou publicação.
As alterações de node_modules fazem parte da atualização de dependências aprovada.
A seleção de entrega deve continuar excluindo .env, node_modules, dist, .tools e logs.

## I. Ressalvas e reprodução

- Guard no-op é extensão, não autenticação/autorização. Uso local, sem IdP integrado.
- A interpretação de reversões está aprovada internamente, mas não se presume aceite
  externo. As duas compensações diretas por tipos diferentes permanecem proibidas.
- Overrides ultrapassam ranges dos pais; reavaliar ao atualizar frameworks e repetir audit.
- A falha isolada original de startup não teve causa confirmada e permanece registrada;
  não foi reproduzida na rodada final e nas rechecagens.
- O ambiente principal continua antigo e não foi atualizado. Não demonstrá-lo como
  a versão final; usar checkout/build ou ambientes descartáveis documentados.
- LocalStack/carga pequena não certificam AWS real, HA, restore, disco ou produção.
  Métricas são voláteis por processo e não substituem o ledger. Não há exporter/IdP/SLA.

```text
bun install --frozen-lockfile
bun run test:build
bun test test/unit
bun run test:integration:docker
bun run test:distributed:docker --evidence-dir docs/stage-81
bun audit --json
```

Para iniciar a aplicação em máquina limpa, seguir README. Para revisão isolada da
imagem final, o override de docs/stage-8/AUDIT.md mantém portas/volume principal fora
do teste. Depois de qualquer mudança posterior em código, schema ou lockfile, repetir
validações e atualizar evidências. Nenhuma nova etapa ou publicação é automática.

Sugestão de commit, sem executá-lo:

```text
fix: conclui remediações de identidade e mensageria e corrige dependências
```

## J. Parecer final

**PRONTO COM RESSALVAS para apresentação e entrega do desafio local**, com as decisões
aprovadas explicitadas. As lacunas técnicas de identidade/modelagem e os advisories
identificados foram tratados; os cenários atuais passaram. A conclusão não equivale
a produção pronta, segurança universal ou aprovação antecipada do avaliador.
