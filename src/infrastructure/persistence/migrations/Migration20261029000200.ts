import { Migration } from '@mikro-orm/migrations';
import { pendingReferenceUp, pendingReferenceDown } from './pending-reference-sql';

/** Stage 6 DDL explicitly approved on 29/10/2026. Writers must be drained before upgrade. */
export class Migration20261029000200 extends Migration {
  override async up(): Promise<void> {
    // Backfill fires deferred financial triggers. Flush them before later ALTER/INDEX DDL,
    // without disabling checks, then restore the original deferred mode.
    this.addSql(pendingReferenceUp.replace('ALTER TABLE wagering.wager_transactions\n  ADD CONSTRAINT',
      'SET CONSTRAINTS ALL IMMEDIATE;\nSET CONSTRAINTS ALL DEFERRED;\n\nALTER TABLE wagering.wager_transactions\n  ADD CONSTRAINT'));
  }
  override async down(): Promise<void> { this.addSql(pendingReferenceDown); }
}
