# Achados e propostas — auditoria final

Proposta histórica. Após aprovação, a implementação e as decisões estão em
[stage-81/RESULT.md](../stage-81/RESULT.md); este registro não descreve pendências atuais.

Estado: propostas para decisão; nenhum novo DDL, regra financeira, guard ou upgrade
de dependência foi implementado. A auditoria/documentação é concluível com pendências;
o parecer da entrega é separado da aprovação dos testes funcionais existentes.

## P1-01 — interpretação de reversões por referência e tipo

O item 7.4 proíbe repetir reversão pelo mesmo tipo. A implementação proíbe também
tipos diferentes contra a mesma referência: FinancialPolicy.validateReference aceita
qualquer prior REFUND/ROLLBACK processada como impedimento, e
transactions_one_reversal_uq indexa somente reference_transaction_id. Essa decisão
foi aprovada internamente e documentada; não se presume que o avaliador a tenha aceito.

Reprodução atual: BET 10.00 sobre 100.00 → 90.00; REFUND da BET → 100.00; ROLLBACK
direto da mesma BET → REJECTED/REFERENCE_ALREADY_REVERSED. A sequência inversa também
bloqueia o segundo tipo. Os testes financeiros E, SQL uniqueness, HTTP concurrency,
pending K e o cenário D distribuído comprovam o comportamento. A unicidade por tipo
está satisfeita; o risco é a restrição adicional de aceitação, não duplicação financeira
reproduzida. Não se chama automaticamente toda segunda compensação de duplicata de
transporte: são operações distintas cuja semântica precisa ser decidida.

Opções para aprovação:

1. **Manter a política atual e obter aceite explícito dessa interpretação.** Sem
   alteração de saldo/schema. A restrição permanece destacada no README/apresentação;
   sem aceite do avaliador, o risco de conformidade continua pendente.
2. **Adotar a leitura de uma reversão por tipo.** Trocar a verificação de histórico
   por igualdade de kind e substituir o índice parcial por unicidade em
   `(reference_transaction_id, kind)` para PROCESSED/REFUND/ROLLBACK. Nessa política,
   BET -10 + REFUND +10 + ROLLBACK direto da BET +10 termina em **110.00**, com dois
   créditos compensatórios de identidades/tipos diferentes. Esse efeito econômico
   precisa de aprovação consciente; não será introduzido como correção automática.

Na opção 2, seriam alterados financial-policy.ts, uma **nova** migration e regressões
unitárias, financeiras, HTTP, mensageria, pending e distributed; migrations antigas
e terminais históricos permanecem imutáveis. A aplicação e o índice precisam mudar
juntos, com writers drenados. Up pode criar o novo índice e remover o antigo dentro
do mesmo commit, pois o histórico atual é mais restrito. Down precisa bloquear e
recusar caso já existam dois tipos processados contra a mesma referência; jamais
apagar/editar histórico para restaurar a restrição. O SQL completo e os testes de
up/down devem ser revisados antes de executar. Rejeições antigas não serão reabertas.
ROLLBACK de REFUND continua permitido, debitando seu crédito; ele não é outro crédito
direto da BET. Saldo não negativo, valor integral e contexto permanecem obrigatórios.

## P1-02 — ponto de extensão de identidade ausente no código

A seção 2 aceita não integrar IdP, mas exige documentar o desenho **e** deixar uma
extensão explícita no código. Existe o desenho OIDC/JWKS na arquitetura; busca em
src confirmou ausência de guard/ProviderIdentityPort e de conexão na composição.
Isso é falha de conformidade condicional, não prova de autenticação existente.

Proposta mínima: um guard no-op nomeado/documentado como modo local sem autenticação,
registrado em AppModule e aplicado somente aos controllers financeiros. canActivate
retornaria true; não criaria identidade confiável, claims, usuários ou autorização.
Health permaneceria público e o caminho SQS continuaria interno. É um ponto concreto
para substituir por OIDC/JWKS, sem afirmar proteção que não existe.

Arquivos candidatos: novo guard em interfaces/http, AppModule, WalletsController,
TransactionsController e testes do escopo do guard. Validar acesso local inalterado,
health público, nenhuma mutação de body/provider e build/integrações. Não instalar
Keycloak, Zitadel, SDK ou pacote de autenticação apenas para cumprir esse requisito.
Por alterar a composição/fronteira de identidade, a proposta aguarda aprovação.

## P2-01 — avisos de dependências transitivas

`bun audit --json`, executado em 29/10/2026, retornou exit 1 e dois avisos:

| Dependência instalada | Aviso / severidade do advisory | Correção publicada |
|---|---|---|
| ajv 8.13.0, via MikroORM migrations → umzug → rushstack | [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6), moderado, ReDoS com $data | 8.18.0 na linha 8 |
| multer 2.4.0, via @nestjs/platform-express 11.2.8 | [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m), alto, DoS com fileFilter assíncrono | 2.5.0 |

Não foram encontrados uso de Ajv/$data, rotas/interceptors de upload ou fileFilter
no projeto. Isso reduz a exposição demonstrada por inspeção, mas não prova ausência
de exploração em todos os caminhos. P2 é a prioridade local da remediação sem caminho
exposto identificado; **não** reclassifica a severidade alta do advisory de Multer.

Proposta: selecionar versões dos pais compatíveis com os patches e revisar ranges/
lockfile; alternativamente, avaliar override explícito com regressões. Rushstack
solicita ~8.13.0 e Nest fixa multer 2.4.0, portanto reinstalar o lockfile atual não
resolve. Não usar audit fix/latest automaticamente. Após autorização, repetir audit,
instalação frozen em imagem limpa, build, unitários, integração e distribuídos.

## P2-02 — diferença de modelagem Inbox/Outbox

Há repositories SQL com receive/complete e claim/published/retry, estado protegido
no banco e testes reais de atomicidade/recuperação. Não existem as classes de domínio
InboxMessage/OutboxMessage com factories/transições do esqueleto 6.5. A seção 6 permite
adaptar nomes/assinaturas, mas enfatiza encapsulamento. A equivalência dessa adaptação
é registrada como risco de modelagem, não como ausência das garantias transacionais.
Se for exigida a forma das classes, propor integração mínima dos estados com os
repositories, sem segundo motor financeiro ou duplicação de regras SQL. Não criar
abstrações vazias apenas para fazer uma busca por nome passar.

## P2 corrigidos nesta auditoria

- README/arquitetura e documentação HTTP/domínio estavam misturando planos históricos
  com componentes já implementados; foram sincronizados e as limitações mantidas.
- O runner distribuído gravava sempre em docs/stage-7, substituindo evidência histórica
  ao revalidar. A opção --evidence-dir permite guardar a execução final em docs/stage-8;
  o comando de carga repassa a opção. Destino fora da workspace é recusado. O caminho
  padrão foi preservado. As suítes reais foram repetidas após essa mudança localizada.

## Limpeza e autorização

Inventário em [CLEANUP.md](CLEANUP.md) e cleanup-inventory.csv. REMOVE significa
candidato tecnicamente descartável, não exclusão autorizada/executada. Nenhum arquivo,
volume principal, migration, fixture ou documento foi removido. O .gitignore já cobre
os artefatos locais identificados. Não há necessidade comprovada de ampliar suas regras.
