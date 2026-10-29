# Etapa 3 — pacote para aprovação do schema financeiro

Estado em 28/10/2026: **DDL aprovado explicitamente após apresentação integral e parecer técnico**.
O usuário autorizou a execução. A Etapa 3 foi implementada e validada em PostgreSQL
descartável; ver [VALIDATION.md](../../VALIDATION.md). Os três arquivos `.proposed.sql`
preservam o conteúdo submetido à revisão, incluindo seus comentários históricos.
Nenhum deles é descoberto pelo Migrator: o SQL aprovado foi incorporado sem alterações
à migration oficial. As descrições abaixo registram o desenho aprovado. Mudanças materiais
posteriores continuam exigindo revisão; não houve avanço para a Etapa 4.

## Conteúdo e execução futura

1. [00-access.proposed.sql](00-access.proposed.sql): bootstrap administrativo de roles e
   propriedade, separado do histórico de migrations por ser configuração de cluster.
2. [01-financial-up.proposed.sql](01-financial-up.proposed.sql): SQL completo do up financeiro,
   incluindo cinco tabelas, três domains, índices, dez funções, triggers e grants.
3. [02-financial-down.proposed.sql](02-financial-down.proposed.sql): down sem CASCADE, que
   recusa tabelas com dados. Roles e propriedade não são removidos pelo down.

O namespace e a tabela pública de histórico MikroORM já são criados pela Etapa 1. O
bootstrap é executado depois dela. Em banco limpo, um job administrativo executará a
migration existente, provisionará acesso e entregará as próximas migrations ao login
restrito de migrations. Em banco existente, inspecionar propriedade, membros e ACLs antes
da transferência. Não apagar o volume existente. A futura configuração distinguirá
credenciais de administração/bootstrap, migrations e runtime.

O SQL up/down será incorporado à migration oficial MikroORM, preservando transação e
allOrNothing. Não haverá schema:update, DDL automático no startup nem execução destes
arquivos pela aplicação. Nenhum login, senha ou secret é incluído no pacote.

## Decisões submetidas à aprovação

| Tema | Decisão proposta |
|---|---|
| Identificadores | TEXT limitado a 256 caracteres, não vazio e sem whitespace nas extremidades; preserva IDs não UUID aceitos pelo domínio. |
| Dinheiro | Domain sobre NUMERIC sem typmod, não negativo, limitado a 999999999999999999.99, scale <= 2; bloqueia NaN, infinito, overflow e escala excedente sem arredondamento implícito. |
| Serialização | Driver e mapeador sempre string; entrada externa e saída com duas casas; bigint para versões, string no JSON. Nunca conversão monetária para number. |
| Moeda | Código SQL com três letras maiúsculas, compatibilidade financeira validada no banco; pertença à lista Intl do Bun fixado continua no Money. Não há conversão cambial nem cadastro adicional. |
| Timestamps | TIMESTAMPTZ(3), finitos; precisão de milissegundos alinhada ao Date e snapshot ISO UTC do domínio. |
| Wallet | Identidade imutável, UNIQUE(player_id,currency), versão inicial 1, incremento exatamente um por mudança de saldo; timestamp preservado em no-op. |
| Abertura zero | Saldo zero, versão 1, sem OPENING/ledger. Primeiro movimento usa versão 2 e before zero. |
| Abertura positiva | OPENING PROCESSED e CREDIT na versão 1, before zero, timestamps de criação iguais, mesmo commit. Identidade externa/chave/hash ficam NULL somente no OPENING interno. |
| Reversão | Uma única REFUND **ou** ROLLBACK direta PROCESSED por referência; rejeições/falhas não consomem o direito. ROLLBACK de REFUND permitido, sem reabrir a BET original. |
| Referência | Provider/external ID/player/wallet/currency/round iguais; game não precisa coincidir. REFUND referencia BET; ROLLBACK referencia BET/WIN/REFUND. As demais operações com referência exigem BET, conforme a política atual. |
| Referência inválida | Comando fica auditável como REJECTED, sem ledger; somente PROCESSED exige referência interna válida e contexto financeiro coincidente. |
| Player/moeda inválidos | Transação preserva player/moeda recebidos; FK simples para wallet permite registrar rejeição. PROCESSED exige coincidência com wallet; ledger tem FKs compostas para moeda/wallet/transação. |
| Wallet inexistente | Não persistir transação sem wallet: erro explícito WALLET_NOT_FOUND, sem efeito. A FK não admite órfãos. |
| Resultado terminal | Colunas tipadas e JSONB versionado, com igualdade exata validada pelo trigger; snapshot usa saldo/versão da wallet sob lock na conclusão. |
| Terminais | PROCESSED/REJECTED/FAILED integralmente imutáveis, inclusive no-op UPDATE, timestamps, snapshot e metadados. Sem DELETE. |
| Ledger | INSERT/SELECT; nenhum UPDATE/DELETE/TRUNCATE. Constraints e validações diferidas garantem direção, equação, sequência e correspondência wallet/transação/ledger. |
| Inbox/outbox | Estrutura, índices, identidade e estado final protegidos; runtime tem somente SELECT nesta etapa. Nenhum worker, evento obrigatório, publicação ou claim implementado. |
| Down | Somente banco descartável com opt-in; recusa tabelas não vazias. Reversibilidade estrutural não autoriza perda de histórico financeiro. |

Money no domínio admite versões bigint arbitrárias; PostgreSQL BIGINT limita a versão
a 9223372036854775807. A Application rejeitará avanço além desse limite antes da escrita,
e o banco rejeitará overflow. Não alterar o domínio por antecipação.

O banco protege a **semântica numérica**; não consegue recuperar a representação original
de uma expressão SQL já convertida/arredondada pelo próprio cliente. Notação científica,
formato canônico, lista de moedas e hash são validados antes da persistência. O domain
monetário verifica o valor entregue ao banco; não se promete identificar cast explícito
malicioso feito por um cliente autorizado.

## Garantia transacional e ordem das operações

Uma unidade de trabalho corresponde a uma wallet e uma operação. Cada chamada usa fork
e transação MikroORM próprios em READ COMMITTED. Nenhuma chamada de rede sob lock.

1. Validar formato do comando e calcular hash canônico antes de abrir a transação.
2. Consultar identidades externa/chave para detectar replay e conflito. Essa consulta
   inicial é indicativa; não fornece exclusão mútua.
3. Adquirir SELECT FOR UPDATE na wallet indicada. Reconsultar identidades e estado
   persistido após adquirir o lock. Não reaplicar instância PENDING recebida do chamador.
4. Inserir o comando PENDING se novo, com ON CONFLICT DO NOTHING sem alvo específico.
   Se nenhuma linha foi inserida, consultar ambas as identidades novamente em novo
   statement e classificar replay/conflito. Não capturar unique violation e continuar
   usando uma transação SQL abortada.
5. Consultar referência e histórico de reversões sob o lock da wallet. Referências
   financeiramente elegíveis pertencem à mesma wallet. Referência de outra wallet é lida
   para rejeitar contexto, sem adquirir o lock da outra wallet.
6. Executar FinancialPolicy sobre estado atual. Persistir wallet alterada, transação
   concluída e ledger, nessa ordem. LOSS e rejeições não atualizam saldo/versão.
7. Commit: constraint triggers conferem os vínculos finais. Falha em qualquer ponto,
   inclusive no commit, reverte o conjunto inteiro.

A ordem de locks é **wallet → transação atual**; referência terminal é imutável e lida
sem FOR UPDATE. As constraints e o índice único de reversões complementam o histórico
consultado. Um futuro worker deve descobrir candidatos sem manter lock de transação
enquanto aguarda wallet. Um futuro lote multiwallet deve ordenar wallets por ID antes
de travar qualquer transação; lotes assim não serão implementados na Etapa 3.

Triggers de transação e inserção do ledger também adquirem lock na wallet como defesa
para SQL direto. Um cliente que ignore a ordem e faça UPDATE na transação primeiro pode
provocar deadlock; PostgreSQL aborta um participante, sem aceitar efeito parcial. O
adapter usará a ordem definida e retry limitado de transação inteira para 40P01/40001
(até três tentativas, nova transação e reconsulta completa). Lock timeout não é rejeição
financeira nem FAILED permanente: retorna indisponibilidade transitória. Commit incerto
exige repetição da mesma identidade, nunca compensação automática.

Os triggers diferidos verificam cada mudança de wallet com seu lançamento específico,
cada transação financeira com seu ledger, e cada lançamento com predecessor e snapshot.
Nenhuma escrita posterior pode editar/apagar um predecessor. A exceção sem predecessor é
versão 2/before zero de uma abertura zero. A validação normal usa índices por identidade
e versão, sem varrer o ledger inteiro. A reconciliação completa é uma consulta separada.

O trigger de snapshot observa wallet atual sob lock; assim, rejeições/LOSS não recebem
saldo obsoleto. O JSON exige strings monetárias, versão em string, timestamp UTC e
ausência de propriedades adicionais ou opcionais nulas. Snapshot não é resposta HTTP;
corpo/status/headers HTTP ficam para a etapa de API.

## Idempotência e estados pendentes

Hash v1: SHA-256 UTF-8 do JSON de um array com ordem fixa:

```text
[1, providerId, externalTransactionId, walletId, playerId, currency,
 roundId, gameId, kind, amountComDuasCasas, referenceExternalTransactionIdOuNull]
```

Sem trim ou case folding de IDs; campos inexistentes de referência viram null. Exclui
idempotencyKey (comparada separadamente), IDs internos, timestamps, correlationId,
tentativas e envelope de transporte. Hash persistido é imutável e versionado. O SQL
valida formato do hash; a Application recalcula e nunca aceita hash fornecido pelo cliente.

| Situação encontrada no banco | Resultado da Application proposta |
|---|---|
| Nenhuma identidade existe | Criar e tentar processar atomicamente. |
| Mesma chave e provider/external ID, mesmo hash | Reutilizar o mesmo registro; terminal retorna snapshot original. |
| Mesma chave com outra identidade ou hash | Conflito explícito, sem nova movimentação. |
| Mesmo provider/external ID com outra chave ou hash | Conflito explícito; não criar alias de chave. |
| Chave e identidade externa apontam para registros distintos | Conflito explícito, sem escolher arbitrariamente um registro. |
| Mesmo registro PENDING | Retornar identidade e estado persistidos, sem inventar resultado terminal nem aplicar novamente pelo caminho de replay. |
| Mesmo registro PENDING_REFERENCE | Retornar a pendência persistida, mesmo se a referência chegou depois; retomada será operação interna explícita futura. |

Uma submissão nova normalmente termina como PROCESSED/REJECTED ou PENDING_REFERENCE no
mesmo commit. PENDING permanece suportado para aceite durável futuro. Retomada de
pendências não será acionada por duplicata e não haverá worker nesta etapa. O contrato
da Application distingue replay terminal, aceite pendente e conflito; nenhum status HTTP
é definido agora. Falha antes do commit deixa a mesma identidade livre para retry.

## Privilégios e fronteira operacional

`wagering_owner` e `wagering_runtime` são grupos NOLOGIN separados. Os logins reais serão
provisionados pelo administrador com secrets. Runtime não pode ser superuser, proprietário,
membro do owner nem herdar grupos privilegiados. A configuração atual, que compartilha
credenciais PostgreSQL de owner, deve ser substituída antes de habilitar operações financeiras.

Runtime recebe SELECT/INSERT nas três tabelas financeiras e UPDATE apenas nas colunas
de saldo ou transição explicitamente listadas. Não recebe UPDATE no ledger, DELETE,
TRUNCATE, CREATE, TRIGGER nem acesso ao histórico MikroORM. Funções são SECURITY INVOKER,
com objetos qualificados e search_path fixo. O único helper diretamente concedido apenas
valida um ledger existente. Inbox/outbox só recebem SELECT por enquanto.

Triggers também bloqueiam UPDATE/DELETE/TRUNCATE para evitar que um grant acidental
simples libere mutação. O proprietário/superuser pode administrar triggers/DDL; não há
promessa de proteção contra administrador malicioso. Runtime não terá esses poderes.
Não criar política de retenção/purga financeira nesta etapa.

## Reconciliação proposta

Consultar wallet e ledger ordenado por versão em uma transação READ ONLY REPEATABLE READ,
obtendo um snapshot consistente sem bloquear o processamento. Reconstruir a partir de
zero, incluindo OPENING quando existente. Validar unicidade, sequência, moedas, equação,
before/after, referência da transação, último saldo e versão da wallet. Ausência de versão
1 só é válida quando o primeiro lançamento é versão 2/before zero; ledger vazio exige
saldo zero e versão 1.

Retorno estruturado: walletId, currency, consistent, storedBalance, reconstructedBalance,
storedVersion, lastLedgerVersion, entryCount, totalCredits, totalDebits e issues com
código, entryId/versão quando aplicáveis. Valores/versões/contagens são strings. Totais
acumulados podem exceder o limite de uma wallet: somar em bigint de centavos (sem number)
e formatar como decimal string; não aplicar o limite de Money aos totais históricos.
Relatar lacunas, equações inválidas, contexto incompatível e diferenças, sem reparar nada.

## Plano de validação após aprovação do DDL

Executar contra PostgreSQL 17 real, em Compose descartável com projeto aleatório. Usar
login runtime real para os testes de permissões, e owner separado para migrations e
tentativas de SQL inválido. Falhas diferidas são verificadas no COMMIT; não basta testar
se INSERT/UPDATE isolado lançou erro. Não desativar constraints/triggers nos testes normais.

| Grupo | Evidência exigida |
|---|---|
| Migrations | Banco limpo: Etapa 1/bootstrap/up/down/up; catálogo, ACLs, índices, funções e triggers presentes; down com dados recusado e dados intactos. |
| Valores | Negativo, NaN, +/-Infinity, overflow e 1.001/1.005 recusados; máximo e centavos exatos preservados; driver devolve string. |
| Wallet | Duplicidade player/moeda recusada; identidade imutável; versão não avança em no-op; avanço sem saldo/ledger ou com salto recusado. |
| Ledger | UPDATE/DELETE/TRUNCATE recusados como runtime; triggers também recusam owner sem desativação; moeda/direção/equação/predecessor/timestamp inválidos recusados. |
| Atomicidade | Wallet sem ledger, ledger sem efeito de wallet, PROCESSED sem ledger, ledger para PENDING/LOSS/REJECTED/FAILED e lançamento extra recusados no commit. |
| Transações | Identidade externa/chave únicas; terminal inteiro imutável; transição para PENDING recusada após PENDING_REFERENCE; snapshot adulterado recusado. |
| Referências | Contexto/status/tipo/valor inválidos recusados como PROCESSED; rejeição auditável aceita; reversão cruzada e do mesmo tipo duplicadas recusadas; ROLLBACK de REFUND aceito uma vez. |
| Inbox/outbox | Catálogo/índices e runtime somente leitura; owner verifica identidade imutável, hash, vínculo e snapshot publicado/processado; nenhum worker/publicação executado. |
| Reconciliação | Abertura zero/positiva, BET/WIN/LOSS/reversões e rejeições; leitura consistente sob escrita concorrente; algoritmo reporta fixtures com lacuna/equação/moeda/saldo/versão divergentes. |
| A: disputa | Saldo 100.00, duas BET 80.00: uma PROCESSED, outra REJECTED/INSUFFICIENT_FUNDS, saldo 20.00, um débito. |
| B: 50 duplicatas | 50 chamadas, pelo menos três processos e conexões independentes: mesmo snapshot terminal, um registro e um débito; zero conflito de integridade sem tratamento. |
| C: wallets distintas | Manter lock explícito na wallet A; operação em B deve concluir enquanto A aguarda. Verificar saldos/ledgers separados, sem depender só de medição de latência. |
| D: falha | Injetar erro após UPDATE da wallet e antes do ledger: rollback de saldo, versão, transação nova e ledger. Retry válido aplica uma única vez. |
| E: reversões | Disparar REFUND e ROLLBACK sobre a mesma BET: uma compensação, outra rejeitada, índice único e ledger consistentes. |
| Conflito global | Mesma chave em wallets distintas, hashes distintos, identities cruzadas e duplicata após saldo posterior: conflito ou replay original, nunca segundo efeito. |
| Falhas transitórias | Deadlock/timeout/commit incerto não vira rejeição financeira; retry inteiro com mesma identidade preserva efeito único. |

Fixtures inválidas do algoritmo de reconciliação são testes unitários de diagnóstico;
o banco protegido não deve aceitar produzir tais estados. A integração deve comprovar
que tentativas equivalentes de gravação falham, além de reconciliar históricos reais.
Não desativar triggers em um banco existente para simular corrupção.

## Verificações feitas na preparação, antes da autorização

- Enunciado, domínio, arquitetura, migrations, configuração e testes existentes inspecionados.
- Suite existente reexecutada na análise: 146 aprovados, zero falhas, 1.281 assertions.
- Typecheck existente aprovado, exit 0.
- SQL revisado estaticamente; **não executado, não validado por parser PostgreSQL**.
- Nenhum teste de concorrência, constraint ou migration financeira executado.

A aprovação autorizará implementar e validar o pacote, não certificará que ele já passou
nos testes. Falhas encontradas devem ser corrigidas; qualquer mudança de política,
privilégio ou garantia será reapresentada para revisão antes da migration correspondente.

## Referências técnicas consultadas

- [NUMERIC no PostgreSQL 17](https://www.postgresql.org/docs/17/datatype-numeric.html):
  exatidão, limites, valores especiais e arredondamento por typmod.
- [Constraint triggers](https://www.postgresql.org/docs/17/sql-createtrigger.html):
  checagens diferidas até o fim da transação.
- [Locks explícitos](https://www.postgresql.org/docs/17/explicit-locking.html):
  locks por linha e duração até commit/rollback.
- [Isolamento](https://www.postgresql.org/docs/17/transaction-iso.html):
  READ COMMITTED no processamento e snapshot REPEATABLE READ na reconciliação.
- [Funções](https://www.postgresql.org/docs/17/sql-createfunction.html):
  SECURITY INVOKER, search_path e permissões.
