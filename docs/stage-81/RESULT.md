# Remediação 8.1 — resultado, 29/10/2026

**Parecer: PRONTO COM RESSALVAS para entrega do desafio local.** As correções propostas
foram aprovadas pelo usuário após diagnóstico. Não há bloqueador P0/P1 conhecido
pendente no escopo definido. Não se afirma produção pronta, autenticação real ou
aceite externo de toda interpretação de negócio. O principal continua preservado.

## Remediações implementadas

| Achado | Decisão aprovada / implementação | Evidência |
|---|---|---|
| P1-02 | NoopProviderIdentityGuard registrado em AppModule e aplicado apenas aos controllers financeiros. Não autentica, não cria claims nem altera providerId. Health e SQS ficam fora do guard. | identity-extension.test.ts substitui a implementação para negar acesso e confere sete rotas financeiras/health; HTTP real e imagem final passaram |
| P1-01 | Manter a exclusão conjunta de reversões. A restrição implica a unicidade por tipo do item 7.4; o texto não exige expressamente aceitar ambos os tipos sobre a mesma BET e permite interpretações documentadas. | Policy/índice/migrations intactos; regressões de reversões e cenário D distribuído passaram |
| P2-01 | Overrides fixos Ajv 8.18.0/Multer 2.5.0, mantendo Nest 11.2.8 e MikroORM 6.6.17. | Lockfile, instalação frozen limpa, audit exit 0/{} e testes reais |
| P2-02 | InboxMessage/OutboxMessage com construtores privados, factories, rehydrate e transições imutáveis realmente usadas pelos repositories. | Seis testes de estado/imutabilidade e toda integração de inbox/outbox, publishers e crash |

Na política mantida, BET -10 + REFUND +10 volta a 100.00 partindo de 100.00; ROLLBACK
direto posterior da mesma BET é rejeitado. ROLLBACK do próprio REFUND continua permitido
e debita o crédito com validação de fundos. Não se trocou por unicidade independente
por tipo, que permitiria saldo 110.00 nessa sequência de compensações diretas.
A decisão interna não é apresentada como aceite do avaliador. A divergência de
interpretação é uma ressalva documentada, não uma violação financeira demonstrada.

## Integração e preservação da arquitetura

As classes novas ficam em domain/messaging, sem Nest, ORM ou SDK. Datas são defensivas,
payload é cópia JSON profundamente congelada e terminais recusam novas transições.
InboxRepository usa receive/rehydrate/markProcessed na transação SQL financeira. A
marcação usa relógio do PostgreSQL, preservando a relação processed_at >= received_at.

OutboxRepository usa enqueue; OutboxStore reidrata o claim válido e usa markPublished/
scheduleRetry para preparar os UPDATEs. Não há chamadas SQS sob lock financeiro.
O SELECT prévio de estado não é garantia de ownership: o UPDATE continua exigindo
owner, attempt, published_at nulo e lease vigente. Isso evita que um estado lido antes
de uma troca de owner sobrescreva o vencedor. Os testes de fencing/claims passaram.

Attempts continuam incrementados no claim SQL, inclusive se o processo morrer.
scheduleRetry não incrementa de novo. Não foram alterados backoff, teto, DLQ, ordem
de publicação, índice de reversão, política financeira, schema ou privilégios.

## Dependências

`bun why` confirmou Ajv 8.18.0 pela cadeia MikroORM migrations → Umzug → Rushstack e
Multer 2.5.0 por Nest platform-express. Overrides ultrapassam os ranges dos pais
(~8.13.0 e 2.4.0): é uma decisão explícita, validada nesta árvore, a revisar quando
os pais forem atualizados. Não houve migração de major dos frameworks.

Ajv passou a usar fast-uri; uri-js/punycode saíram da resolução. Nenhuma outra atualização
direta foi feita. O audit atual está em [security-audit.json](security-audit.json):
exit 0, zero advisories reportados no momento da consulta. Não é garantia permanente.
Os advisories originais e seus cenários permanecem registrados em stage-8.

## Execuções atuais e evidências

| Verificação | Resultado final |
|---|---|
| Build/typecheck/smoke | PASS; live 200, ready sem dependências 503, saída por sinal 143 |
| Unitários | 183 PASS, 0 FAIL, 1.589 assertions em 14 arquivos |
| Integração real PostgreSQL/LocalStack | 101 PASS, 0 FAIL, 1.304 assertions; 70,06s |
| Total distinto Bun test | **284 PASS, 0 FAIL, 2.893 assertions** |
| Distribuído | 11 cenários + seed assertivo + recovery + carga: 14 verificações PASS |
| Instalação limpa da imagem final | Frozen lockfile sem cache: 233 pacotes de build e 221 de produção; build PASS |
| Imagem runtime em ambiente descartável | Três APIs live/ready 200, UID 1000; abertura 201 e duas BET 80.00 sobre 100.00 deram 200/422, saldo 20.00, duas entradas e reconciliação consistente |
| Audit | PASS, exit 0, {} |
| Rechecagem isolada de startup | Duas execuções adicionais do cenário F passaram; não somadas ao total distinto |

Fontes: [TESTS.txt](TESTS.txt), [distributed-evidence.json](distributed-evidence.json),
[delivery-smoke.json](delivery-smoke.json), [clean-install.txt](clean-install.txt),
[startup-recheck.json](startup-recheck.json), [source-hashes.json](source-hashes.json).
Matriz final: [CONFORMANCE.md](CONFORMANCE.md), 48 PASS, zero FAIL/BLOCKED nos requisitos.

Projetos finais: integração `jungle-financial-test-24c8b476`, distribuído
`jungle-distributed-test-d2cafd86`, imagem final `jungle-stage81-delivery-919a3ecc` e
rechecagem `jungle-stage81-startup-e6ca6b59`. Os próprios containers/redes foram
removidos, sem down -v ou remoção de volumes do principal. Os arquivos de evidência
das etapas 7/8 foram preservados. O relatório anterior está arquivado em stage-8.

A carga embutida executou 94 HTTP + 24 envios SQS: 75 HTTP 200 incluindo replays,
19 rejeições financeiras esperadas, zero erro operacional e 57 transações externas
distintas. As 38 carteiras reconciliaram, 171 eventos foram publicados e a outbox
final ficou vazia. Observados 40,98 operações de transporte/s; HTTP p50/p95/p99 de
417,92/641,83/675,35ms. Lag amostrado antes da drenagem: 87 pendências, mais antiga
665,87ms. Não é pico, meta de desempenho ou capacidade de produção. Percentis usam
nearest-rank; throughput inclui transporte duplicado. O comando standalone de carga
não foi repetido nesta etapa; o mesmo cenário foi executado pelo runner distribuído.

SIGKILL nas fronteiras de consumer/publisher/scheduler foi revalidado na integração;
os 11 containers reais também foram mortos/reiniciados e recuperaram seis mensagens,
seis pendências e 18 eventos. Wallets, ledger e snapshots históricos reconciliaram.
O snapshot do contador de conflitos foi observado antes do crash intencional.

## Intercorrências — não omitidas

[INITIAL-FAILURES.json](INITIAL-FAILURES.json) preserva a rodada inicial:

- A integração teve 100 PASS/1 FAIL: um consumer saiu com código 1 antes de anunciar
  ready; o harness original não expôs stderr. Acrescentou-se diagnóstico de saída
  precoce. A causa original não foi estabelecida e não é atribuída às classes ou a
  corrupção financeira sem evidência. O cenário passou na regressão final completa
  e em duas repetições isoladas; a ocorrência permanece como limitação diagnóstica.
- O distribuído passou os cenários financeiros/carga, mas falhou a assertiva final
  do contador de conflitos: o SIGKILL aconteceu antes do snapshot periódico. Logs
  registraram os conflitos, mas só havia snapshots zero anteriores/depois do reset.
  O runner agora aguarda, com prazo, a observação do contador antes de matar as APIs.
  A exigência original foi mantida e o runner final passou.
- O primeiro typecheck apontou uma tupla de teste inferida como string indefinida;
  corrigida a tipagem antes do build/suites finais. O primeiro audit sem acesso de
  rede encontrou ConnectionRefused; a consulta autorizada posterior retornou {}.
- A rechecagem extra de startup foi inicialmente impedida por indisponibilidade da
  revisão automática de aprovação por limite de uso. Após o pedido de retomada, a
  mesma ação passou pela revisão e as duas execuções foram feitas; não se contornou
  a aprovação nem se tratou a indisponibilidade como teste aprovado.

## Arquivos e limites

Novos: guard, duas classes domain/messaging, dois arquivos de testes unitários e
docs/stage-81. Alterados: AppModule, controllers financeiros, message-repositories,
outbox-store, package.json/bun.lock, diagnóstico do harness messaging, barreira de
métricas do runner e documentação atual. Não foi criada migration, modificado
financial-policy.ts ou alterado Docker/Compose principal. Nenhum artefato foi excluído,
commit criado ou publicação realizada. A atualização de node_modules faz parte da
instalação aprovada dos patches; não é limpeza de dados/documentos do projeto.

Ressalvas: guard no-op não protege acesso, overrides fora dos ranges dos pais exigem
revisão futura, exclusão conjunta é interpretação explícita, e o principal antigo
permanece não atualizado. Métricas são voláteis, LocalStack não prova AWS real, a
carga é pequena e failover/restore/perda física de disco/IdP não foram testados.
Os limites não são apresentados como funcionalidades existentes.

Comandos reproduzíveis:

```text
bun install --frozen-lockfile
bun run test:build
bun test test/unit
bun run test:integration:docker
bun run test:distributed:docker --evidence-dir docs/stage-81
bun audit --json
```

O host principal não é necessário a esses testes. Não executar upgrade/limpeza nele
para reproduzir a entrega. Nenhuma etapa posterior, commit ou publicação é automática.
