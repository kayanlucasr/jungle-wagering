# Domínio financeiro — Etapa 2 (com integração de persistência na Etapa 3)

Nota de estado: o domínio descrito aqui foi preservado sem alterações na Etapa 3.
As referências abaixo a persistência futura e aprovação pendente registram as condições
da entrega da Etapa 2. O DDL recebeu aprovação explícita posterior e a persistência foi
implementada; ver [ARCHITECTURE.md](../ARCHITECTURE.md) e [VALIDATION.md](../VALIDATION.md).

## Escopo e limites

Implementados Money, Wallet, WagerTransaction, FinancialPolicy, WalletLedgerEntry e
erros tipados. São classes sem dependências de NestJS, MikroORM, PostgreSQL ou AWS.
A única biblioteca externa do domínio é decimal.js.

Não há processamento operacional persistente, endpoint financeiro, consumer, publisher,
worker, autenticação ou controle de concorrência distribuída. Nenhuma tabela/migration
financeira foi criada ou modificada. O schema continua aguardando aprovação separada.

O enunciado original está preservado em [CHALLENGE.md](CHALLENGE.md).

## Valores exatos e imutabilidade

`Money.from` é a factory de entrada não negativa. Exige string decimal canônica com
exatamente duas casas: `0.00`, `25.00`. Rejeita number, expoente, NaN, infinito, espaços,
vírgula, sinal positivo, zeros à esquerda e escala diferente de dois, sem arredondar.
`Money.signed` admite sinal negativo para deltas e reconciliação; normaliza `-0.00`
para `0.00`. `rehydrate` reconstrói essa representação assinada.

Uma configuração privada de Decimal com precisão 64 executa soma, subtração e inversão;
não herda mudanças de configuração do construtor Decimal global. A faixa é simétrica
até `999999999999999999.99`, compatível com o numeric(20,2) proposto. Resultado fora
da faixa é erro explícito. As operações disponíveis nessa faixa não exigem arredondamento.

A instância guarda apenas a representação canônica privada; nenhum objeto Decimal
mutável é exposto. Objetos e MoneyProps serializados são congelados. Moedas são os
códigos disponibilizados por `Intl.supportedValuesOf('currency')` no runtime Bun fixado;
não há conversão cambial. BRL e USD são exercitados nos testes. A escala do exercício
permanece dois, inclusive para moedas cuja unidade real use outra escala.

Wallet, WagerTransaction e ledger também são imutáveis. Métodos de transição retornam
novas instâncias; o chamador deve usar o retorno. Datas são guardadas como strings ISO
e devolvidas por cópia. Tentativas inválidas deixam os objetos de entrada intactos.
Versões são bigint no domínio e strings no snapshot JSON, sem conversão insegura.

## Abertura e cadeia do ledger

O ponto de entrada para produzir o conjunto completo é `FinancialPolicy.openWallet`.
`Wallet.open` é a factory do estado do agregado, não uma operação de persistência.

| Abertura | Wallet | Transação interna | Ledger |
|---|---|---|---|
| `0.00` | Saldo zero, versão 1 | Nenhuma | Nenhum |
| Positiva | Saldo inicial, versão 1 | OPENING/PROCESSED | CREDIT de zero ao saldo inicial, versão 1 |

Para saldo zero, a soma vazia de CREDIT menos DEBIT é `0.00`, portanto a reconciliação
é consistente sem lançamento fictício. A primeira movimentação real ocupa versão 2.

Na abertura positiva, OPENING é parte da criação e não incrementa a versão para 2.
IDs da transação e do ledger são fornecidos pelo chamador. OPENING não é aceito pela
factory externa de WagerTransaction.

`Wallet.credit/debit` retornam `{ wallet, ledgerEntry }`. Toda mudança efetiva gera
um lançamento com versão resultante, direção, valor positivo e saldos anterior/posterior.
Movimento de zero é um no-op sem lançamento, mudança de versão ou timestamp. Isso não
autoriza BET/WIN/reversões de valor zero: suas factories exigem valor positivo.

Reconstrução: iniciar em `Money.zero(currency)` e somar cada `entry.delta`.
O fixture de testes verifica também a continuidade before/after, versão e ausência de
transações duplicadas na sequência. Esses checks de teste não são garantias distribuídas.

## Estados

| Origem | Destinos |
|---|---|
| PENDING | PENDING_REFERENCE, PROCESSED, REJECTED, FAILED |
| PENDING_REFERENCE | PROCESSED, REJECTED, FAILED; permanecer aguardando é no-op |
| PROCESSED / REJECTED / FAILED | Nenhum |

Não existe transição de volta a PENDING. `markPendingReference` exige referência
externa informada. Processamento com referência exige também o ID interno resolvido.
Factories rehydrate fazem reconstrução estrutural, sem executar transições ou movimentos.

LOSS é PROCESSED sem ledger ou alteração da wallet. Transação REJECTED ou FAILED
também não gera lançamento. Falhas de programação/estado inválido são DomainError;
rejeições de negócio retornam nova transação REJECTED com failureCode e snapshot.
Referência ausente ou não terminal deixa PENDING_REFERENCE. Na Etapa 6, o scheduler
reavalia com backoff e prazo persistido; TTL/orçamento esgotado gera REJECTED com
REFERENCE_NOT_FOUND, sem ledger. FAILED permanece disponível no domínio para falha
permanente aprovada, mas não é usado para expiração ou indisponibilidade transitória.

## Política adicional de segurança para reversões

**Política aprovada provisoriamente pelo usuário:** uma única reversão direta PROCESSED
por referência, considerando REFUND e ROLLBACK conjuntamente. Rejeições e falhas não
consomem esse direito. Uma nova tentativa válida precisa ser uma operação distinta;
uma transação já REJECTED permanece terminal.

### Compatibilidade com o enunciado

A seção 7 exige uma reversão por referência/tipo, e a tabela descreve reversões
"uma única vez". Ela não especifica expressamente a exclusão entre tipos sobre a mesma BET.
A leitura literal por tipo poderia permitir dois créditos compensatórios para o mesmo débito.
A regra implementada é uma restrição adicional, mais forte que a unicidade por tipo:
preserva essa unicidade e evita dupla compensação econômica. Não é apresentada como
uma proibição literal inequívoca do README. Trata-se de interpretação documentada e
aprovada provisoriamente; a aceitação pelo avaliador ainda pode exigir esclarecimento.

O ROLLBACK de REFUND é expressamente permitido pelo item 7.3 do enunciado e permanece
permitido aqui. Ele debita o crédito do reembolso; não constitui outro crédito da BET.

### Matriz implementada

Todas as referências devem coincidir em provider, external ID informado, player, wallet,
moeda e rodada. gameId não é obrigado a coincidir pelo enunciado. Autorreferência é inválida.
Em reversões, o valor deve coincidir integralmente. WIN com referência pode ter outro valor.

| Referência / condição | REFUND | ROLLBACK |
|---|---|---|
| BET PROCESSED sem reversão | CREDIT | CREDIT |
| BET com REFUND PROCESSED | Rejeitar | Rejeitar |
| BET com ROLLBACK PROCESSED | Rejeitar | Rejeitar |
| WIN PROCESSED sem reversão | Rejeitar | DEBIT, sujeito a saldo |
| REFUND PROCESSED sem reversão | Rejeitar | DEBIT, sujeito a saldo |
| LOSS | Rejeitar | Rejeitar |
| ROLLBACK | Rejeitar | Rejeitar |
| OPENING interno | Rejeitar | Rejeitar |
| Ausente | PENDING_REFERENCE | PENDING_REFERENCE |
| PENDING/PENDING_REFERENCE elegível | PENDING_REFERENCE | PENDING_REFERENCE |
| REJECTED/FAILED | Rejeitar | Rejeitar |
| Contexto/valor incompatível | Rejeitar | Rejeitar |

Reverter um REFUND não libera o direito de reverter diretamente a BET original novamente.
Esse direito depende do histórico de reversões processadas, não do efeito líquido atual.
Exemplo: BET -10, REFUND +10, ROLLBACK do REFUND -10 → saldo líquido -10;
uma nova reversão direta da BET continua bloqueada.

`FinancialPolicy.process` recebe o histórico relevante completo como dado, além da
referência resolvida. Considera somente reversões PROCESSED contra a referência.
Não consulta banco nem mantém cache/registro global. Na futura aplicação, esse histórico
deverá ser carregado sob lock da wallet e protegido também por constraints.

## Falhas estáveis

As classes usam DomainError com FailureCode enum, independente de códigos HTTP.

| Situação | Código |
|---|---|
| Entrada monetária inválida | INVALID_AMOUNT |
| Overflow monetário | AMOUNT_OUT_OF_RANGE |
| Moedas incompatíveis | CURRENCY_MISMATCH |
| BET sem saldo | INSUFFICIENT_FUNDS |
| Reversão causaria saldo negativo | REVERSAL_INSUFFICIENT_FUNDS |
| Transição de terminal / estado inválido | INVALID_TRANSACTION_STATE |
| Contexto da referência incompatível | REFERENCE_CONTEXT_MISMATCH |
| Kind de referência inelegível | REFERENCE_KIND_NOT_ALLOWED |
| Valor da reversão diferente | REFERENCE_AMOUNT_MISMATCH |
| Referência terminal sem sucesso | REFERENCE_NOT_PROCESSED |
| Referência já revertida | REFERENCE_ALREADY_REVERSED |
| Referência obrigatória/autorref inválida | INVALID_REFERENCE |
| Wallet ausente/incompatível com ID solicitado | WALLET_NOT_FOUND |
| Wallet de outro player | WALLET_PLAYER_MISMATCH |

Mantidos os nomes específicos da Etapa 0 para saldo de reversão e duplicidade, em vez
de introduzir sinônimos concorrentes. REFERENCE_NOT_FOUND identifica expiração ou
esgotamento de referência na Etapa 6. Antes desses limites, a referência permanece pendente.

## Resultado terminal e futuro replay persistente

Implementado no domínio: `TerminalResult`, congelado e JSON-safe, contendo:

- transactionId e status terminal;
- balance como MoneyProps, com moeda e string de duas casas;
- walletVersion como string;
- referenceTransactionId quando resolvido no processamento;
- failureCode quando rejeitada/falha;
- completedAt como string ISO-8601.

O saldo é o observado na conclusão, incluindo rejeições. Em rejeição por moeda, registra
a moeda real da wallet observada, não atribui artificialmente a moeda inválida do comando.
`toState/rehydrate` preservam esse snapshot. Movimentações posteriores da wallet não
alteram o resultado anterior. Nenhum snapshot contém Date mutável ou bigint não serializável.

**Especificação para a etapa de persistência, ainda não implementada/aprovada:**

1. Gravar estado terminal, snapshot, saldo materializado, ledger e eventos no mesmo commit;
   incluir inbox quando aplicável. Nenhuma resposta de sucesso antes desse commit.
2. Armazenar o snapshot como JSONB, com versão explícita do formato no contrato persistido;
   os campos monetários continuarão strings. O estado e o snapshot devem corresponder.
3. A futura camada Application/HTTP persistirá também o corpo/código de resposta escolhido
   para replay, sem incluir metadados variáveis como correlationId. Domínio não define HTTP.
4. Identidade externa e chave de idempotência terão unicidade no banco; payload divergente
   será conflito. Não há implementação dessa funcionalidade nesta etapa.
5. Replay terminal usará exclusivamente o resultado original persistido, sem recalcular saldo
   a partir da wallet atual. `idempotentReplay` será metadado de transporte.
6. Antes de conclusão, ainda não há resultado terminal. O contrato HTTP de replay de um
   aceite inicialmente pendente deverá ser fechado na etapa de Application/HTTP; não se
   presume que a aprovação desta política de reversões aprovou esse contrato.
7. Trigger BEFORE UPDATE impedirá qualquer alteração de registro terminal, incluindo snapshot,
   identidade e timestamps. DELETE e privilégios de runtime também precisam ser restringidos.
8. Uma perda de conexão com commit incerto exigirá repetição da mesma identidade; nunca
   compensação automática ou reaplicação de um snapshot PENDING obsoleto.

As novas instâncias imutáveis não fornecem, isoladamente, idempotência persistente. Executar
duas vezes o mesmo estado PENDING antigo pode produzir duas decisões iguais; o futuro
Unit of Work deve carregar o estado atual sob lock e confirmar uma única operação.

## Condição obrigatória antes de migrations financeiras

Apresentar para revisão e nova autorização o SQL completo, incluindo corpos das funções,
constraints, índices, triggers e permissões, além de plano de up/down e testes negativos:

- unicidade player/moeda, identidade externa e chave de idempotência;
- exclusão de reversões efetivas por referência, atravessando os dois tipos;
- referência elegível e contexto/valor iguais;
- imutabilidade de ledger, inclusive bloqueio de TRUNCATE para runtime;
- proteção de identidade e de todas as transições/estados terminais e seus snapshots;
- não negatividade, finitude, escala e limites de valores;
- correspondência diferida entre transação PROCESSED, lançamento e wallet;
- cadeia before/after/versão, incluindo exceções de abertura zero e positiva;
- ausência de ledger em LOSS, REJECTED e FAILED;
- incremento de versão apenas quando o saldo muda;
- atomicidade com inbox/outbox quando esses fluxos forem autorizados;
- usuário runtime separado do proprietário das migrations.

O DDL-base anterior não substitui essa revisão completa. Nenhuma migration financeira
será criada ou executada sem nova aprovação.
