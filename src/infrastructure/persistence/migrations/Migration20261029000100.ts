import { Migration } from '@mikro-orm/migrations';
import { financialUp } from './financial-sql';

const previousReferenceGuard = financialUp.slice(financialUp.indexOf('CREATE FUNCTION wagering.check_message_reference()'),
  financialUp.indexOf('CREATE TRIGGER wallets_guard')).trim();

/** Stage 5 authorization: narrow grants, persistent diagnostics and pending-reference event. */
export class Migration20261029000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wagering.outbox_messages add column position bigint generated always as identity;
      create index outbox_order_idx on wagering.outbox_messages(aggregate_id, position) where published_at is null;
      alter table wagering.outbox_messages add column last_error_code text
      check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$');
      grant insert on wagering.inbox_messages, wagering.outbox_messages to wagering_runtime;
      grant update (transaction_id, processed_at) on wagering.inbox_messages to wagering_runtime;
      grant update (attempts, next_attempt_at, published_at, lease_owner, lease_until, last_error_code)
        on wagering.outbox_messages to wagering_runtime;`);
    this.addSql(previousReferenceGuard.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
      .replace("OR t.status NOT IN ('PROCESSED','REJECTED','FAILED')",
        `OR (t.status NOT IN ('PROCESSED','REJECTED','FAILED') AND NOT
          (t.status = 'PENDING_REFERENCE' AND NEW.event_type = 'WagerTransactionPendingReference'))`));
  }
  override async down(): Promise<void> {
    // Operational rollback requires stopping workers. Never silently discard diagnostics or events.
    this.addSql(`lock table wagering.inbox_messages, wagering.outbox_messages in access exclusive mode;
      do $$ begin
        if exists(select 1 from wagering.inbox_messages) or exists(select 1 from wagering.outbox_messages) then
          raise exception 'messaging_down_requires_empty_tables' using errcode = '23514';
        end if;
      end $$;
      revoke insert on wagering.inbox_messages, wagering.outbox_messages from wagering_runtime;
      revoke update (transaction_id, processed_at) on wagering.inbox_messages from wagering_runtime;
      revoke update (attempts, next_attempt_at, published_at, lease_owner, lease_until, last_error_code)
        on wagering.outbox_messages from wagering_runtime;
      drop index wagering.outbox_order_idx;
      alter table wagering.outbox_messages drop column position restrict;
      alter table wagering.outbox_messages drop column last_error_code restrict;`);
    this.addSql(previousReferenceGuard.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  }
}
