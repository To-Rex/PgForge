import type pg from 'pg'
import type {
  AlterTableRequest,
  AutocompleteData,
  ColumnInfo,
  CreateDatabaseInput,
  CreateIndexInput,
  CreateSequenceInput,
  CreateTableInput,
  DatabaseInfo,
  DropRequest,
  ForeignKeyInfo,
  MaintenanceOp,
  NewColumnSpec,
  RefreshMatviewInput,
  RestartSequenceInput,
  RoutineInfo,
  SchemaInfo,
  SequenceInfo,
  TableInfo,
  TableStructure,
  TruncateRequest,
} from '@pgforge/shared'
import { BadRequestError, NotFoundError } from '../../core/errors.js'
import { qualify, quoteIdent, quoteLiteral } from '../../core/ident.js'
import type { AppContext } from '../../context.js'

const FK_ACTION: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
}

/**
 * SQL type names cannot be parameterized. This accepts plain, parameterized,
 * array and schema-qualified types (`varchar(50)`, `numeric(10,2)`,
 * `timestamp with time zone`, `text[]`, `public.my_enum`) and rejects
 * anything that could smuggle in extra statements.
 */
const SQL_TYPE_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_ ]*(\.[A-Za-z_][A-Za-z0-9_]*)?(\s*\(\s*\d+\s*(,\s*\d+\s*)?\))?(\s*\[\s*\])?$/

function assertSqlType(type: string): string {
  const trimmed = type.trim()
  if (!SQL_TYPE_PATTERN.test(trimmed)) {
    throw new BadRequestError(`Invalid SQL type: ${JSON.stringify(type)}`)
  }
  return trimmed
}

function columnDdl(spec: NewColumnSpec): string {
  let ddl = `${quoteIdent(spec.name)} ${assertSqlType(spec.type)}`
  if (spec.default?.trim()) ddl += ` DEFAULT ${spec.default.trim()}`
  if (!spec.nullable) ddl += ' NOT NULL'
  return ddl
}

export class InspectorService {
  constructor(private readonly ctx: AppContext) {}

  private with<T>(connId: string, db: string | undefined, fn: (c: pg.PoolClient) => Promise<T>) {
    return this.ctx.pools.withClient(connId, db, fn)
  }

  listDatabases(connId: string): Promise<DatabaseInfo[]> {
    return this.with(connId, undefined, async (c) => {
      const { rows } = await c.query(`
        SELECT d.datname AS name,
               pg_get_userbyid(d.datdba) AS owner,
               pg_encoding_to_char(d.encoding) AS encoding,
               d.datcollate AS collation,
               CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                    THEN pg_database_size(d.datname) ELSE NULL END::text AS size_bytes,
               d.datistemplate AS is_template,
               (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname)::int AS connections,
               shobj_description(d.oid, 'pg_database') AS comment
        FROM pg_database d
        WHERE NOT d.datistemplate
        ORDER BY d.datname`)
      return rows.map((r) => ({
        name: r.name,
        owner: r.owner,
        encoding: r.encoding,
        collation: r.collation,
        sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
        isTemplate: r.is_template,
        connections: r.connections,
        comment: r.comment,
      }))
    })
  }

  async createDatabase(connId: string, input: CreateDatabaseInput): Promise<void> {
    const parts = [`CREATE DATABASE ${quoteIdent(input.name)}`]
    const options: string[] = []
    if (input.owner) options.push(`OWNER ${quoteIdent(input.owner)}`)
    if (input.encoding) options.push(`ENCODING ${quoteLiteral(input.encoding)}`)
    if (input.template) options.push(`TEMPLATE ${quoteIdent(input.template)}`)
    if (options.length) parts.push(`WITH ${options.join(' ')}`)
    await this.with(connId, undefined, (c) => c.query(parts.join(' ')))
  }

  async dropDatabase(connId: string, name: string, force: boolean): Promise<void> {
    const resolved = this.ctx.resolveConnection(connId)
    if (name === resolved.defaultDatabase) {
      throw new BadRequestError(
        'Cannot drop the maintenance database of this connection. Change the default database first.',
      )
    }
    const sql = force
      ? `DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`
      : `DROP DATABASE ${quoteIdent(name)}`
    await this.with(connId, undefined, (c) => c.query(sql))
  }

  listSchemas(connId: string, db: string): Promise<SchemaInfo[]> {
    return this.with(connId, db, async (c) => {
      const { rows } = await c.query(`
        SELECT n.nspname AS name,
               pg_get_userbyid(n.nspowner) AS owner,
               (SELECT count(*) FROM pg_class t
                 WHERE t.relnamespace = n.oid AND t.relkind IN ('r','p'))::int AS table_count,
               COALESCE((SELECT sum(pg_total_relation_size(t.oid)) FROM pg_class t
                 WHERE t.relnamespace = n.oid AND t.relkind IN ('r','p','m')), 0)::text AS size_bytes,
               obj_description(n.oid, 'pg_namespace') AS comment,
               n.nspname IN ('pg_catalog', 'information_schema') AS is_system
        FROM pg_namespace n
        WHERE n.nspname <> 'pg_toast'
          AND n.nspname NOT LIKE 'pg\\_temp%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp%'
        ORDER BY is_system, n.nspname`)
      return rows.map((r) => ({
        name: r.name,
        owner: r.owner,
        tableCount: r.table_count,
        sizeBytes: Number(r.size_bytes),
        comment: r.comment,
        isSystem: r.is_system,
      }))
    })
  }

  async createSchema(connId: string, db: string, name: string): Promise<void> {
    await this.with(connId, db, (c) => c.query(`CREATE SCHEMA ${quoteIdent(name)}`))
  }

  listTables(connId: string, db: string, schema: string): Promise<TableInfo[]> {
    return this.with(connId, db, async (c) => {
      const { rows } = await c.query(
        `SELECT n.nspname AS schema, t.relname AS name,
                CASE t.relkind
                  WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'f' THEN 'foreign'
                  ELSE 'table' END AS kind,
                pg_get_userbyid(t.relowner) AS owner,
                greatest(t.reltuples, 0)::bigint::text AS row_estimate,
                pg_total_relation_size(t.oid)::text AS total_bytes,
                obj_description(t.oid, 'pg_class') AS comment
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = $1 AND t.relkind IN ('r','p','v','m','f')
         ORDER BY t.relname`,
        [schema],
      )
      return rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        kind: r.kind,
        owner: r.owner,
        rowEstimate: Number(r.row_estimate),
        totalBytes: Number(r.total_bytes),
        comment: r.comment,
      }))
    })
  }

  async getColumns(client: pg.PoolClient, schema: string, table: string): Promise<ColumnInfo[]> {
    const { rows } = await client.query(
      `SELECT a.attname AS name, a.attnum AS ordinal,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(ad.adbin, ad.adrelid) AS default,
              a.attidentity <> '' AS is_identity,
              CASE WHEN a.atttypid IN (1042, 1043) AND a.atttypmod > 4
                   THEN a.atttypmod - 4 END AS max_length,
              col_description(t.oid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class t ON t.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = $1 AND t.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table],
    )
    return rows.map((r) => ({
      name: r.name,
      ordinal: r.ordinal,
      dataType: r.data_type,
      nullable: r.nullable,
      default: r.default,
      isPrimaryKey: false, // filled by caller
      isIdentity: r.is_identity,
      maxLength: r.max_length,
      comment: r.comment,
    }))
  }

  async getPrimaryKey(client: pg.PoolClient, schema: string, table: string): Promise<string[]> {
    const regclass = qualify(schema, table)
    const { rows } = await client.query(
      `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = to_regclass($1) AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`,
      [regclass],
    )
    return rows.map((r) => r.name)
  }

  getStructure(connId: string, db: string, schema: string, table: string): Promise<TableStructure> {
    return this.with(connId, db, async (c) => {
      const regclass = qualify(schema, table)
      const rel = await c.query(
        `SELECT CASE t.relkind
                  WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'f' THEN 'foreign'
                  ELSE 'table' END AS kind,
                greatest(t.reltuples, 0)::bigint::text AS row_estimate,
                pg_total_relation_size(t.oid)::text AS total_bytes,
                obj_description(t.oid, 'pg_class') AS comment
         FROM pg_class t WHERE t.oid = to_regclass($1)`,
        [regclass],
      )
      if (rel.rowCount === 0) throw new NotFoundError(`Relation ${schema}.${table} not found`)
      const relRow = rel.rows[0]

      const [columns, primaryKey, indexes, fks, refBy, triggers, checks] = await Promise.all([
        this.getColumns(c, schema, table),
        this.getPrimaryKey(c, schema, table),
        c.query(
          `SELECT ci.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
                  i.indisunique AS is_unique, i.indisprimary AS is_primary,
                  pg_relation_size(i.indexrelid)::text AS size_bytes,
                  COALESCE(s.idx_scan, 0)::text AS scans
           FROM pg_index i
           JOIN pg_class ci ON ci.oid = i.indexrelid
           LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
           WHERE i.indrelid = to_regclass($1)
           ORDER BY ci.relname`,
          [regclass],
        ),
        this.foreignKeys(c, regclass, 'out'),
        this.foreignKeys(c, regclass, 'in'),
        c.query(
          `SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS definition,
                  t.tgenabled <> 'D' AS enabled,
                  CASE WHEN t.tgtype & 64 <> 0 THEN 'INSTEAD OF'
                       WHEN t.tgtype & 2 <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
                  array_remove(ARRAY[
                    CASE WHEN t.tgtype & 4  <> 0 THEN 'INSERT' END,
                    CASE WHEN t.tgtype & 8  <> 0 THEN 'DELETE' END,
                    CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END,
                    CASE WHEN t.tgtype & 32 <> 0 THEN 'TRUNCATE' END], NULL) AS events
           FROM pg_trigger t
           WHERE t.tgrelid = to_regclass($1) AND NOT t.tgisinternal
           ORDER BY t.tgname`,
          [regclass],
        ),
        c.query(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'c'
           ORDER BY conname`,
          [regclass],
        ),
      ])

      const pkSet = new Set(primaryKey)
      for (const col of columns) col.isPrimaryKey = pkSet.has(col.name)

      const structure: TableStructure = {
        schema,
        name: table,
        kind: relRow.kind,
        columns,
        primaryKey,
        indexes: indexes.rows.map((r) => ({
          name: r.name,
          definition: r.definition,
          isUnique: r.is_unique,
          isPrimary: r.is_primary,
          sizeBytes: Number(r.size_bytes),
          scans: Number(r.scans),
        })),
        foreignKeys: fks,
        referencedBy: refBy,
        triggers: triggers.rows.map((r) => ({
          name: r.name,
          timing: r.timing,
          events: r.events,
          definition: r.definition,
          enabled: r.enabled,
        })),
        checks: checks.rows,
        rowEstimate: Number(relRow.row_estimate),
        totalBytes: Number(relRow.total_bytes),
        ddl: '',
        comment: relRow.comment,
      }
      structure.ddl = await this.buildDdl(c, structure, regclass)
      return structure
    })
  }

  private async foreignKeys(
    client: pg.PoolClient,
    regclass: string,
    direction: 'out' | 'in',
  ): Promise<ForeignKeyInfo[]> {
    // 'out': FKs declared on this table. 'in': FKs on other tables pointing here;
    // `columns` are then this table's referenced columns and refTable the referencing table.
    const anchor = direction === 'out' ? 'con.conrelid' : 'con.confrelid'
    const other = direction === 'out' ? 'con.confrelid' : 'con.conrelid'
    const ownKeys = direction === 'out' ? 'con.conkey' : 'con.confkey'
    const otherKeys = direction === 'out' ? 'con.confkey' : 'con.conkey'
    const ownRel = direction === 'out' ? 'con.conrelid' : 'con.confrelid'
    const { rows } = await client.query(
      `SELECT con.conname AS name,
              (SELECT array_agg(a.attname ORDER BY x.ord)
                 FROM unnest(${ownKeys}) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = ${ownRel} AND a.attnum = x.attnum) AS columns,
              rn.nspname AS ref_schema, rc.relname AS ref_table,
              (SELECT array_agg(a.attname ORDER BY x.ord)
                 FROM unnest(${otherKeys}) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = ${other} AND a.attnum = x.attnum) AS ref_columns,
              con.confupdtype AS upd, con.confdeltype AS del
       FROM pg_constraint con
       JOIN pg_class rc ON rc.oid = ${other}
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       WHERE ${anchor} = to_regclass($1) AND con.contype = 'f'
       ORDER BY con.conname`,
      [regclass],
    )
    return rows.map((r) => ({
      name: r.name,
      columns: r.columns ?? [],
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumns: r.ref_columns ?? [],
      onUpdate: FK_ACTION[r.upd] ?? 'NO ACTION',
      onDelete: FK_ACTION[r.del] ?? 'NO ACTION',
    }))
  }

  private async buildDdl(
    client: pg.PoolClient,
    s: TableStructure,
    regclass: string,
  ): Promise<string> {
    if (s.kind === 'view' || s.kind === 'matview') {
      const { rows } = await client.query('SELECT pg_get_viewdef(to_regclass($1), true) AS def', [
        regclass,
      ])
      const kind = s.kind === 'matview' ? 'MATERIALIZED VIEW' : 'VIEW'
      return `CREATE ${kind} ${qualify(s.schema, s.name)} AS\n${rows[0]?.def ?? ''}`
    }
    const lines = s.columns.map((col) => {
      let line = `  ${quoteIdent(col.name)} ${col.dataType}`
      if (col.isIdentity) line += ' GENERATED BY DEFAULT AS IDENTITY'
      else if (col.default) line += ` DEFAULT ${col.default}`
      if (!col.nullable) line += ' NOT NULL'
      return line
    })
    if (s.primaryKey.length > 0) {
      lines.push(`  PRIMARY KEY (${s.primaryKey.map(quoteIdent).join(', ')})`)
    }
    for (const fk of s.foreignKeys) {
      lines.push(
        `  CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${fk.columns.map(quoteIdent).join(', ')})` +
          ` REFERENCES ${qualify(fk.refSchema, fk.refTable)} (${fk.refColumns.map(quoteIdent).join(', ')})` +
          (fk.onDelete !== 'NO ACTION' ? ` ON DELETE ${fk.onDelete}` : '') +
          (fk.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${fk.onUpdate}` : ''),
      )
    }
    for (const check of s.checks) {
      lines.push(`  CONSTRAINT ${quoteIdent(check.name)} ${check.definition}`)
    }
    const create = `CREATE TABLE ${qualify(s.schema, s.name)} (\n${lines.join(',\n')}\n);`
    const secondary = s.indexes
      .filter((i) => !i.isPrimary)
      .map((i) => `${i.definition};`)
      .join('\n')
    return secondary ? `${create}\n\n${secondary}` : create
  }

  listRoutines(connId: string, db: string, schema: string): Promise<RoutineInfo[]> {
    return this.with(connId, db, async (c) => {
      const { rows } = await c.query(
        `SELECT n.nspname AS schema, p.proname AS name,
                CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
                l.lanname AS language,
                pg_get_function_identity_arguments(p.oid) AS arguments,
                COALESCE(pg_get_function_result(p.oid), '') AS return_type,
                pg_get_userbyid(p.proowner) AS owner,
                CASE WHEN l.lanname IN ('sql', 'plpgsql')
                     THEN pg_get_functiondef(p.oid) ELSE p.prosrc END AS definition,
                obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
         ORDER BY p.proname`,
        [schema],
      )
      return rows
    })
  }

  listSequences(connId: string, db: string, schema: string): Promise<SequenceInfo[]> {
    return this.with(connId, db, async (c) => {
      const { rows } = await c.query(
        `SELECT schemaname AS schema, sequencename AS name, data_type::text AS data_type,
                start_value::text AS start_value, min_value::text AS min_value,
                max_value::text AS max_value, increment_by::text AS increment,
                last_value::text AS last_value
         FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename`,
        [schema],
      )
      return rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        dataType: r.data_type,
        startValue: r.start_value,
        minValue: r.min_value,
        maxValue: r.max_value,
        increment: r.increment,
        lastValue: r.last_value,
      }))
    })
  }

  autocomplete(connId: string, db: string): Promise<AutocompleteData> {
    return this.with(connId, db, async (c) => {
      const { rows } = await c.query(`
        SELECT n.nspname AS schema, t.relname AS table, a.attname AS column, a.attnum
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid
        WHERE t.relkind IN ('r','p','v','m','f')
          AND a.attnum > 0 AND NOT a.attisdropped
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY n.nspname, t.relname, a.attnum`)
      const schemas = new Map<string, Map<string, string[]>>()
      for (const r of rows) {
        let tables = schemas.get(r.schema)
        if (!tables) schemas.set(r.schema, (tables = new Map()))
        let cols = tables.get(r.table)
        if (!cols) tables.set(r.table, (cols = []))
        cols.push(r.column)
      }
      return {
        schemas: [...schemas.entries()].map(([name, tables]) => ({
          name,
          tables: [...tables.entries()].map(([tname, columns]) => ({ name: tname, columns })),
        })),
        keywordsVersion: 1,
      }
    })
  }

  async drop(connId: string, db: string, req: DropRequest): Promise<string> {
    if (req.confirmName !== req.name) {
      throw new BadRequestError('Confirmation name does not match the object name')
    }
    const cascade = req.cascade ? ' CASCADE' : ''
    const target = qualify(req.schema, req.name)
    let sql: string
    switch (req.kind) {
      case 'table':
        sql = `DROP TABLE ${target}${cascade}`
        break
      case 'view':
        sql = `DROP VIEW ${target}${cascade}`
        break
      case 'matview':
        sql = `DROP MATERIALIZED VIEW ${target}${cascade}`
        break
      case 'index':
        sql = `DROP INDEX ${target}${cascade}`
        break
      case 'sequence':
        sql = `DROP SEQUENCE ${target}${cascade}`
        break
      case 'schema':
        sql = `DROP SCHEMA ${quoteIdent(req.name)}${cascade}`
        break
      case 'trigger': {
        if (!req.table) throw new BadRequestError('Trigger drops require the owning table')
        sql = `DROP TRIGGER ${quoteIdent(req.name)} ON ${qualify(req.schema, req.table)}${cascade}`
        break
      }
      case 'function':
      case 'procedure': {
        // Resolve the exact signature server-side; never trust a client-provided
        // argument list inside a DDL string.
        sql = await this.with(connId, db, async (c) => {
          const { rows } = await c.query(
            `SELECT p.oid::regprocedure::text AS signature, p.prokind
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1 AND p.proname = $2
               AND pg_get_function_identity_arguments(p.oid) = $3`,
            [req.schema, req.name, req.args ?? ''],
          )
          const match = rows[0]
          if (!match) throw new NotFoundError('Function or procedure not found')
          const kind = match.prokind === 'p' ? 'PROCEDURE' : 'FUNCTION'
          return `DROP ${kind} ${match.signature}${cascade}`
        })
        break
      }
    }
    await this.with(connId, db, (c) => c.query(sql))
    return sql
  }

  async truncate(connId: string, db: string, req: TruncateRequest): Promise<string> {
    if (req.confirmName !== req.table) {
      throw new BadRequestError('Confirmation name does not match the table name')
    }
    const sql =
      `TRUNCATE TABLE ${qualify(req.schema, req.table)}` +
      (req.restartIdentity ? ' RESTART IDENTITY' : '') +
      (req.cascade ? ' CASCADE' : '')
    await this.with(connId, db, (c) => c.query(sql))
    return sql
  }

  async createTable(connId: string, db: string, input: CreateTableInput): Promise<string> {
    const lines = input.columns.map(columnDdl)
    const pk = input.columns.filter((c) => c.primaryKey).map((c) => quoteIdent(c.name))
    if (pk.length > 0) lines.push(`PRIMARY KEY (${pk.join(', ')})`)
    const sql = `CREATE TABLE ${qualify(input.schema, input.name)} (\n  ${lines.join(',\n  ')}\n)`
    await this.with(connId, db, (c) => c.query(sql))
    return sql
  }

  /** Applies a batch of ALTER TABLE actions atomically (DDL is transactional). */
  async alterTable(
    connId: string,
    db: string,
    schema: string,
    table: string,
    req: AlterTableRequest,
  ): Promise<string[]> {
    if (req.actions.length === 0) throw new BadRequestError('No actions provided')
    let currentName = table
    const statements: string[] = []
    for (const action of req.actions) {
      const target = qualify(schema, currentName)
      switch (action.kind) {
        case 'rename_table':
          statements.push(`ALTER TABLE ${target} RENAME TO ${quoteIdent(action.newName)}`)
          currentName = action.newName
          break
        case 'rename_column':
          statements.push(
            `ALTER TABLE ${target} RENAME COLUMN ${quoteIdent(action.column)} TO ${quoteIdent(action.newName)}`,
          )
          break
        case 'add_column':
          statements.push(`ALTER TABLE ${target} ADD COLUMN ${columnDdl(action.spec)}`)
          break
        case 'drop_column':
          statements.push(
            `ALTER TABLE ${target} DROP COLUMN ${quoteIdent(action.column)}${action.cascade ? ' CASCADE' : ''}`,
          )
          break
        case 'set_type': {
          const using = action.using?.trim()
          statements.push(
            `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(action.column)} TYPE ${assertSqlType(action.type)}` +
              (using ? ` USING ${using}` : ''),
          )
          break
        }
        case 'set_not_null':
          statements.push(`ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(action.column)} SET NOT NULL`)
          break
        case 'drop_not_null':
          statements.push(`ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(action.column)} DROP NOT NULL`)
          break
        case 'set_default':
          statements.push(
            `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(action.column)} SET DEFAULT ${action.expression.trim()}`,
          )
          break
        case 'drop_default':
          statements.push(`ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(action.column)} DROP DEFAULT`)
          break
        case 'add_foreign_key': {
          const name = action.name ? `CONSTRAINT ${quoteIdent(action.name)} ` : ''
          statements.push(
            `ALTER TABLE ${target} ADD ${name}FOREIGN KEY (${action.columns.map(quoteIdent).join(', ')})` +
              ` REFERENCES ${qualify(action.refSchema, action.refTable)} (${action.refColumns.map(quoteIdent).join(', ')})` +
              ` ON DELETE ${action.onDelete} ON UPDATE ${action.onUpdate}`,
          )
          break
        }
        case 'add_check': {
          const name = action.name ? `CONSTRAINT ${quoteIdent(action.name)} ` : ''
          statements.push(`ALTER TABLE ${target} ADD ${name}CHECK (${action.expression.trim()})`)
          break
        }
        case 'drop_constraint':
          statements.push(
            `ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(action.name)}${action.cascade ? ' CASCADE' : ''}`,
          )
          break
        case 'set_comment': {
          const value = action.comment === null || action.comment === '' ? 'NULL' : quoteLiteral(action.comment)
          statements.push(
            action.target === 'table'
              ? `COMMENT ON TABLE ${target} IS ${value}`
              : `COMMENT ON COLUMN ${target}.${quoteIdent(action.column ?? '')} IS ${value}`,
          )
          break
        }
      }
    }
    await this.with(connId, db, async (c) => {
      await c.query('BEGIN')
      try {
        for (const statement of statements) await c.query(statement)
        await c.query('COMMIT')
      } catch (err) {
        await c.query('ROLLBACK')
        throw err
      }
    })
    return statements
  }

  async createIndex(
    connId: string,
    db: string,
    schema: string,
    table: string,
    input: CreateIndexInput,
  ): Promise<string> {
    return this.with(connId, db, async (c) => {
      const known = new Set((await this.getColumns(c, schema, table)).map((col) => col.name))
      for (const column of input.columns) {
        if (!known.has(column)) throw new BadRequestError(`Unknown column: ${column}`)
      }
      const sql =
        `CREATE ${input.unique ? 'UNIQUE ' : ''}INDEX ${input.name ? `${quoteIdent(input.name)} ` : ''}` +
        `ON ${qualify(schema, table)} USING ${input.method} (${input.columns.map(quoteIdent).join(', ')})`
      await c.query(sql)
      return sql
    })
  }

  async createSequence(connId: string, db: string, input: CreateSequenceInput): Promise<string> {
    const parts = [`CREATE SEQUENCE ${qualify(input.schema, input.name)}`]
    if (input.increment) parts.push(`INCREMENT BY ${input.increment}`)
    if (input.minValue) parts.push(`MINVALUE ${input.minValue}`)
    if (input.maxValue) parts.push(`MAXVALUE ${input.maxValue}`)
    if (input.startValue) parts.push(`START WITH ${input.startValue}`)
    if (input.cycle) parts.push('CYCLE')
    const sql = parts.join(' ')
    await this.with(connId, db, (c) => c.query(sql))
    return sql
  }

  async restartSequence(connId: string, db: string, input: RestartSequenceInput): Promise<string> {
    const sql = `ALTER SEQUENCE ${qualify(input.schema, input.name)} RESTART WITH ${input.restartWith}`
    await this.with(connId, db, (c) => c.query(sql))
    return sql
  }

  async refreshMatview(connId: string, db: string, input: RefreshMatviewInput): Promise<string> {
    const sql = `REFRESH MATERIALIZED VIEW ${input.concurrently ? 'CONCURRENTLY ' : ''}${qualify(input.schema, input.name)}`
    await this.with(connId, db, (c) => c.query(sql))
    return sql
  }

  /** VACUUM/ANALYZE/REINDEX — single autocommit statements (VACUUM cannot run in a transaction). */
  async maintenance(
    connId: string,
    db: string,
    schema: string,
    table: string,
    op: MaintenanceOp,
  ): Promise<string> {
    const target = qualify(schema, table)
    const sql =
      op === 'vacuum'
        ? `VACUUM ${target}`
        : op === 'vacuum_analyze'
          ? `VACUUM (ANALYZE) ${target}`
          : op === 'analyze'
            ? `ANALYZE ${target}`
            : `REINDEX TABLE ${target}`
    await this.with(connId, db, (c) => c.query(sql))
    return sql
  }
}
