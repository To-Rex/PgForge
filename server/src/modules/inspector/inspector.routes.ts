import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { BadRequestError } from '../../core/errors.js'
import { parse } from '../../core/validate.js'
import type { AppContext } from '../../context.js'
import { requireRole } from '../../plugins/auth.js'
import type { ConnectionsService } from '../connections/connections.service.js'
import type { InspectorService } from './inspector.service.js'

const createDbSchema = z.object({
  name: z.string().min(1).max(63),
  owner: z.string().min(1).max(63).optional(),
  encoding: z.string().min(1).max(32).optional(),
  template: z.string().min(1).max(63).optional(),
})

const dropDbSchema = z.object({
  force: z.boolean().optional(),
  confirmName: z.string(),
})

const createSchemaSchema = z.object({ name: z.string().min(1).max(63) })

const dropSchema = z.object({
  kind: z.enum(['table', 'view', 'matview', 'index', 'trigger', 'function', 'procedure', 'sequence', 'schema']),
  schema: z.string().min(1),
  name: z.string().min(1),
  table: z.string().optional(),
  args: z.string().max(1000).optional(),
  cascade: z.boolean().optional(),
  confirmName: z.string(),
})

const truncateSchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
  restartIdentity: z.boolean().optional(),
  cascade: z.boolean().optional(),
  confirmName: z.string(),
})

const ident = z.string().min(1).max(63)
const sqlType = z.string().min(1).max(120)
const sqlExpr = z.string().min(1).max(1000)
const bigintStr = z.string().regex(/^-?\d{1,19}$/)

const newColumnSchema = z.object({
  name: ident,
  type: sqlType,
  nullable: z.boolean(),
  default: z.string().max(1000).optional(),
  primaryKey: z.boolean().optional(),
})

const createTableSchema = z.object({
  schema: ident,
  name: ident,
  columns: z.array(newColumnSchema).min(1).max(100),
})

const fkRefAction = z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'])

const alterActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename_table'), newName: ident }),
  z.object({ kind: z.literal('rename_column'), column: ident, newName: ident }),
  z.object({ kind: z.literal('add_column'), spec: newColumnSchema }),
  z.object({ kind: z.literal('drop_column'), column: ident, cascade: z.boolean().optional() }),
  z.object({ kind: z.literal('set_type'), column: ident, type: sqlType, using: z.string().max(1000).optional() }),
  z.object({ kind: z.literal('set_not_null'), column: ident }),
  z.object({ kind: z.literal('drop_not_null'), column: ident }),
  z.object({ kind: z.literal('set_default'), column: ident, expression: sqlExpr }),
  z.object({ kind: z.literal('drop_default'), column: ident }),
  z.object({
    kind: z.literal('add_foreign_key'),
    name: ident.optional(),
    columns: z.array(ident).min(1).max(16),
    refSchema: ident,
    refTable: ident,
    refColumns: z.array(ident).min(1).max(16),
    onDelete: fkRefAction,
    onUpdate: fkRefAction,
  }),
  z.object({ kind: z.literal('add_check'), name: ident.optional(), expression: sqlExpr }),
  z.object({ kind: z.literal('drop_constraint'), name: ident, cascade: z.boolean().optional() }),
  z.object({
    kind: z.literal('set_comment'),
    target: z.enum(['table', 'column']),
    column: ident.optional(),
    comment: z.string().max(2000).nullable(),
  }),
])

const alterTableSchema = z.object({ actions: z.array(alterActionSchema).min(1).max(20) })

const createIndexSchema = z.object({
  name: ident.optional(),
  columns: z.array(ident).min(1).max(32),
  unique: z.boolean(),
  method: z.enum(['btree', 'hash', 'gin', 'gist', 'brin']),
})

const createSequenceSchema = z.object({
  schema: ident,
  name: ident,
  startValue: bigintStr.optional(),
  increment: bigintStr.optional(),
  minValue: bigintStr.optional(),
  maxValue: bigintStr.optional(),
  cycle: z.boolean().optional(),
})

const restartSequenceSchema = z.object({ schema: ident, name: ident, restartWith: bigintStr })

const refreshMatviewSchema = z.object({
  schema: ident,
  name: ident,
  concurrently: z.boolean().optional(),
})

const maintenanceSchema = z.object({
  op: z.enum(['vacuum', 'vacuum_analyze', 'analyze', 'reindex']),
})

type ConnParams = { connId: string }
type DbParams = ConnParams & { db: string }
type SchemaParams = DbParams & { schema: string }
type TableParams = SchemaParams & { table: string }

export function registerInspectorRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  inspector: InspectorService,
  connections: ConnectionsService,
): void {
  const actor = (req: FastifyRequest) => ({ id: req.currentUser.id, email: req.currentUser.email })

  app.get('/api/connections/:connId/databases', async (req) => {
    const { connId } = req.params as ConnParams
    return inspector.listDatabases(connId)
  })

  app.post(
    '/api/connections/:connId/databases',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId } = req.params as ConnParams
      connections.assertWritable(connId)
      const body = parse(createDbSchema, req.body)
      await inspector.createDatabase(connId, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'database.create',
        target: body.name,
        connectionId: connId,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/databases/:db/drop',
    { preHandler: requireRole('admin') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      connections.assertWritable(connId)
      const body = parse(dropDbSchema, req.body)
      if (body.confirmName !== db) {
        throw new BadRequestError('Confirmation name does not match the database name')
      }
      await inspector.dropDatabase(connId, db, body.force ?? false)
      ctx.audit.log({
        actor: actor(req),
        action: 'database.drop',
        target: db,
        connectionId: connId,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.get('/api/connections/:connId/db/:db/schemas', async (req) => {
    const { connId, db } = req.params as DbParams
    return inspector.listSchemas(connId, db)
  })

  app.post(
    '/api/connections/:connId/db/:db/schemas',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      connections.assertWritable(connId)
      const body = parse(createSchemaSchema, req.body)
      await inspector.createSchema(connId, db, body.name)
      ctx.audit.log({
        actor: actor(req),
        action: 'schema.create',
        target: body.name,
        connectionId: connId,
        database: db,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.get('/api/connections/:connId/db/:db/schemas/:schema/tables', async (req) => {
    const { connId, db, schema } = req.params as SchemaParams
    return inspector.listTables(connId, db, schema)
  })

  app.get('/api/connections/:connId/db/:db/schemas/:schema/routines', async (req) => {
    const { connId, db, schema } = req.params as SchemaParams
    return inspector.listRoutines(connId, db, schema)
  })

  app.get('/api/connections/:connId/db/:db/schemas/:schema/sequences', async (req) => {
    const { connId, db, schema } = req.params as SchemaParams
    return inspector.listSequences(connId, db, schema)
  })

  app.get('/api/connections/:connId/db/:db/tables/:schema/:table/structure', async (req) => {
    const { connId, db, schema, table } = req.params as TableParams
    return inspector.getStructure(connId, db, schema, table)
  })

  app.get('/api/connections/:connId/db/:db/autocomplete', async (req) => {
    const { connId, db } = req.params as DbParams
    return inspector.autocomplete(connId, db)
  })

  app.post(
    '/api/connections/:connId/db/:db/drop',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      connections.assertWritable(connId)
      const body = parse(dropSchema, req.body)
      const sql = await inspector.drop(connId, db, body)
      ctx.audit.log({
        actor: actor(req),
        action: `${body.kind}.drop`,
        target: `${body.schema}.${body.name}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/truncate',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      connections.assertWritable(connId)
      const body = parse(truncateSchema, req.body)
      const sql = await inspector.truncate(connId, db, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'table.truncate',
        target: `${body.schema}.${body.table}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  // ── DDL management ──────────────────────────────────────────────────────
  const guardWrite = (req: FastifyRequest) => {
    const { connId } = req.params as ConnParams
    connections.assertWritable(connId)
  }

  app.post(
    '/api/connections/:connId/db/:db/tables',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      guardWrite(req)
      const body = parse(createTableSchema, req.body)
      const sql = await inspector.createTable(connId, db, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'table.create',
        target: `${body.schema}.${body.name}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/tables/:schema/:table/alter',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db, schema, table } = req.params as TableParams
      guardWrite(req)
      const body = parse(alterTableSchema, req.body)
      const statements = await inspector.alterTable(connId, db, schema, table, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'table.alter',
        target: `${schema}.${table}`,
        connectionId: connId,
        database: db,
        details: statements.join(';\n'),
        ip: req.ip,
      })
      return { ok: true, statements }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/tables/:schema/:table/indexes',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db, schema, table } = req.params as TableParams
      guardWrite(req)
      const body = parse(createIndexSchema, req.body)
      const sql = await inspector.createIndex(connId, db, schema, table, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'index.create',
        target: `${schema}.${table}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/tables/:schema/:table/maintenance',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db, schema, table } = req.params as TableParams
      guardWrite(req)
      const body = parse(maintenanceSchema, req.body)
      const sql = await inspector.maintenance(connId, db, schema, table, body.op)
      ctx.audit.log({
        actor: actor(req),
        action: `maintenance.${body.op}`,
        target: `${schema}.${table}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/sequences',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      guardWrite(req)
      const body = parse(createSequenceSchema, req.body)
      const sql = await inspector.createSequence(connId, db, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'sequence.create',
        target: `${body.schema}.${body.name}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/sequences/restart',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      guardWrite(req)
      const body = parse(restartSequenceSchema, req.body)
      const sql = await inspector.restartSequence(connId, db, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'sequence.restart',
        target: `${body.schema}.${body.name}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    '/api/connections/:connId/db/:db/matviews/refresh',
    { preHandler: requireRole('editor') },
    async (req) => {
      const { connId, db } = req.params as DbParams
      guardWrite(req)
      const body = parse(refreshMatviewSchema, req.body)
      const sql = await inspector.refreshMatview(connId, db, body)
      ctx.audit.log({
        actor: actor(req),
        action: 'matview.refresh',
        target: `${body.schema}.${body.name}`,
        connectionId: connId,
        database: db,
        details: sql,
        ip: req.ip,
      })
      return { ok: true }
    },
  )
}
