import { Migration } from '@mikro-orm/migrations';

/** Stage 1 only: no financial tables until the conceptual schema is approved. */
export class Migration20261028000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql('create schema "wagering";');
  }

  override async down(): Promise<void> {
    // RESTRICT is intentional: never cascade into future financial tables.
    this.addSql('drop schema "wagering" restrict;');
  }
}
