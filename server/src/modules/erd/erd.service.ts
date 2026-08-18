import type { ErdGraph } from '@pgforge/shared'
import type { AppContext } from '../../context.js'

export class ErdService {
  constructor(private readonly ctx: AppContext) {}

  graph(connId: string, db: string, schema: string): Promise<ErdGraph> {
    return this.ctx.pools.withClient(connId, db, async (c) => {
      const columns = await c.query(
        `SELECT n.nspname AS schema, t.relname AS table,
                greatest(t.reltuples, 0)::bigint::text AS row_estimate,
                a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                NOT a.attnotnull AS nullable,
                COALESCE((SELECT i.indisprimary FROM pg_index i
                          WHERE i.indrelid = t.oid AND a.attnum = ANY (i.indkey) AND i.indisprimary
                          LIMIT 1), false) AS pk
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid
         WHERE n.nspname = $1 AND t.relkind IN ('r', 'p')
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY t.relname, a.attnum`,
        [schema],
      )
      const relations = await c.query(
        `SELECT con.conname AS name,
                fn.nspname AS from_schema, ft.relname AS from_table,
                (SELECT array_agg(a.attname ORDER BY x.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS from_columns,
                tn.nspname AS to_schema, tt.relname AS to_table,
                (SELECT array_agg(a.attname ORDER BY x.ord)
                   FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS to_columns
         FROM pg_constraint con
         JOIN pg_class ft ON ft.oid = con.conrelid
         JOIN pg_namespace fn ON fn.oid = ft.relnamespace
         JOIN pg_class tt ON tt.oid = con.confrelid
         JOIN pg_namespace tn ON tn.oid = tt.relnamespace
         WHERE con.contype = 'f' AND (fn.nspname = $1 OR tn.nspname = $1)`,
        [schema],
      )

      const fkColumns = new Set<string>()
      for (const r of relations.rows) {
        for (const col of r.from_columns ?? []) {
          fkColumns.add(`${r.from_schema}.${r.from_table}.${col}`)
        }
      }

      const tableMap = new Map<string, { schema: string; name: string; rowEstimate: number; columns: ErdGraph['tables'][number]['columns'] }>()
      for (const r of columns.rows) {
        const key = `${r.schema}.${r.table}`
        let table = tableMap.get(key)
        if (!table) {
          table = { schema: r.schema, name: r.table, rowEstimate: Number(r.row_estimate), columns: [] }
          tableMap.set(key, table)
        }
        table.columns.push({
          name: r.column,
          type: r.type,
          pk: r.pk,
          fk: fkColumns.has(`${r.schema}.${r.table}.${r.column}`),
          nullable: r.nullable,
        })
      }

      return {
        tables: [...tableMap.values()],
        relations: relations.rows.map((r, i) => ({
          id: `${r.name}-${i}`,
          fromSchema: r.from_schema,
          fromTable: r.from_table,
          fromColumns: r.from_columns ?? [],
          toSchema: r.to_schema,
          toTable: r.to_table,
          toColumns: r.to_columns ?? [],
        })),
      }
    })
  }
}
