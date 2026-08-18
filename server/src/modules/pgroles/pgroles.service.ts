import type {
  GrantRequest,
  PgRoleInfo,
  PgRoleInput,
  PgRoleUpdate,
  TableGrants,
} from '@pgforge/shared'
import { NotFoundError } from '../../core/errors.js'
import { qualify, quoteIdent, quoteLiteral } from '../../core/ident.js'
import type { AppContext } from '../../context.js'

export class PgRolesService {
  constructor(private readonly ctx: AppContext) {}

  list(connId: string): Promise<PgRoleInfo[]> {
    return this.ctx.pools.withClient(connId, undefined, async (c) => {
      const { rows } = await c.query(`
        SELECT r.rolname AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
               r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
               r.rolvaliduntil,
               ARRAY(SELECT g.rolname FROM pg_auth_members m
                     JOIN pg_roles g ON g.oid = m.roleid
                     WHERE m.member = r.oid ORDER BY g.rolname) AS member_of,
               shobj_description(r.oid, 'pg_authid') AS comment
        FROM pg_roles r
        WHERE r.rolname NOT LIKE 'pg\\_%'
        ORDER BY r.rolname`)
      return rows.map((r) => ({
        name: r.name,
        superuser: r.rolsuper,
        createDb: r.rolcreatedb,
        createRole: r.rolcreaterole,
        login: r.rolcanlogin,
        replication: r.rolreplication,
        bypassRls: r.rolbypassrls,
        connLimit: r.rolconnlimit,
        validUntil: r.rolvaliduntil ? new Date(r.rolvaliduntil).toISOString() : null,
        memberOf: r.member_of ?? [],
        comment: r.comment,
      }))
    })
  }

  async create(connId: string, input: PgRoleInput): Promise<void> {
    const options = [
      input.login ? 'LOGIN' : 'NOLOGIN',
      input.superuser ? 'SUPERUSER' : 'NOSUPERUSER',
      input.createDb ? 'CREATEDB' : 'NOCREATEDB',
      input.createRole ? 'CREATEROLE' : 'NOCREATEROLE',
      input.replication ? 'REPLICATION' : 'NOREPLICATION',
    ]
    if (input.connLimit !== undefined) options.push(`CONNECTION LIMIT ${Math.trunc(input.connLimit)}`)
    if (input.validUntil) options.push(`VALID UNTIL ${quoteLiteral(input.validUntil)}`)
    if (input.password) options.push(`PASSWORD ${quoteLiteral(input.password)}`)

    await this.ctx.pools.withClient(connId, undefined, async (c) => {
      await c.query(`CREATE ROLE ${quoteIdent(input.name)} WITH ${options.join(' ')}`)
      for (const group of input.memberOf ?? []) {
        await c.query(`GRANT ${quoteIdent(group)} TO ${quoteIdent(input.name)}`)
      }
    })
  }

  async update(connId: string, name: string, input: PgRoleUpdate): Promise<void> {
    const options: string[] = []
    if (input.login !== undefined) options.push(input.login ? 'LOGIN' : 'NOLOGIN')
    if (input.superuser !== undefined) options.push(input.superuser ? 'SUPERUSER' : 'NOSUPERUSER')
    if (input.createDb !== undefined) options.push(input.createDb ? 'CREATEDB' : 'NOCREATEDB')
    if (input.createRole !== undefined) options.push(input.createRole ? 'CREATEROLE' : 'NOCREATEROLE')
    if (input.replication !== undefined) options.push(input.replication ? 'REPLICATION' : 'NOREPLICATION')
    if (input.connLimit !== undefined) options.push(`CONNECTION LIMIT ${Math.trunc(input.connLimit)}`)
    if (input.validUntil !== undefined) {
      options.push(input.validUntil ? `VALID UNTIL ${quoteLiteral(input.validUntil)}` : "VALID UNTIL 'infinity'")
    }
    if (input.password) options.push(`PASSWORD ${quoteLiteral(input.password)}`)

    await this.ctx.pools.withClient(connId, undefined, async (c) => {
      if (options.length > 0) {
        await c.query(`ALTER ROLE ${quoteIdent(name)} WITH ${options.join(' ')}`)
      }
      if (input.memberOf) {
        const { rows } = await c.query(
          `SELECT g.rolname AS name FROM pg_auth_members m
           JOIN pg_roles g ON g.oid = m.roleid
           JOIN pg_roles r ON r.oid = m.member
           WHERE r.rolname = $1`,
          [name],
        )
        const current = new Set<string>(rows.map((r) => r.name))
        const desired = new Set(input.memberOf)
        for (const group of desired) {
          if (!current.has(group)) await c.query(`GRANT ${quoteIdent(group)} TO ${quoteIdent(name)}`)
        }
        for (const group of current) {
          if (!desired.has(group)) await c.query(`REVOKE ${quoteIdent(group)} FROM ${quoteIdent(name)}`)
        }
      }
    })
  }

  async drop(connId: string, name: string): Promise<void> {
    await this.ctx.pools.withClient(connId, undefined, async (c) => {
      const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])
      if (exists.rowCount === 0) throw new NotFoundError(`Role ${name} not found`)
      await c.query(`DROP ROLE ${quoteIdent(name)}`)
    })
  }

  tableGrants(connId: string, db: string, schema: string, table: string): Promise<TableGrants[]> {
    return this.ctx.pools.withClient(connId, db, async (c) => {
      // privilege_type is an information_schema domain; cast to text[] so the
      // driver parses the aggregate as a real array.
      const { rows } = await c.query(
        `SELECT grantee::text AS grantee,
                array_agg(DISTINCT privilege_type::text)::text[] AS privileges
         FROM information_schema.role_table_grants
         WHERE table_schema = $1 AND table_name = $2
         GROUP BY grantee
         ORDER BY grantee`,
        [schema, table],
      )
      return rows.map((r) => ({ grantee: r.grantee, privileges: r.privileges }))
    })
  }

  async applyGrant(connId: string, db: string, req: GrantRequest, revoke: boolean): Promise<string> {
    // Privilege names come from a closed zod enum — safe to interpolate.
    const privileges = req.privileges.join(', ')
    const target = req.table
      ? `TABLE ${qualify(req.schema, req.table)}`
      : `ALL TABLES IN SCHEMA ${quoteIdent(req.schema)}`
    const sql = revoke
      ? `REVOKE ${privileges} ON ${target} FROM ${quoteIdent(req.role)}`
      : `GRANT ${privileges} ON ${target} TO ${quoteIdent(req.role)}`
    await this.ctx.pools.withClient(connId, db, (c) => c.query(sql))
    return sql
  }
}
