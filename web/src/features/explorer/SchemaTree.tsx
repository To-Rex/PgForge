import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  Database,
  Eye,
  FolderOpen,
  FunctionSquare,
  Hash,
  Layers,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Table2,
} from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { ConnectionSummary, CreateDatabaseInput, DatabaseInfo, RelKind } from '@pgforge/shared'
import { Button, Checkbox, Field, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog, Modal, useMenu, type MenuEntry } from '../../components/ui/overlays.js'
import { VirtualList } from '../../components/ui/VirtualList.js'
import { QueryError } from '../../components/ui/QueryError.js'
import { api, ApiError } from '../../lib/api.js'
import { formatBytes, formatCompact, formatCount } from '../../lib/format.js'
import { useDatabases, useSchemas, useTables } from '../../lib/queries.js'
import { functionTemplate, stashSql, viewTemplate } from '../../lib/sql-handoff.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { CreateSequenceDialog, CreateTableDialog } from './ddl-dialogs.js'

/** Every selection carries its database — the tree spans the whole server. */
export type TreeSelection =
  | { kind: 'relation'; db: string; schema: string; name: string; relKind: RelKind }
  | { kind: 'routines'; db: string; schema: string }
  | { kind: 'sequences'; db: string; schema: string }

type TreeDialog =
  | { kind: 'create-database' }
  | { kind: 'drop-database'; database: DatabaseInfo }
  | { kind: 'create-schema'; db: string }
  | { kind: 'create-table'; db: string; schema: string }
  | { kind: 'create-sequence'; db: string; schema: string }
  | { kind: 'drop-schema'; db: string; schema: string }

const REL_ICON: Record<RelKind, typeof Table2> = {
  table: Table2,
  view: Eye,
  matview: Layers,
  foreign: Table2,
}

/** Must match the fixed `.tree-node` height in app.css — windowing needs it exact. */
const TREE_ROW_HEIGHT = 24

/** Flat key set, so schema open-state stays distinct per database.
 *  Length-prefixed, so no database/schema name pair can collide. */
const schemaKey = (db: string, schema: string) => `${db.length}:${db}:${schema}`

export function SchemaTree({
  connId,
  connection,
  db,
  selectedSchema,
  selectedTable,
  selectedGroup,
  onSelect,
  onSelectDb,
}: {
  connId: string
  /** Required for the database level; omitted in single-database mode. */
  connection?: ConnectionSummary
  /** The database the content pane is currently bound to. */
  db: string
  selectedSchema: string | null
  selectedTable: string | null
  selectedGroup: 'routines' | 'sequences' | null
  onSelect: (selection: TreeSelection) => void
  /**
   * Opt in to the database level. Without it the tree is rooted at the schemas
   * of `db` alone — what backup inspection needs, since its scratch database is
   * the only one worth browsing.
   */
  onSelectDb?: (db: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const multiDb = onSelectDb !== undefined
  const databases = useDatabases(connId, multiDb)
  const [openDbs, setOpenDbs] = useState<Set<string>>(() => new Set([db]))
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(
    () => new Set([schemaKey(db, selectedSchema ?? 'public')]),
  )
  const [filter, setFilter] = useState('')
  const [dialog, setDialog] = useState<TreeDialog | null>(null)
  const [cascade, setCascade] = useState(false)
  const [force, setForce] = useState(false)
  const { open: openMenu, menu } = useMenu()
  // Shared scrollport: every relation list windows against this one element.
  const scrollRef = useRef<HTMLDivElement>(null)

  const canEdit = user?.role !== 'viewer'
  const writable = connection !== undefined && !connection.readOnly
  const canManageDb = canEdit && writable
  const isAdmin = user?.role === 'admin'

  // The database can also change from the header switcher or a pasted URL —
  // keep the active one expanded however it was chosen.
  useEffect(() => {
    setOpenDbs((prev) => (prev.has(db) ? prev : new Set(prev).add(db)))
    setOpenSchemas((prev) => {
      const key = schemaKey(db, 'public')
      return prev.has(key) ? prev : new Set(prev).add(key)
    })
  }, [db])

  const closeDialog = () => {
    setDialog(null)
    setCascade(false)
    setForce(false)
  }

  const toggleDb = (name: string) => {
    setOpenDbs((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // Clicking another database binds the workspace to it and reveals its schemas
  // in place — no trip to the switcher in the header.
  const clickDb = (name: string) => {
    if (name === db || !onSelectDb) {
      toggleDb(name)
      return
    }
    onSelectDb(name)
    setOpenDbs((prev) => new Set(prev).add(name))
    setOpenSchemas((prev) => new Set(prev).add(schemaKey(name, 'public')))
  }

  const toggleSchema = (dbName: string, schema: string) => {
    setOpenSchemas((prev) => {
      const next = new Set(prev)
      const key = schemaKey(dbName, schema)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const dropDatabase = useMutation({
    mutationFn: (target: DatabaseInfo) =>
      api(`/api/connections/${connId}/databases/${encodeURIComponent(target.name)}/drop`, {
        body: { force, confirmName: target.name },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['databases', connId] })
      void queryClient.invalidateQueries({ queryKey: ['overview', connId] })
      toast.ok(t('common.success'))
      closeDialog()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const dropSchema = useMutation({
    mutationFn: (target: { db: string; schema: string }) =>
      api(`/api/connections/${connId}/db/${encodeURIComponent(target.db)}/drop`, {
        body: {
          kind: 'schema',
          schema: target.schema,
          name: target.schema,
          cascade,
          confirmName: target.schema,
        },
      }),
    onSuccess: (_data, target) => {
      void queryClient.invalidateQueries({ queryKey: ['schemas', connId, target.db] })
      toast.ok(t('common.success'))
      closeDialog()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const dbMenu = (e: React.MouseEvent, database: DatabaseInfo) => {
    const entries: MenuEntry[] = [
      { label: t('db.switchDatabase'), onSelect: () => clickDb(database.name) },
    ]
    if (canEdit) {
      entries.push({
        label: t('db.createSchema'),
        onSelect: () => setDialog({ kind: 'create-schema', db: database.name }),
      })
    }
    entries.push({
      label: t('common.refresh'),
      onSelect: () => {
        void queryClient.invalidateQueries({ queryKey: ['schemas', connId, database.name] })
        void queryClient.invalidateQueries({ queryKey: ['databases', connId] })
      },
    })
    if (isAdmin && writable) {
      entries.push({
        label: t('db.dropDatabase'),
        danger: true,
        onSelect: () => setDialog({ kind: 'drop-database', database }),
      })
    }
    openMenu(e, entries)
  }

  const newMenu = (e: React.MouseEvent) => {
    const entries: MenuEntry[] = []
    if (canManageDb) {
      entries.push({
        label: t('db.createDatabase'),
        onSelect: () => setDialog({ kind: 'create-database' }),
      })
    }
    entries.push({ label: t('db.createSchema'), onSelect: () => setDialog({ kind: 'create-schema', db }) })
    openMenu(e, entries)
  }

  const list = databases.data ?? []
  // Keep the active database visible even before the list resolves, or when the
  // role cannot see it in pg_database.
  const rows: DatabaseInfo[] = list.some((d) => d.name === db)
    ? list
    : [
        {
          name: db,
          owner: '',
          encoding: '',
          collation: '',
          sizeBytes: null,
          isTemplate: false,
          connections: 0,
          comment: null,
        },
        ...list,
      ]

  return (
    <div className="tree-pane">
      <div className="tree-search row">
        <TextInput
          placeholder={t('common.search')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ height: 26, fontSize: 'var(--text-xs)' }}
        />
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            onClick={(e) =>
              multiDb ? newMenu(e) : setDialog({ kind: 'create-schema', db })
            }
            aria-label={multiDb ? t('common.create') : t('db.createSchema')}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          onClick={() => {
            if (multiDb) void databases.refetch()
            void queryClient.invalidateQueries({ queryKey: ['schemas', connId, db] })
          }}
          aria-label={t('common.refresh')}
        />
      </div>
      <div className="tree-scroll" ref={scrollRef}>
        {!multiDb && (
          <DatabaseBranch
            connId={connId}
            db={db}
            isCurrent
            filter={filter.toLowerCase()}
            canEdit={canEdit}
            openSchemas={openSchemas}
            onToggleSchema={toggleSchema}
            selectedSchema={selectedSchema}
            selectedTable={selectedTable}
            selectedGroup={selectedGroup}
            onSelect={onSelect}
            onDialog={setDialog}
            onMenu={openMenu}
            scrollParentRef={scrollRef}
          />
        )}
        {multiDb && databases.isLoading && (
          <div className="row" style={{ padding: 12, justifyContent: 'center' }}>
            <span className="spinner" />
          </div>
        )}
        {multiDb && databases.isError && (
          <QueryError error={databases.error} onRetry={() => void databases.refetch()} />
        )}
        {multiDb && rows.map((database) => {
          const isCurrent = database.name === db
          const isOpen = openDbs.has(database.name)
          // No CONNECT privilege — pg_database_size comes back null.
          const unreachable = database.sizeBytes === null && !isCurrent
          return (
            <div key={database.name}>
              <div className="row" style={{ gap: 0 }}>
                {/* Caret expands in place; the name also binds the workspace —
                    so another database can be inspected without leaving this one. */}
                <button
                  type="button"
                  className="tree-toggle"
                  onClick={() => toggleDb(database.name)}
                  aria-label={database.name}
                  aria-expanded={isOpen}
                >
                  <ChevronRight size={13} className={`caret${isOpen ? ' open' : ''}`} />
                </button>
                <button
                  type="button"
                  className={`tree-node db-node grow${isCurrent ? ' current' : ''}`}
                  onClick={() => clickDb(database.name)}
                  title={`${database.name}${database.owner ? ` · ${database.owner}` : ''}`}
                >
                  <Database size={13} className="kind-icon" style={{ color: 'var(--path-db)' }} />
                  <span className={`label${unreachable ? ' muted' : ''}`}>{database.name}</span>
                  <span className="meta">{formatBytes(database.sizeBytes)}</span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={MoreHorizontal}
                  aria-label={t('common.actions')}
                  onClick={(e) => dbMenu(e, database)}
                />
              </div>
              {isOpen && (
                <div className="tree-children">
                  <DatabaseBranch
                    connId={connId}
                    db={database.name}
                    isCurrent={isCurrent}
                    filter={filter.toLowerCase()}
                    canEdit={canEdit}
                    openSchemas={openSchemas}
                    onToggleSchema={toggleSchema}
                    selectedSchema={selectedSchema}
                    selectedTable={selectedTable}
                    selectedGroup={selectedGroup}
                    onSelect={onSelect}
                    onDialog={setDialog}
                    onMenu={openMenu}
                    scrollParentRef={scrollRef}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
      {menu}

      {dialog?.kind === 'create-database' && (
        <CreateDatabaseDialog
          connId={connId}
          onClose={closeDialog}
          onCreated={(name) => {
            closeDialog()
            clickDb(name)
          }}
        />
      )}
      {dialog?.kind === 'create-schema' && (
        <CreateSchemaDialog connId={connId} db={dialog.db} onClose={closeDialog} />
      )}
      {dialog?.kind === 'create-table' && (
        <CreateTableDialog
          connId={connId}
          db={dialog.db}
          schema={dialog.schema}
          onClose={closeDialog}
          onCreated={(table) =>
            onSelect({
              kind: 'relation',
              db: dialog.db,
              schema: dialog.schema,
              name: table,
              relKind: 'table',
            })
          }
        />
      )}
      {dialog?.kind === 'create-sequence' && (
        <CreateSequenceDialog
          connId={connId}
          db={dialog.db}
          schema={dialog.schema}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'drop-schema' && (
        <ConfirmDialog
          title={t('ddl.dropSchema')}
          typeToConfirm={dialog.schema}
          loading={dropSchema.isPending}
          onConfirm={() => dropSchema.mutate({ db: dialog.db, schema: dialog.schema })}
          onClose={closeDialog}
        >
          <Checkbox label={t('common.cascadeHint')} checked={cascade} onChange={setCascade} />
        </ConfirmDialog>
      )}
      {dialog?.kind === 'drop-database' && (
        <ConfirmDialog
          title={t('db.dropDatabase')}
          message={<span className="text-danger">{t('db.dropDatabaseWarning')}</span>}
          typeToConfirm={dialog.database.name}
          loading={dropDatabase.isPending}
          onConfirm={() => dropDatabase.mutate(dialog.database)}
          onClose={closeDialog}
        >
          <Checkbox label={t('db.forceDrop')} checked={force} onChange={setForce} />
        </ConfirmDialog>
      )}
    </div>
  )
}

/** Schemas of one database — mounted only while that database node is open. */
function DatabaseBranch({
  connId,
  db,
  isCurrent,
  filter,
  canEdit,
  openSchemas,
  onToggleSchema,
  selectedSchema,
  selectedTable,
  selectedGroup,
  onSelect,
  onDialog,
  onMenu,
  scrollParentRef,
}: {
  connId: string
  db: string
  /** Selection highlighting only applies inside the active database. */
  isCurrent: boolean
  filter: string
  canEdit: boolean
  openSchemas: Set<string>
  onToggleSchema: (db: string, schema: string) => void
  selectedSchema: string | null
  selectedTable: string | null
  selectedGroup: 'routines' | 'sequences' | null
  onSelect: (selection: TreeSelection) => void
  onDialog: (dialog: TreeDialog) => void
  onMenu: (e: React.MouseEvent, entries: MenuEntry[]) => void
  scrollParentRef: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const schemas = useSchemas(connId, db)
  const [systemOpen, setSystemOpen] = useState(false)

  const openInSql = (sql: string) => {
    stashSql(sql)
    navigate(`/c/${connId}/sql?db=${encodeURIComponent(db)}`)
  }

  const schemaMenu = (e: React.MouseEvent, schema: string) => {
    onMenu(e, [
      { label: t('ddl.createTable'), onSelect: () => onDialog({ kind: 'create-table', db, schema }) },
      {
        label: t('ddl.createSequence'),
        onSelect: () => onDialog({ kind: 'create-sequence', db, schema }),
      },
      { label: t('ddl.newView'), onSelect: () => openInSql(viewTemplate(schema)) },
      { label: t('ddl.newFunction'), onSelect: () => openInSql(functionTemplate(schema)) },
      {
        label: t('ddl.dropSchema'),
        danger: true,
        onSelect: () => onDialog({ kind: 'drop-schema', db, schema }),
      },
    ])
  }

  const renderSchemaNode = (name: string, tableCount: number, showMenu: boolean) => {
    const isOpen = openSchemas.has(schemaKey(db, name))
    return (
      <div key={name}>
        <div className="row" style={{ gap: 0 }}>
          <button type="button" className="tree-node grow" onClick={() => onToggleSchema(db, name)}>
            <ChevronRight size={13} className={`caret${isOpen ? ' open' : ''}`} />
            <FolderOpen size={13} className="kind-icon" style={{ color: 'var(--path-schema)' }} />
            <span className="label">{name}</span>
            <span className="meta">{tableCount}</span>
          </button>
          {showMenu && (
            <Button
              variant="ghost"
              size="sm"
              icon={MoreHorizontal}
              aria-label={t('common.actions')}
              onClick={(e) => schemaMenu(e, name)}
            />
          )}
        </div>
        {isOpen && (
          <div className="tree-children">
            <SchemaBranch
              connId={connId}
              db={db}
              schema={name}
              filter={filter}
              selectedSchema={isCurrent ? selectedSchema : null}
              selectedTable={isCurrent ? selectedTable : null}
              selectedGroup={isCurrent ? selectedGroup : null}
              onSelect={onSelect}
              scrollParentRef={scrollParentRef}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {schemas.isLoading && (
        <div className="row" style={{ padding: '4px 8px' }}>
          <span className="spinner" />
        </div>
      )}
      {schemas.isError && <QueryError error={schemas.error} onRetry={() => void schemas.refetch()} />}
      {schemas.data
        ?.filter((schema) => !schema.isSystem)
        .map((schema) => renderSchemaNode(schema.name, schema.tableCount, canEdit))}
      {(schemas.data?.some((schema) => schema.isSystem) ?? false) && (
        <>
          <button
            type="button"
            className="tree-node"
            onClick={() => setSystemOpen((v) => !v)}
            style={{ marginTop: 6 }}
          >
            <ChevronRight size={13} className={`caret${systemOpen ? ' open' : ''}`} />
            <FolderOpen size={13} className="kind-icon" />
            <span className="label muted">{t('db.systemSchemas')}</span>
          </button>
          {systemOpen &&
            schemas.data
              ?.filter((schema) => schema.isSystem)
              .map((schema) => renderSchemaNode(schema.name, schema.tableCount, false))}
        </>
      )}
    </>
  )
}

function SchemaBranch({
  connId,
  db,
  schema,
  filter,
  selectedSchema,
  selectedTable,
  selectedGroup,
  onSelect,
  scrollParentRef,
}: {
  connId: string
  db: string
  schema: string
  filter: string
  selectedSchema: string | null
  selectedTable: string | null
  selectedGroup: 'routines' | 'sequences' | null
  onSelect: (selection: TreeSelection) => void
  scrollParentRef: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const tables = useTables(connId, db, schema)

  const visible = tables.data?.filter((rel) => !filter || rel.name.toLowerCase().includes(filter))

  return (
    <>
      {tables.isLoading && (
        <div className="row" style={{ padding: '4px 8px' }}>
          <span className="spinner" />
        </div>
      )}
      {tables.isError && (
        <div className="text-danger" style={{ padding: '4px 8px', fontSize: 'var(--text-xs)' }}>
          {tables.error instanceof Error ? tables.error.message : t('errors.generic')}
        </div>
      )}
      {/* A schema with thousands of relations must not put thousands of rows in
          the DOM; below the threshold VirtualList renders them all as before. */}
      <VirtualList
        items={visible ?? []}
        itemHeight={TREE_ROW_HEIGHT}
        scrollParentRef={scrollParentRef}
        keyOf={(rel) => rel.name}
        renderItem={(rel) => {
          const Icon = REL_ICON[rel.kind]
          const active = selectedSchema === schema && selectedTable === rel.name
          const showRows = rel.kind === 'table' || rel.kind === 'matview'
          return (
            <button
              type="button"
              className={`tree-node${active ? ' active' : ''}`}
              onClick={() =>
                onSelect({ kind: 'relation', db, schema, name: rel.name, relKind: rel.kind })
              }
              title={
                `${rel.name} · ${formatBytes(rel.totalBytes)}` +
                (showRows ? ` · ~${formatCount(rel.rowEstimate)} ${t('common.rows')}` : '')
              }
            >
              <span style={{ width: 13 }} />
              <Icon size={13} className="kind-icon" />
              <span className="label">{rel.name}</span>
              {showRows && <span className="meta">{formatCompact(rel.rowEstimate)}</span>}
            </button>
          )
        }}
      />
      <button
        type="button"
        className={`tree-node${selectedSchema === schema && selectedGroup === 'routines' ? ' active' : ''}`}
        onClick={() => onSelect({ kind: 'routines', db, schema })}
      >
        <span style={{ width: 13 }} />
        <FunctionSquare size={13} className="kind-icon" />
        <span className="label muted">{t('db.functions')}</span>
      </button>
      <button
        type="button"
        className={`tree-node${selectedSchema === schema && selectedGroup === 'sequences' ? ' active' : ''}`}
        onClick={() => onSelect({ kind: 'sequences', db, schema })}
      >
        <span style={{ width: 13 }} />
        <Hash size={13} className="kind-icon" />
        <span className="label muted">{t('db.sequences')}</span>
      </button>
    </>
  )
}

function CreateSchemaDialog({
  connId,
  db,
  onClose,
}: {
  connId: string
  db: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api(`/api/connections/${connId}/db/${encodeURIComponent(db)}/schemas`, { body: { name } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schemas', connId, db] })
      toast.ok(t('common.success'))
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={`${t('db.createSchema')} · ${db}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!name} loading={create.isPending} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')}>
        <TextInput mono value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Modal>
  )
}

function CreateDatabaseDialog({
  connId,
  onClose,
  onCreated,
}: {
  connId: string
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<CreateDatabaseInput>({ name: '' })

  const create = useMutation({
    mutationFn: () =>
      api(`/api/connections/${connId}/databases`, {
        body: {
          name: form.name,
          owner: form.owner || undefined,
          template: form.template || undefined,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['databases', connId] })
      void queryClient.invalidateQueries({ queryKey: ['overview', connId] })
      toast.ok(t('common.success'))
      onCreated(form.name)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={t('db.createDatabase')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!form.name}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')}>
        <TextInput
          mono
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          autoFocus
        />
      </Field>
      <Field label={`${t('common.owner')} (${t('common.none').toLowerCase()} = current)`}>
        <TextInput
          mono
          value={form.owner ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
        />
      </Field>
      <Field label={t('db.template')}>
        <TextInput
          mono
          placeholder="template1"
          value={form.template ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
        />
      </Field>
    </Modal>
  )
}
