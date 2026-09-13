import type { SavedQuery, SavedQueryInput } from '@pgforge/shared'
import { NotFoundError } from '../../core/errors.js'
import { newId, nowIso } from '../../core/util.js'
import type { MetaStore } from '../../infra/store.js'

const MAX_SQL = 200_000

interface Row {
  id: string
  owner_id: string
  owner_name: string | null
  name: string
  description: string | null
  sql: string
  connection_id: string | null
  shared: number
  created_at: string
  updated_at: string
}

const SELECT = `
  SELECT s.*, u.name AS owner_name
  FROM saved_queries s
  LEFT JOIN users u ON u.id = s.owner_id`

function toSaved(row: Row): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sql: row.sql,
    connectionId: row.connection_id,
    shared: row.shared === 1,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? '—',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SavedQueryRepo {
  constructor(private readonly store: MetaStore) {}

  /**
   * Own snippets plus everything shared. `connectionId` keeps the list relevant
   * to the workspace: snippets pinned to another connection are filtered out,
   * while unpinned ones stay visible everywhere.
   */
  list(userId: string, connectionId: string | undefined): SavedQuery[] {
    const rows = this.store.all<Row>(
      `${SELECT}
       WHERE (s.owner_id = :userId OR s.shared = 1)
         AND (:connectionId IS NULL OR s.connection_id IS NULL OR s.connection_id = :connectionId)
       ORDER BY s.name COLLATE NOCASE`,
      { userId, connectionId: connectionId ?? null },
    )
    return rows.map(toSaved)
  }

  byId(id: string): SavedQuery | undefined {
    const row = this.store.get<Row>(`${SELECT} WHERE s.id = :id`, { id })
    return row ? toSaved(row) : undefined
  }

  create(userId: string, input: SavedQueryInput): SavedQuery {
    const id = newId()
    const now = nowIso()
    this.store.run(
      `INSERT INTO saved_queries (id, owner_id, name, description, sql, connection_id, shared, created_at, updated_at)
       VALUES (:id, :ownerId, :name, :description, :sql, :connectionId, :shared, :now, :now)`,
      {
        id,
        ownerId: userId,
        name: input.name,
        description: input.description ?? null,
        sql: input.sql.slice(0, MAX_SQL),
        connectionId: input.connectionId ?? null,
        shared: input.shared ? 1 : 0,
        now,
      },
    )
    return this.byId(id)!
  }

  update(id: string, input: Partial<SavedQueryInput>): SavedQuery {
    const existing = this.byId(id)
    if (!existing) throw new NotFoundError('Saved query not found')
    this.store.run(
      `UPDATE saved_queries
       SET name = :name, description = :description, sql = :sql,
           connection_id = :connectionId, shared = :shared, updated_at = :now
       WHERE id = :id`,
      {
        id,
        name: input.name ?? existing.name,
        description: input.description === undefined ? existing.description : input.description,
        sql: (input.sql ?? existing.sql).slice(0, MAX_SQL),
        connectionId:
          input.connectionId === undefined ? existing.connectionId : input.connectionId,
        shared: (input.shared ?? existing.shared) ? 1 : 0,
        now: nowIso(),
      },
    )
    return this.byId(id)!
  }

  delete(id: string): void {
    const result = this.store.run('DELETE FROM saved_queries WHERE id = :id', { id })
    if (result.changes === 0) throw new NotFoundError('Saved query not found')
  }
}
