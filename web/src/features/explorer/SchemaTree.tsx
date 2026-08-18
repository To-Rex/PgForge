import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  Eye,
  FolderOpen,
  FunctionSquare,
  Hash,
  Layers,
  MoreHorizontal,
  Plus,
  Table2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { RelKind } from '@pgforge/shared'
import { Button, Checkbox, Field, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog, Modal, useMenu } from '../../components/ui/overlays.js'
import { QueryError } from '../../components/ui/QueryError.js'
import { api, ApiError } from '../../lib/api.js'
import { formatBytes, formatCompact, formatCount } from '../../lib/format.js'
import { useSchemas, useTables } from '../../lib/queries.js'
import { functionTemplate, stashSql, viewTemplate } from '../../lib/sql-handoff.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { CreateSequenceDialog, CreateTableDialog } from './ddl-dialogs.js'

export type TreeSelection =
  | { kind: 'relation'; schema: string; name: string; relKind: RelKind }
  | { kind: 'routines'; schema: string }
  | { kind: 'sequences'; schema: string }

const REL_ICON: Record<RelKind, typeof Table2> = {
  table: Table2,
  view: Eye,
  matview: Layers,
  foreign: Table2,
}

export function SchemaTree({
  connId,
  db,
  selectedSchema,
  selectedTable,
  selectedGroup,
  onSelect,
}: {
  connId: string
  db: string
  selectedSchema: string | null
  selectedTable: string | null
  selectedGroup: 'routines' | 'sequences' | null
  onSelect: (selection: TreeSelection) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const schemas = useSchemas(connId, db)
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(
    () => new Set(selectedSchema ? [selectedSchema] : ['public']),
  )
  const [filter, setFilter] = useState('')
  const [creatingSchema, setCreatingSchema] = useState(false)
  const [systemOpen, setSystemOpen] = useState(false)
  const [dialog, setDialog] = useState<
    | { kind: 'create-table'; schema: string }
    | { kind: 'create-sequence'; schema: string }
    | { kind: 'drop-schema'; schema: string }
    | null
  >(null)
  const [cascade, setCascade] = useState(false)
  const { open: openMenu, menu } = useMenu()
  const canEdit = user?.role !== 'viewer'

  const openInSql = (sql: string) => {
    stashSql(sql)
    navigate(`/c/${connId}/sql?db=${encodeURIComponent(db)}`)
  }

  const dropSchema = useMutation({
    mutationFn: (schema: string) =>
      api(`/api/connections/${connId}/db/${encodeURIComponent(db)}/drop`, {
        body: { kind: 'schema', schema, name: schema, cascade, confirmName: schema },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schemas', connId, db] })
      toast.ok(t('common.success'))
      setDialog(null)
      setCascade(false)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const schemaMenu = (e: React.MouseEvent, schema: string) => {
    openMenu(e, [
      { label: t('ddl.createTable'), onSelect: () => setDialog({ kind: 'create-table', schema }) },
      { label: t('ddl.createSequence'), onSelect: () => setDialog({ kind: 'create-sequence', schema }) },
      { label: t('ddl.newView'), onSelect: () => openInSql(viewTemplate(schema)) },
      { label: t('ddl.newFunction'), onSelect: () => openInSql(functionTemplate(schema)) },
      { label: t('ddl.dropSchema'), danger: true, onSelect: () => setDialog({ kind: 'drop-schema', schema }) },
    ])
  }

  const toggle = (name: string) => {
    setOpenSchemas((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const renderSchemaNode = (name: string, tableCount: number, showMenu: boolean) => (
    <div key={name}>
      <div className="row" style={{ gap: 0 }}>
        <button type="button" className="tree-node grow" onClick={() => toggle(name)}>
          <ChevronRight size={13} className={`caret${openSchemas.has(name) ? ' open' : ''}`} />
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
      {openSchemas.has(name) && (
        <div className="tree-children">
          <SchemaBranch
            connId={connId}
            db={db}
            schema={name}
            filter={filter.toLowerCase()}
            selectedSchema={selectedSchema}
            selectedTable={selectedTable}
            selectedGroup={selectedGroup}
            onSelect={onSelect}
          />
        </div>
      )}
    </div>
  )

  return (
    <div className="tree-pane">
      <div className="tree-search row">
        <TextInput
          placeholder={t('common.search')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ height: 26, fontSize: 'var(--text-xs)' }}
        />
        {user?.role !== 'viewer' && (
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            onClick={() => setCreatingSchema(true)}
            aria-label={t('db.createSchema')}
          />
        )}
      </div>
      <div className="tree-scroll">
        {schemas.isLoading && (
          <div className="row" style={{ padding: 12, justifyContent: 'center' }}>
            <span className="spinner" />
          </div>
        )}
        {schemas.isError && (
          <QueryError error={schemas.error} onRetry={() => void schemas.refetch()} />
        )}
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
      </div>
      {menu}
      {creatingSchema && (
        <CreateSchemaDialog connId={connId} db={db} onClose={() => setCreatingSchema(false)} />
      )}
      {dialog?.kind === 'create-table' && (
        <CreateTableDialog
          connId={connId}
          db={db}
          schema={dialog.schema}
          onClose={() => setDialog(null)}
          onCreated={(table) =>
            onSelect({ kind: 'relation', schema: dialog.schema, name: table, relKind: 'table' })
          }
        />
      )}
      {dialog?.kind === 'create-sequence' && (
        <CreateSequenceDialog
          connId={connId}
          db={db}
          schema={dialog.schema}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'drop-schema' && (
        <ConfirmDialog
          title={t('ddl.dropSchema')}
          typeToConfirm={dialog.schema}
          loading={dropSchema.isPending}
          onConfirm={() => dropSchema.mutate(dialog.schema)}
          onClose={() => {
            setDialog(null)
            setCascade(false)
          }}
        >
          <Checkbox label={t('common.cascadeHint')} checked={cascade} onChange={setCascade} />
        </ConfirmDialog>
      )}
    </div>
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
}: {
  connId: string
  db: string
  schema: string
  filter: string
  selectedSchema: string | null
  selectedTable: string | null
  selectedGroup: 'routines' | 'sequences' | null
  onSelect: (selection: TreeSelection) => void
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
      {visible?.map((rel) => {
        const Icon = REL_ICON[rel.kind]
        const active = selectedSchema === schema && selectedTable === rel.name
        const showRows = rel.kind === 'table' || rel.kind === 'matview'
        return (
          <button
            key={rel.name}
            type="button"
            className={`tree-node${active ? ' active' : ''}`}
            onClick={() => onSelect({ kind: 'relation', schema, name: rel.name, relKind: rel.kind })}
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
      })}
      <button
        type="button"
        className={`tree-node${selectedSchema === schema && selectedGroup === 'routines' ? ' active' : ''}`}
        onClick={() => onSelect({ kind: 'routines', schema })}
      >
        <span style={{ width: 13 }} />
        <FunctionSquare size={13} className="kind-icon" />
        <span className="label muted">{t('db.functions')}</span>
      </button>
      <button
        type="button"
        className={`tree-node${selectedSchema === schema && selectedGroup === 'sequences' ? ' active' : ''}`}
        onClick={() => onSelect({ kind: 'sequences', schema })}
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
      title={t('db.createSchema')}
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
