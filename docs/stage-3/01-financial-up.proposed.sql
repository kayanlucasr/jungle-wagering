-- PROPOSTA PARA APROVACAO. NAO EXECUTADO. NAO E UMA MIGRATION.
-- PostgreSQL 17. Executar futuramente pelo Migrator, em uma transacao,
-- como wagering_owner. Requer namespace da Etapa 1 e bootstrap 00 aprovado.
-- Sem CREATE SCHEMA, sem extensoes, sem sincronizacao automatica.

CREATE DOMAIN wagering.identifier AS text
  CHECK (length(VALUE) BETWEEN 1 AND 256
    AND VALUE !~ '^[[:space:]]|[[:space:]]$');
CREATE DOMAIN wagering.currency_code AS text CHECK (VALUE ~ '^[A-Z]{3}$');
-- Sem typmod: numeric(20,2) arredondaria ANTES de CHECK/trigger.
-- Escala SQL 0..2 e permitida; contrato externo e mapper exigem duas casas.
CREATE DOMAIN wagering.money_amount AS numeric
  CHECK (VALUE >= 0 AND VALUE <= 999999999999999999.99 AND scale(VALUE) <= 2);

CREATE TABLE wagering.wallets (
  id wagering.identifier PRIMARY KEY,
  player_id wagering.identifier NOT NULL,
  currency wagering.currency_code NOT NULL,
  balance wagering.money_amount NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at)),
  updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at)),
  CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
  CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
  CONSTRAINT wallets_time_ck CHECK (updated_at >= created_at)
);

CREATE TABLE wagering.wager_transactions (
  id wagering.identifier PRIMARY KEY,
  provider_id wagering.identifier,
  external_transaction_id wagering.identifier,
  idempotency_key wagering.identifier,
  payload_hash text CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload_schema_version integer,
  wallet_id wagering.identifier NOT NULL REFERENCES wagering.wallets(id) ON DELETE RESTRICT,
  player_id wagering.identifier NOT NULL,
  currency wagering.currency_code NOT NULL,
  round_id wagering.identifier,
  game_id wagering.identifier,
  kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount wagering.money_amount NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  reference_external_transaction_id wagering.identifier,
  reference_transaction_id wagering.identifier REFERENCES wagering.wager_transactions(id) ON DELETE RESTRICT,
  failure_code text CHECK (failure_code IN (
    'INVALID_AMOUNT','AMOUNT_OUT_OF_RANGE','CURRENCY_MISMATCH','INSUFFICIENT_FUNDS',
    'INVALID_TRANSACTION_STATE','REFERENCE_NOT_FOUND','INVALID_REFERENCE',
    'REFERENCE_CONTEXT_MISMATCH','REFERENCE_KIND_NOT_ALLOWED','REFERENCE_AMOUNT_MISMATCH',
    'REFERENCE_NOT_PROCESSED','REFERENCE_ALREADY_REVERSED','REVERSAL_INSUFFICIENT_FUNDS',
    'WALLET_NOT_FOUND','WALLET_PLAYER_MISMATCH','INVALID_WALLET','INVALID_LEDGER_ENTRY',
    'INVALID_IDENTIFIER','INVALID_TIMESTAMP','PERMANENT_PROCESSING_FAILURE')),
  result_balance wagering.money_amount,
  result_currency wagering.currency_code,
  result_wallet_version bigint CHECK (result_wallet_version >= 1),
  result_schema_version integer,
  terminal_result jsonb,
  processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  next_attempt_at timestamptz(3) CHECK (isfinite(next_attempt_at)),
  last_attempt_at timestamptz(3) CHECK (isfinite(last_attempt_at)),
  created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at)),
  updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at)),
  completed_at timestamptz(3) CHECK (isfinite(completed_at)),
  CONSTRAINT transactions_external_uq UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT transactions_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT transactions_ledger_identity_uq UNIQUE (id, wallet_id, currency),
  CONSTRAINT transactions_amount_ck CHECK (kind = 'LOSS' OR amount > 0),
  CONSTRAINT transactions_identity_ck CHECK (
    (kind = 'OPENING' AND provider_id IS NULL AND external_transaction_id IS NULL
      AND idempotency_key IS NULL AND payload_hash IS NULL AND payload_schema_version IS NULL
      AND round_id IS NULL AND game_id IS NULL AND reference_external_transaction_id IS NULL
      AND reference_transaction_id IS NULL AND status = 'PROCESSED')
    OR
    (kind <> 'OPENING' AND provider_id IS NOT NULL AND external_transaction_id IS NOT NULL
      AND idempotency_key IS NOT NULL AND payload_hash IS NOT NULL AND payload_schema_version = 1
      AND payload_schema_version IS NOT NULL AND round_id IS NOT NULL AND game_id IS NOT NULL)),
  CONSTRAINT transactions_reference_ck CHECK (
    (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)
    AND reference_external_transaction_id IS DISTINCT FROM external_transaction_id
      OR kind = 'OPENING'),
  CONSTRAINT transactions_not_self_ck CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
  CONSTRAINT transactions_time_ck CHECK (updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
    AND (last_attempt_at IS NULL OR last_attempt_at >= created_at)
    AND (next_attempt_at IS NULL OR next_attempt_at >= created_at)),
  CONSTRAINT transactions_terminal_ck CHECK (
    (status IN ('PENDING','PENDING_REFERENCE') AND failure_code IS NULL
      AND reference_transaction_id IS NULL AND terminal_result IS NULL
      AND result_balance IS NULL AND result_currency IS NULL AND result_wallet_version IS NULL
      AND result_schema_version IS NULL AND completed_at IS NULL
      AND (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL))
    OR
    (status IN ('PROCESSED','REJECTED','FAILED') AND terminal_result IS NOT NULL
      AND result_balance IS NOT NULL AND result_currency IS NOT NULL
      AND result_wallet_version IS NOT NULL AND result_schema_version IS NOT NULL
      AND result_schema_version = 1 AND completed_at IS NOT NULL AND next_attempt_at IS NULL
      AND updated_at = completed_at
      AND ((status = 'PROCESSED' AND failure_code IS NULL
          AND ((reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL)))
        OR (status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL AND reference_transaction_id IS NULL))))
);

-- Unicidade conjunta: REFUND ou ROLLBACK PROCESSED consome a referencia uma vez.
CREATE UNIQUE INDEX transactions_one_reversal_uq
  ON wagering.wager_transactions(reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE UNIQUE INDEX transactions_one_opening_uq ON wagering.wager_transactions(wallet_id)
  WHERE kind = 'OPENING';
CREATE INDEX transactions_wallet_history_idx ON wagering.wager_transactions(wallet_id, created_at, id);
CREATE INDEX transactions_reference_history_idx ON wagering.wager_transactions(reference_transaction_id, kind, status);
CREATE INDEX transactions_pending_reference_idx
  ON wagering.wager_transactions(next_attempt_at, id) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX transactions_external_reference_idx
  ON wagering.wager_transactions(provider_id, reference_external_transaction_id)
  WHERE reference_external_transaction_id IS NOT NULL;

CREATE TABLE wagering.wallet_ledger_entries (
  id wagering.identifier PRIMARY KEY,
  wallet_id wagering.identifier NOT NULL,
  transaction_id wagering.identifier NOT NULL,
  wallet_version bigint NOT NULL CHECK (wallet_version >= 1),
  direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount wagering.money_amount NOT NULL CHECK (amount > 0),
  currency wagering.currency_code NOT NULL,
  balance_before wagering.money_amount NOT NULL,
  balance_after wagering.money_amount NOT NULL,
  created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at)),
  CONSTRAINT ledger_transaction_wallet_uq UNIQUE (transaction_id, wallet_id),
  CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
  CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id, currency)
    REFERENCES wagering.wallets(id, currency) ON DELETE RESTRICT,
  CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency)
    REFERENCES wagering.wager_transactions(id, wallet_id, currency) ON DELETE RESTRICT,
  CONSTRAINT ledger_equation_ck CHECK (balance_after = balance_before +
    CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
);

-- Estruturas preparadas; nenhum worker, lease operacional ou publicacao nesta etapa.
CREATE TABLE wagering.inbox_messages (
  consumer_name wagering.identifier NOT NULL,
  message_id wagering.identifier NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  transaction_id wagering.identifier REFERENCES wagering.wager_transactions(id) ON DELETE RESTRICT,
  received_at timestamptz(3) NOT NULL CHECK (isfinite(received_at)),
  processed_at timestamptz(3) CHECK (isfinite(processed_at)),
  PRIMARY KEY (consumer_name, message_id),
  CHECK (processed_at IS NULL OR (transaction_id IS NOT NULL AND processed_at >= received_at))
);
CREATE INDEX inbox_transaction_idx ON wagering.inbox_messages(transaction_id);

CREATE TABLE wagering.outbox_messages (
  id wagering.identifier PRIMARY KEY,
  transaction_id wagering.identifier NOT NULL REFERENCES wagering.wager_transactions(id) ON DELETE RESTRICT,
  aggregate_id wagering.identifier NOT NULL REFERENCES wagering.wallets(id) ON DELETE RESTRICT,
  event_type wagering.identifier NOT NULL,
  event_version integer NOT NULL CHECK (event_version >= 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz(3) NOT NULL CHECK (isfinite(occurred_at)),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz(3) CHECK (isfinite(next_attempt_at)),
  published_at timestamptz(3) CHECK (isfinite(published_at)),
  lease_owner wagering.identifier,
  lease_until timestamptz(3) CHECK (isfinite(lease_until)),
  CONSTRAINT outbox_event_uq UNIQUE (transaction_id, event_type, event_version),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (published_at IS NULL OR published_at >= occurred_at),
  CHECK (next_attempt_at IS NULL OR next_attempt_at >= occurred_at)
);
CREATE INDEX outbox_due_idx ON wagering.outbox_messages(next_attempt_at, occurred_at, id)
  WHERE published_at IS NULL;
CREATE INDEX outbox_aggregate_idx ON wagering.outbox_messages(aggregate_id, occurred_at, id);

-- Todas as funcoes sao SECURITY INVOKER. Nao ha elevacao de privilegios.
-- Objetos qualificados e search_path fixo evitam resolucao em schemas gravaveis.
CREATE FUNCTION wagering.deny_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable_financial_record';
END;
$$;

CREATE FUNCTION wagering.guard_wallet() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.updated_at <> NEW.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_wallet_opening';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable_wallet_identity';
    END IF;
    IF NEW.balance IS DISTINCT FROM OLD.balance THEN
      IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_wallet_version';
      END IF;
    ELSIF ROW(NEW.version, NEW.updated_at) IS DISTINCT FROM ROW(OLD.version, OLD.updated_at) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'wallet_unchanged_balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wagering.guard_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  w wagering.wallets%ROWTYPE;
  r wagering.wager_transactions%ROWTYPE;
  expected jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable_terminal_transaction';
    END IF;
    IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
      NEW.payload_hash, NEW.payload_schema_version, NEW.wallet_id, NEW.player_id,
      NEW.currency, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount,
      NEW.reference_external_transaction_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id,
      OLD.idempotency_key, OLD.payload_hash, OLD.payload_schema_version, OLD.wallet_id,
      OLD.player_id, OLD.currency, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount,
      OLD.reference_external_transaction_id, OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable_transaction_identity';
    END IF;
    IF (OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING')
      OR NEW.processing_attempts < OLD.processing_attempts OR NEW.updated_at < OLD.updated_at
      OR (OLD.last_attempt_at IS NOT NULL AND (NEW.last_attempt_at IS NULL
        OR NEW.last_attempt_at < OLD.last_attempt_at)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_transaction_transition';
    END IF;
  ELSIF NEW.kind <> 'OPENING' AND NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'external_transaction_must_start_pending';
  END IF;

  -- Defesa SQL adicional. Application deve adquirir wallet ANTES de tocar a transacao.
  SELECT * INTO w FROM wagering.wallets WHERE id = NEW.wallet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'wallet_not_found';
  END IF;
  IF NEW.status NOT IN ('PROCESSED','REJECTED','FAILED') THEN RETURN NEW; END IF;
  IF NEW.result_balance IS DISTINCT FROM w.balance
    OR NEW.result_currency IS DISTINCT FROM w.currency
    OR NEW.result_wallet_version IS DISTINCT FROM w.version
    OR NEW.completed_at IS NULL OR NEW.completed_at < w.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'terminal_snapshot_wallet_mismatch';
  END IF;
  expected := jsonb_strip_nulls(jsonb_build_object(
    'transactionId', NEW.id, 'status', NEW.status,
    'balance', jsonb_build_object('amount', NEW.result_balance::numeric(20,2)::text,
      'currency', NEW.result_currency),
    'walletVersion', NEW.result_wallet_version::text,
    'referenceTransactionId', NEW.reference_transaction_id,
    'failureCode', NEW.failure_code,
    'completedAt', to_char(NEW.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  IF NEW.terminal_result IS DISTINCT FROM expected THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_terminal_snapshot';
  END IF;
  IF NEW.status <> 'PROCESSED' THEN RETURN NEW; END IF;
  IF NEW.player_id <> w.player_id OR NEW.currency <> w.currency THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'processed_wallet_context_mismatch';
  END IF;
  IF NEW.kind = 'OPENING' AND (w.version <> 1 OR NEW.amount <> w.balance
    OR NEW.created_at <> w.created_at OR NEW.completed_at <> w.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_opening_transaction';
  END IF;
  IF NEW.reference_external_transaction_id IS NOT NULL THEN
    SELECT * INTO r FROM wagering.wager_transactions WHERE id = NEW.reference_transaction_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'processed_reference_missing';
    END IF;
    IF r.status <> 'PROCESSED' OR r.id = NEW.id
      OR ROW(r.provider_id, r.external_transaction_id, r.wallet_id, r.player_id, r.currency, r.round_id)
        IS DISTINCT FROM ROW(NEW.provider_id, NEW.reference_external_transaction_id,
          NEW.wallet_id, NEW.player_id, NEW.currency, NEW.round_id)
      OR (NEW.kind <> 'ROLLBACK' AND r.kind <> 'BET')
      OR (NEW.kind = 'ROLLBACK' AND r.kind NOT IN ('BET','WIN','REFUND'))
      OR (NEW.kind IN ('REFUND','ROLLBACK') AND NEW.amount <> r.amount) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_processed_reference';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wagering.guard_ledger_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w wagering.wallets%ROWTYPE;
BEGIN
  SELECT * INTO w FROM wagering.wallets WHERE id = NEW.wallet_id FOR UPDATE;
  IF NOT FOUND OR NEW.wallet_version IS DISTINCT FROM w.version
    OR NEW.balance_after IS DISTINCT FROM w.balance OR NEW.currency IS DISTINCT FROM w.currency
    OR NEW.created_at IS DISTINCT FROM w.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ledger_wallet_head_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

-- Validacoes locais por versao, nao SUM de todo o historico a cada aposta.
CREATE FUNCTION wagering.check_ledger_entry(entry_id text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e wagering.wallet_ledger_entries%ROWTYPE;
  t wagering.wager_transactions%ROWTYPE;
  p wagering.wallet_ledger_entries%ROWTYPE;
  r_kind text;
  expected_direction text;
BEGIN
  SELECT * INTO e FROM wagering.wallet_ledger_entries WHERE id = entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'required_ledger_entry_missing';
  END IF;
  SELECT * INTO t FROM wagering.wager_transactions WHERE id = e.transaction_id;
  IF NOT FOUND OR t.status <> 'PROCESSED' OR t.kind = 'LOSS'
    OR ROW(t.wallet_id, t.currency, t.amount, t.result_wallet_version, t.result_balance, t.completed_at)
      IS DISTINCT FROM ROW(e.wallet_id, e.currency, e.amount, e.wallet_version, e.balance_after, e.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ledger_transaction_mismatch';
  END IF;
  SELECT kind INTO r_kind FROM wagering.wager_transactions WHERE id = t.reference_transaction_id;
  expected_direction := CASE WHEN t.kind = 'BET'
    OR (t.kind = 'ROLLBACK' AND r_kind IN ('WIN','REFUND')) THEN 'DEBIT' ELSE 'CREDIT' END;
  IF e.direction <> expected_direction THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ledger_direction_mismatch';
  END IF;
  IF e.wallet_version = 1 THEN
    IF t.kind <> 'OPENING' OR e.balance_before <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_ledger_opening';
    END IF;
  ELSE
    IF t.kind = 'OPENING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'opening_after_wallet_creation';
    END IF;
    SELECT * INTO p FROM wagering.wallet_ledger_entries
      WHERE wallet_id = e.wallet_id AND wallet_version = e.wallet_version - 1;
    IF FOUND THEN
      IF e.balance_before <> p.balance_after OR e.created_at < p.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'broken_ledger_chain';
      END IF;
    ELSIF e.wallet_version <> 2 OR e.balance_before <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ledger_version_gap';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION wagering.check_wallet_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e wagering.wallet_ledger_entries%ROWTYPE;
BEGIN
  -- NEW representa esta alteracao, inclusive se houver outra posterior no mesmo commit.
  IF TG_OP = 'INSERT' AND NEW.balance = 0 THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.balance = OLD.balance THEN RETURN NULL; END IF;
  SELECT * INTO e FROM wagering.wallet_ledger_entries
    WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
  IF NOT FOUND OR e.balance_after IS DISTINCT FROM NEW.balance
    OR e.created_at IS DISTINCT FROM NEW.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'wallet_change_without_matching_ledger';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF e.balance_before <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_wallet_opening_ledger';
    END IF;
  ELSIF e.balance_before IS DISTINCT FROM OLD.balance THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'wallet_change_ledger_delta_mismatch';
  END IF;
  PERFORM wagering.check_ledger_entry(e.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION wagering.check_transaction_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t wagering.wager_transactions%ROWTYPE; e_id text;
BEGIN
  -- Reconsultar estado FINAL: um INSERT PENDING pode terminar neste mesmo commit.
  SELECT * INTO t FROM wagering.wager_transactions WHERE id = NEW.id;
  SELECT id INTO e_id FROM wagering.wallet_ledger_entries
    WHERE transaction_id = t.id AND wallet_id = t.wallet_id;
  IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN
    IF e_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'processed_transaction_without_ledger';
    END IF;
    PERFORM wagering.check_ledger_entry(e_id);
  ELSIF e_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'non_financial_transaction_with_ledger';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION wagering.check_ledger_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM wagering.check_ledger_entry(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION wagering.guard_message_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'inbox_messages' THEN
    IF OLD.processed_at IS NOT NULL OR ROW(NEW.consumer_name, NEW.message_id, NEW.payload_hash, NEW.received_at)
      IS DISTINCT FROM ROW(OLD.consumer_name, OLD.message_id, OLD.payload_hash, OLD.received_at)
      OR (OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable_inbox_identity_or_result';
    END IF;
  ELSE
    IF OLD.published_at IS NOT NULL OR ROW(NEW.id, NEW.transaction_id, NEW.aggregate_id,
      NEW.event_type, NEW.event_version, NEW.payload, NEW.occurred_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.transaction_id, OLD.aggregate_id,
        OLD.event_type, OLD.event_version, OLD.payload, OLD.occurred_at)
      OR NEW.attempts < OLD.attempts THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable_outbox_identity_or_publication';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wagering.check_message_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t wagering.wager_transactions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'outbox_messages' THEN
    SELECT * INTO t FROM wagering.wager_transactions WHERE id = NEW.transaction_id;
    IF NOT FOUND OR t.wallet_id IS DISTINCT FROM NEW.aggregate_id
      OR t.status NOT IN ('PROCESSED','REJECTED','FAILED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'outbox_transaction_context_mismatch';
    END IF;
  ELSE
    IF NEW.processed_at IS NOT NULL THEN
      SELECT * INTO t FROM wagering.wager_transactions WHERE id = NEW.transaction_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'inbox_transaction_missing';
      END IF;
      -- PENDING_REFERENCE e aceite duravel: ack de transporte nao exige efeito financeiro.
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER wallets_guard BEFORE INSERT OR UPDATE ON wagering.wallets
  FOR EACH ROW EXECUTE FUNCTION wagering.guard_wallet();
CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wagering.wallets
  FOR EACH ROW EXECUTE FUNCTION wagering.deny_mutation();
CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wagering.wallets
  FOR EACH STATEMENT EXECUTE FUNCTION wagering.deny_mutation();
CREATE CONSTRAINT TRIGGER wallets_financial_effect AFTER INSERT OR UPDATE ON wagering.wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering.check_wallet_change();

CREATE TRIGGER transactions_guard BEFORE INSERT OR UPDATE ON wagering.wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wagering.guard_transaction();
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON wagering.wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wagering.deny_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON wagering.wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION wagering.deny_mutation();
CREATE CONSTRAINT TRIGGER transactions_financial_effect AFTER INSERT OR UPDATE ON wagering.wager_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering.check_transaction_effect();

CREATE TRIGGER ledger_insert_guard BEFORE INSERT ON wagering.wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wagering.guard_ledger_insert();
CREATE TRIGGER ledger_no_mutation BEFORE UPDATE OR DELETE ON wagering.wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wagering.deny_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wagering.wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION wagering.deny_mutation();
CREATE CONSTRAINT TRIGGER ledger_financial_effect AFTER INSERT ON wagering.wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering.check_ledger_effect();

CREATE TRIGGER inbox_guard BEFORE UPDATE ON wagering.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION wagering.guard_message_update();
CREATE TRIGGER inbox_no_delete BEFORE DELETE ON wagering.inbox_messages
  FOR EACH ROW EXECUTE FUNCTION wagering.deny_mutation();
CREATE TRIGGER inbox_no_truncate BEFORE TRUNCATE ON wagering.inbox_messages
  FOR EACH STATEMENT EXECUTE FUNCTION wagering.deny_mutation();
CREATE CONSTRAINT TRIGGER inbox_reference AFTER INSERT OR UPDATE ON wagering.inbox_messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering.check_message_reference();

CREATE TRIGGER outbox_guard BEFORE UPDATE ON wagering.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION wagering.guard_message_update();
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON wagering.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION wagering.deny_mutation();
CREATE TRIGGER outbox_no_truncate BEFORE TRUNCATE ON wagering.outbox_messages
  FOR EACH STATEMENT EXECUTE FUNCTION wagering.deny_mutation();
CREATE CONSTRAINT TRIGGER outbox_reference AFTER INSERT OR UPDATE ON wagering.outbox_messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering.check_message_reference();

REVOKE ALL ON ALL TABLES IN SCHEMA wagering FROM PUBLIC, wagering_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wagering FROM PUBLIC, wagering_runtime;
REVOKE ALL ON DOMAIN wagering.identifier, wagering.currency_code, wagering.money_amount FROM PUBLIC;
GRANT USAGE ON DOMAIN wagering.identifier, wagering.currency_code, wagering.money_amount TO wagering_runtime;
GRANT USAGE ON SCHEMA wagering TO wagering_runtime;
GRANT SELECT, INSERT ON wagering.wallets, wagering.wager_transactions,
  wagering.wallet_ledger_entries TO wagering_runtime;
GRANT UPDATE (balance, version, updated_at) ON wagering.wallets TO wagering_runtime;
GRANT UPDATE (status, reference_transaction_id, failure_code, result_balance, result_currency,
  result_wallet_version, result_schema_version, terminal_result, processing_attempts,
  next_attempt_at, last_attempt_at, updated_at, completed_at)
  ON wagering.wager_transactions TO wagering_runtime;
-- Funcao auxiliar somente valida; triggers chamam como invoker.
GRANT EXECUTE ON FUNCTION wagering.check_ledger_entry(text) TO wagering_runtime;
-- Inbox/outbox: somente leitura na Etapa 3. Escrita sera concedida com os workers futuros.
GRANT SELECT ON wagering.inbox_messages, wagering.outbox_messages TO wagering_runtime;
-- Nenhum DELETE, TRUNCATE, REFERENCES, TRIGGER, CREATE ou acesso ao historico de migrations.
