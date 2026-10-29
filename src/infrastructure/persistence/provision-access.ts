import type { MikroORM } from '@mikro-orm/postgresql';
import { accessSql } from './access-sql';

export interface DatabaseLogin { readonly name: string; readonly password: string }

/** Administrative job only, never imported by bootstrap.ts / application startup. */
export async function provisionAccess(admin: MikroORM, migrations: DatabaseLogin, runtime: DatabaseLogin): Promise<void> {
  for (const login of [migrations, runtime]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(login.name) || login.password.length === 0
      || ['wagering_owner', 'wagering_runtime'].includes(login.name)) throw new Error('InvalidDatabaseLogin');
  }
  if (migrations.name === runtime.name) throw new Error('DatabaseLoginsMustDiffer');
  await admin.em.fork().transactional(async (em) => {
    // Serialize administrative jobs only. Financial operations never take this lock.
    await em.execute("select pg_advisory_xact_lock(741523601)");
    for (const name of ['wagering_owner', 'wagering_runtime', migrations.name, runtime.name]) {
      const rows = await em.execute<Array<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
        rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(`select rolsuper, rolcreatedb,
        rolcreaterole, rolreplication, rolbypassrls, rolcanlogin from pg_roles where rolname = ?`, [name]);
      const group = name === 'wagering_owner' || name === 'wagering_runtime';
      if (rows.length > 0) {
        const role = rows[0]!;
        if (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication
          || role.rolbypassrls || role.rolcanlogin === group) throw new Error('UnsafeExistingDatabaseRole');
        const parents = await em.execute<Array<{ parent: string }>>(`select p.rolname as parent
          from pg_auth_members m join pg_roles p on p.oid = m.roleid
          join pg_roles c on c.oid = m.member where c.rolname = ?`, [name]);
        const allowed = name === migrations.name ? 'wagering_owner' : name === runtime.name ? 'wagering_runtime' : undefined;
        if (parents.some((row) => row.parent !== allowed)) throw new Error('UnsafeDatabaseRoleMembership');
      } else if (group) {
        const statement = accessSql.match(new RegExp(`CREATE ROLE ${name}[^;]+;`))?.[0];
        if (!statement) throw new Error('MissingApprovedRoleDefinition');
        await em.execute(statement);
      } else {
        // Identifiers are regex-validated; SQL literals are quoted, never logged.
        const password = (name === migrations.name ? migrations.password : runtime.password).replaceAll("'", "''");
        await em.execute(`create role "${name}" login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${password}'`);
      }
    }
    const database = admin.config.get('dbName');
    if (!database || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(database)) throw new Error('InvalidDatabaseName');
    await em.execute(`grant wagering_owner to "${migrations.name}"`);
    await em.execute(`grant wagering_runtime to "${runtime.name}"`);
    await em.execute(`grant connect on database "${database}" to "${migrations.name}", "${runtime.name}"`);
    // Original SQL, excluding CREATE ROLE statements handled with inspected-role checks above.
    await em.execute(accessSql.replace(/CREATE ROLE wagering_(?:owner|runtime)[^;]+;/g, ''));
  });
}
