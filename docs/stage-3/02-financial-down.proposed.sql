-- PROPOSTA PARA APROVACAO. NAO EXECUTADO. NAO E UMA MIGRATION.
-- Executar futuramente em transacao pelo Migrator como wagering_owner,
-- apenas com o opt-in e banco descartavel exigidos pelo runner.
-- Nao apagar dados para viabilizar rollback: down recusa qualquer tabela nao vazia.
-- Trava antes da consulta de vazio: evita escrita concorrente entre consulta e DROP.
LOCK TABLE wagering.wallets, wagering.wager_transactions, wagering.wallet_ledger_entries,
  wagering.inbox_messages, wagering.outbox_messages IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wagering.wallets)
    OR EXISTS (SELECT 1 FROM wagering.wager_transactions)
    OR EXISTS (SELECT 1 FROM wagering.wallet_ledger_entries)
    OR EXISTS (SELECT 1 FROM wagering.inbox_messages)
    OR EXISTS (SELECT 1 FROM wagering.outbox_messages) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'financial_down_requires_empty_tables';
  END IF;
END;
$$;

-- DROP TABLE remove seus indices e triggers, nunca objetos externos por CASCADE.
DROP TABLE wagering.outbox_messages RESTRICT;
DROP TABLE wagering.inbox_messages RESTRICT;
DROP TABLE wagering.wallet_ledger_entries RESTRICT;
DROP TABLE wagering.wager_transactions RESTRICT;
DROP TABLE wagering.wallets RESTRICT;

DROP FUNCTION wagering.check_message_reference() RESTRICT;
DROP FUNCTION wagering.guard_message_update() RESTRICT;
DROP FUNCTION wagering.check_ledger_effect() RESTRICT;
DROP FUNCTION wagering.check_transaction_effect() RESTRICT;
DROP FUNCTION wagering.check_wallet_change() RESTRICT;
DROP FUNCTION wagering.check_ledger_entry(text) RESTRICT;
DROP FUNCTION wagering.guard_ledger_insert() RESTRICT;
DROP FUNCTION wagering.guard_transaction() RESTRICT;
DROP FUNCTION wagering.guard_wallet() RESTRICT;
DROP FUNCTION wagering.deny_mutation() RESTRICT;

DROP DOMAIN wagering.money_amount RESTRICT;
DROP DOMAIN wagering.currency_code RESTRICT;
DROP DOMAIN wagering.identifier RESTRICT;
-- Preserva namespace wagering, historico MikroORM, propriedade e roles.
-- A migration da Etapa 1 continua responsavel por seu proprio namespace.
