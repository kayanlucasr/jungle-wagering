import { Migration } from '@mikro-orm/migrations';
import { financialUp, financialDown } from './financial-sql';

/** Stage 3. Owner-only, atomic, and explicitly registered with the official Migrator. */
export class Migration20261028000200 extends Migration {
  override async up(): Promise<void> { this.addSql(financialUp); }
  override async down(): Promise<void> { this.addSql(financialDown); }
}
