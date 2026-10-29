# Plano submetido à aprovação — conclusão da Etapa 7

Estado: **aprovado pelo usuário em 29/10/2026 e implementado**. A proposta original
abaixo é preservada; execução e limites em [RESULT.md](RESULT.md), auditoria inicial
em [AUDIT.md](AUDIT.md).
O pedido exige aprovação antes de mudanças estruturais/infraestrutura, migrations,
privilégios ou políticas financeiras. O plano não prevê novos DDL, grants ou regras.

## 1. Ambiente descartável distribuído — impacto médio

Criar `docker-compose.distributed-test.yml` e `scripts/distributed-test-docker.ts`,
reutilizando Dockerfile, jobs e configuração existentes. Projeto aleatório exclusivo,
PostgreSQL tmpfs e LocalStack próprios, nomes de bancos de teste, sem bind de dados,
sem portas fixas ou volumes compartilhados. Não usar o Compose principal nem seu .env
como destino de teste. Credenciais sintéticas e roles separadas como na suíte atual.

Três serviços API independentes, três consumers, dois publishers e três schedulers,
com instance IDs e pools próprios. Executar bootstrap/migrations existentes apenas
no banco descartável; inicializar as quatro filas FIFO. Probes de API e verificações
dos workers devem distinguir processo vivo, dependências e progresso. Reinícios de
teste serão explícitos; falha transitória de readiness não causará restart em loop.
Remoção somente do projeto gerado, sem down -v. Registrar IDs de containers e conexões.

## 2. Matriz de cenários e falhas — impacto baixo em produção

Adicionar testes em `test/distributed/` e harness em `test/support/`, aproveitando
fixtures e portas atuais. Repetir A–E via APIs distintas, 50 duplicatas e variações
de chave/payload/wallet; conferir SQL e reconciliação. Acrescentar os seis pontos de
falha com interceptação somente no harness. A desconexão próxima ao commit deve
registrar resultado desconhecido e consultar identidade/inbox antes de retry.

Coordenar SIGKILL reais e barreiras após commit/antes de ACK, após send/antes de
marcação e durante claim; verificar expiração/recuperação. Repetir com backlog e
reinício conjunto dos papéis. Deduplicação do subscriber deve ser persistente e
verificada mesmo quando a deduplicação do broker é contornada no teste. Não incluir
flags de falha acessíveis pela API de produção. Qualquer nova necessidade estrutural
ou mudança de contrato/DDL será reapresentada antes da alteração.

## 3. Correções localizadas e observabilidade — impacto baixo a médio

Reproduzir com regressões específicas o probe de schema parcial e os campos/contadores
ausentes. Arquivos candidatos: `database.service.ts`, `json-logger.ts`, `http-metrics.ts`,
`transactions.controller.ts`, `exception.filter.ts`, `transaction-consumer.ts`,
`outbox-publisher.ts`, `financial-unit-of-work.ts`, composição em `app.module.ts` e
`workers/main.ts`. Usar contadores/snapshots existentes, sem serviço ou dependência nova.

Cobrir transações por status, conflito de idempotência, duplicatas, retries e conflitos
de lock, falhas transitórias, outbox depth/lag, referências e duração. Diferenciar
tentativa, replay e efeito financeiro confirmado para evitar contagem enganosa.
Logs incluirão operation/result/errorCode e IDs aplicáveis (eventId distinto de
messageId), sem payload completo ou credenciais. Preservar liveness independente.
Probe financeiro deve recusar schema incompleto com permissões runtime existentes.

## 4. Carga e relatório — impacto baixo

Criar runner `scripts/load-test.ts`, comando `bun run test:load` e fixture de carga
no ambiente distribuído. Misturar wallets independentes, wallet disputada, duplicatas,
SQS e outbox, com volume pequeno fixado/documentado e reconciliação final. Registrar
total e denominadores, sucesso/rejeições/erros, p50/p95/p99 por canal, duração de parede,
throughput e lag observado. Definir método de percentil e distinguir latência HTTP
de conclusão assíncrona. Não impor meta arbitrária nem inferir capacidade de produção.

Atualizar package.json, README, ARCHITECTURE, VALIDATION e documentos/evidências stage-7.
Executar build/typecheck, unitários, integração existente e nova suíte distribuída.
Preservar resultados FAIL/BLOCKED/NOT_TESTED; só aprovar a etapa com todos os critérios
do pedido demonstrados. Não avançar para a Etapa 8 nem atualizar o principal.

## Aprovação solicitada

Autorizar a criação e execução do ambiente distribuído descartável e a implementação
incremental descrita acima. A autorização não inclui migrar desenvolvimento, mudar
políticas financeiras, acrescentar privilégios ou criar novas migrations.
