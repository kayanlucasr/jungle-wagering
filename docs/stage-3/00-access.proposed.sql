-- PROPOSTA PARA REVISAO. NAO EXECUTADO. Nao integra o runner de migrations.
-- Bootstrap administrativo separado das migrations; roles sao globais ao cluster.
-- Executar como administrador em uma unica transacao (incluindo os grants/revokes).
-- Executar somente em cluster onde estes nomes foram reservados para este projeto.
-- Sem IF NOT EXISTS: colisao deve falhar e exigir inspecao, nunca reutilizar role desconhecida.
CREATE ROLE wagering_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE wagering_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;

-- O administrador provisionara logins/senhas via secrets, fora do repositorio.
-- Login de migrations: membro SOMENTE de wagering_owner; usar SET ROLE wagering_owner.
-- Login da aplicacao: membro SOMENTE de wagering_runtime; nunca membro do owner.
-- Os dois logins devem ser NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS.
-- Nao conceder pg_write_all_data, pg_read_all_data ou pg_execute_server_program.
-- Conceder CONNECT somente no banco deste projeto a ambos os logins.
-- Estas operacoes usam o nome real do banco e os logins administrados no ambiente.

-- Executar no banco do projeto como seu administrador, apos a migration da Etapa 1.
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO wagering_owner', current_database());
END $$;
ALTER SCHEMA wagering OWNER TO wagering_owner;
DO $$ BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM wagering_owner', current_database());
END $$;
REVOKE ALL ON SCHEMA wagering FROM PUBLIC;
GRANT USAGE ON SCHEMA wagering TO wagering_runtime;

-- Historico MikroORM permanece separado, no schema public ja usado pela Etapa 1.
-- Transferir propriedade da tabela existente para que o migrator deixe de usar superuser.
ALTER TABLE public.mikro_orm_migrations OWNER TO wagering_owner;
-- Necessario ao criador de objetos/historico MikroORM, nao ao runtime.
GRANT USAGE, CREATE ON SCHEMA public TO wagering_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner
  REVOKE USAGE ON TYPES FROM PUBLIC;

-- Sem DROP ROLE no down financeiro. Roles podem ser usadas por outros bancos;
-- remocao so em teardown administrativo explicito de cluster descartavel.
