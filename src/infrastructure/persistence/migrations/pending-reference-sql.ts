// Approved Stage 6 proposal preserved verbatim; executed only by the registered migration.
export const pendingReferenceUp = String.raw`-- PROPOSTA PARA APROVACAO. NAO EXECUTADO. NAO REGISTRADO NO MIGRATOR.
-- PostgreSQL 17, wagering_owner, uma unica transacao.
-- Manutencao: parar previamente os writers HTTP/consumer/scheduler e aguardar drenagem.
-- Os locks abaixo sao somente de migration, nunca do processamento financeiro.
LOCK TABLE wagering.wallets IN ACCESS EXCLUSIVE MODE;
LOCK TABLE wagering.wager_transactions IN ACCESS EXCLUSIVE MODE;

ALTER TABLE wagering.wager_transactions
  ADD COLUMN reference_deadline_at timestamptz(3);

-- Somente metadados operacionais: nenhum status, saldo, versao, ledger ou snapshot muda.
-- Pendencias legadas recebem TTL de 24h desde created_at. Prazos ja vencidos serao
-- tratados pelo scheduler quando ativado, nunca por esta migration.
UPDATE wagering.wager_transactions
SET reference_deadline_at = created_at + interval '24 hours',
    next_attempt_at = coalesce(next_attempt_at, created_at)
WHERE status = 'PENDING_REFERENCE';

ALTER TABLE wagering.wager_transactions
  ADD CONSTRAINT transactions_reference_deadline_ck CHECK (
    (reference_deadline_at IS NULL OR
      (isfinite(reference_deadline_at)
       AND reference_deadline_at >= created_at
       AND reference_external_transaction_id IS NOT NULL))
    AND (status <> 'PENDING_REFERENCE' OR reference_deadline_at IS NOT NULL)
  );

CREATE FUNCTION wagering.guard_reference_deadline() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.reference_deadline_at IS NOT NULL
    AND NEW.reference_deadline_at IS DISTINCT FROM OLD.reference_deadline_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable_reference_deadline';
  END IF;
  IF OLD.reference_deadline_at IS NULL AND NEW.reference_deadline_at IS NOT NULL
    AND NOT (OLD.status = 'PENDING' AND NEW.status = 'PENDING_REFERENCE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deadline_requires_initial_pending_reference';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_reference_deadline_guard
BEFORE UPDATE OF reference_deadline_at ON wagering.wager_transactions
FOR EACH ROW EXECUTE FUNCTION wagering.guard_reference_deadline();

-- O indice existente por next_attempt_at permanece; este cobre TTL antes do proximo retry.
CREATE INDEX transactions_reference_deadline_idx
ON wagering.wager_transactions(reference_deadline_at, wallet_id, id)
WHERE status = 'PENDING_REFERENCE';

REVOKE ALL ON FUNCTION wagering.guard_reference_deadline() FROM PUBLIC;
GRANT UPDATE (reference_deadline_at) ON wagering.wager_transactions TO wagering_runtime;
-- Demais grants, triggers financeiros e politica de reversoes permanecem intactos.
`;
export const pendingReferenceDown = String.raw`-- PROPOSTA PARA APROVACAO. NAO EXECUTADO. NAO REGISTRADO NO MIGRATOR.
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
`;
