# Auditoria final — diagnóstico e escopo

Data: 29/10/2026, America/Sao_Paulo. Base Git:
`ba6c99791773f4349b2cd6c71247e10a0b6abc5c`. A árvore começou limpa, sem arquivos não
rastreados fora das exclusões. Três commits alcançáveis foram inspecionados: base
financeira, documentação e mensageria/validação distribuída. Nenhum commit foi criado.

## Antes das alterações

Enunciado original lido integralmente; árvore, package/lock, tsconfigs, README,
arquitetura, VALIDATION e documentos de domínio, HTTP, mensageria, pendências e revisões
de SQL conferidos. Foram inspecionados domínio financeiro, mappers/entidades,
repositories/UoW, controllers/DTOs, eventos, consumer, publisher, scheduler, entrypoints,
migrations e testes. A versão efetivamente instalada das 11 dependências diretas
coincidiu com package.json. As devDependencies também estão fixadas no lockfile.

Primeira execução desta auditoria, antes de alterar fonte/documentação: build/typecheck/
smoke passaram; 176 unitários e 101 integrações passaram. A integração criou o projeto
`jungle-financial-test-d8d95d00` e removeu seus containers/rede. Não foi confundida com
os números históricos da Etapa 7; a rodada final posterior está em TESTS.txt.

Estado principal consultado, sem alterações:

| Serviço | Identidade | Estado |
|---|---|---|
| app 1/2/3 | 1aa9828e8c00 / 8af5eec5ef94 / 6d98bce960b2 | Imagem stage1, running/unhealthy |
| PostgreSQL | 6430dcb2bcbd | Healthy, 17.11 |
| LocalStack | 77e00bd98876 | Healthy, 4.12.0; list-queues sem filas |
| migrate/queues antigos | 02bf9e36ec9f / 49df451eb960 | Exited |
| consumer/publisher/scheduler | Ausentes | Não implantados no principal |

O histórico do principal contém apenas Migration20261028000100. O código tem quatro
migrations; as suítes descartáveis aplicam todas e validam up/down/up. O diagnóstico
foi apresentado antes das mudanças localizadas. Não foi executado upgrade ou teste
financeiro no banco principal. A fundação/desenho da Etapa 0 está referenciada na
documentação/chat, sem artefato de execução separado que possa ser certificado.
Etapas 1–7 possuem implementações exercitadas, com as divergências de conformidade
da matriz; a implantação principal antiga não foi usada como prova de aprovação.

## Inspeção de arquitetura e contratos

- Domain não importa NestJS, ORM ou AWS. Application não importa Infrastructure.
  Controllers não fazem SQL/cálculo de saldo. FinancialService centraliza HTTP/SQS
  e a avaliação do scheduler. Repositories/UoW isolam a persistência.
- Pessimistic locking por wallet, MVCC de referências e SQL curto preservam a ordem
  de locks. Retry limitado não transforma infraestrutura em REJECTED. Há testes de
  deadlock, wallets independentes, falhas no commit e reconciliação.
- Money não usa number monetário; Decimal tem configuração privada e versões/somas
  históricas usam bigint. Conversões Number encontradas são operacionais/contagens.
- Reversões têm valor/contexto/tipo verificados. ROLLBACK de REFUND é permitido.
  A exclusão conjunta REFUND/ROLLBACK é mais restrita que a leitura por tipo;
  é risco de aceitação, não prova de duplicação financeira observada.
- LOSS/REJECTED não produzem ledger; LOSS produz evento Processed. Expiração de
  referência produz REJECTED/REFERENCE_NOT_FOUND; FAILED não é usado como timeout.
  Replays usam snapshot persistido. Eventos mínimos têm subclasses concretas.
- Inbox/Outbox preservam garantias por repositories/SQL, mas não a forma das duas
  classes/factories do esqueleto. A extensão de identidade da opção sem IdP não
  está ligada ao código. Ambos são explicitados na conformidade/propostas.
- Validações pequenas de transporte HTTP/SQS têm diferenças intencionais; o domínio
  continua sendo a fonte das invariantes. Não foi identificada necessidade comprovada
  de substituir camadas, introduzir novo broker ou refatorar por estética.
- Dependências diretas são usadas em fonte/build ou como peers do framework. rxjs
  é peer requerido pelo Nest, mesmo sem import direto do código do produto. Nenhuma
  dependência foi removida por uma busca superficial de imports.

## Segurança e configuração

.env está ignorado/não rastreado; os campos sensíveis inspecionados têm exemplos
locais sintéticos. .env.example e fixtures têm somente credenciais de desenvolvimento/
teste, sem promessa de uso seguro em produção. Busca por formatos comuns de tokens
AWS/GitHub/OpenAI/Slack e chaves privadas não encontrou candidatos nas três revisões
Git alcançáveis; configuração/histórico relevantes foram revisados sem exibir segredos.
Isso não é prova universal de ausência de segredo em qualquer formato/reflog externo.
Nenhum segredo real conhecido foi encontrado para rotação nesta auditoria.

Runtime financeiro recusa superuser/owner/membership administrativo e não acessa
histórico de migrations. Grants/triggers e suas negativas foram testados em PostgreSQL
real. Provisionamento é administrativo explícito e separado de migration/runtime;
o startup não executa DDL. Portas publicadas do principal são loopback; runners
descartáveis não publicam portas. Imagem final usa UID 1000, conferido nesta execução.

`bun audit --json` foi executado sem fix e retornou exit 1: Ajv 8.13.0 moderado e
Multer 2.4.0 alto. O alcance das dependências foi confirmado por bun why. Não há
configuração $data ou upload/fileFilter no projeto; a exposição específica não foi
reproduzida. Detalhes e fontes em [security-audit.json](security-audit.json) e
[REMEDIATION.md](REMEDIATION.md). Ferramentas, package.json e bun.lock não foram atualizados.

## Alterações autorizadas e limites

Somente documentação, relatórios, override de reprodução descartável e a opção de
destino de evidências nos dois runners foram alterados. O comportamento financeiro,
src/, migrations e os três Composes existentes ficaram intactos. A opção evita
substituir JSONs históricos da etapa 7; todas as novas evidências estão em stage-8.
A ausência de arquivo/execução não foi transformada em PASS de conformidade.

Nenhum arquivo existente foi removido. KEEP/IGNORE/REMOVE estão justificados em
CLEANUP.md, com logs individuais no CSV. O .gitignore já atende aos candidatos e
permaneceu inalterado. Não houve reset/clean, alteração de histórico, commit ou push.

## Reprodução da instalação final sem atingir o principal

A auditoria construiu a imagem test sem cache, instalando dependências frozen dentro
do Docker. O Dockerfile final/runtime e o Compose principal também foram executados
em outro projeto, com override só de isolamento: PostgreSQL tmpfs, banco novo,
nenhuma porta publicada e tag de imagem própria. O teste verificou três APIs live/
ready=200, UID não root e disputa 100.00/80.00/80.00 com saldo 20.00/reconciliação.
Os workers principais foram iniciados, mas não possuem healthcheck próprio nesse
Compose; saúde funcional/recuperação deles é provada pela suíte distribuída separada.

O override reproduzível é [compose-delivery.override.yml](compose-delivery.override.yml).
Exemplo PowerShell, em ambiente com Compose >=2.24.4 (suporte a !reset):

```powershell
$project = "jungle-delivery-review-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$compose = @('compose','--env-file','.env.example','-p',$project,
  '-f','docker-compose.yml','-f','docs/stage-8/compose-delivery.override.yml')
docker @compose up -d --build --wait --scale app=3 --scale consumer=3 --scale publisher=2 --scale pending-reference=3
docker @compose ps
docker @compose exec -T --index 1 app bun -e 'console.log((await fetch("http://127.0.0.1:3000/health/ready")).status)'
docker @compose exec -T --index 2 app bun -e 'console.log((await fetch("http://127.0.0.1:3000/health/ready")).status)'
docker @compose exec -T --index 3 app bun -e 'console.log((await fetch("http://127.0.0.1:3000/health/ready")).status)'
docker @compose down --remove-orphans
```

O smoke financeiro completo está descrito em delivery-smoke.json; os mesmos invariantes
são automatizados em test/distributed/scenarios.ts. Os comandos acima exigem somente
os arquivos do checkout e Docker, sem provisionamento manual de dados. Encerramento
depois da inspeção é obrigatório, inclusive se algum comando falhar. A tag de imagem
de revisão pode permanecer no Docker; nenhum volume principal deve ser removido.

Manifesto de fontes em source-hashes.json. Testes pós-ajuste, evidências de concorrência,
crash, métricas e critérios que bloqueiam entrega estão em FINAL_REVIEW.md e CONFORMANCE.md.
