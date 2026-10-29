-- PROPOSTA PARA APROVACAO. NAO EXECUTADO. NAO REGISTRADO NO MIGRATOR.
-- Parar writers antes de executar. Runner continua restrito a banco descartavel de teste.
LOCK TABLE wagering.wallets IN ACCESS EXCLUSIVE MODE;
LOCK TABLE wagering.wager_transactions IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wagering.wager_transactions WHERE reference_deadline_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'pending_reference_down_would_erase_deadline_history';
  END IF;
END $$;

REVOKE UPDATE (reference_deadline_at) ON wagering.wager_transactions FROM wagering_runtime;
DROP TRIGGER transactions_reference_deadline_guard ON wagering.wager_transactions;
DROP FUNCTION wagering.guard_reference_deadline() RESTRICT;
DROP INDEX wagering.transactions_reference_deadline_idx;
ALTER TABLE wagering.wager_transactions DROP CONSTRAINT transactions_reference_deadline_ck;
ALTER TABLE wagering.wager_transactions DROP COLUMN reference_deadline_at RESTRICT;
