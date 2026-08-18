import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Eraser, Pencil, Plus, RefreshCcw, Trash2, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { ColumnInfo, DropKind, MaintenanceOp, TableStructure } from '@pgforge/shared'
import { Badge, Button, Checkbox } from '../../components/ui/basics.js'
import { ConfirmDialog, useMenu } from '../../components/ui/overlays.js'
import { QueryError } from '../../components/ui/QueryError.js'
import { api, ApiError } from '../../lib/api.js'
import { formatBytes, formatCount } from '../../lib/format.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import {
  CheckDialog,
  ColumnDialog,
  CreateIndexDialog,
  ForeignKeyDialog,
  RenameTableDialog,
  TableCommentDialog,
} from './ddl-dialogs.js'
import { GrantsPanel } from './GrantsPanel.js'

interface DropTarget {
  kind: DropKind
  name: string
  table?: string
}

export function StructureView({
  connId,
  db,
  schema,
  table,
}: {
  connId: string
  db: string
  schema: string
  table: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const [dropping, setDropping] = useState<DropTarget | null>(null)
  const [cascade, setCascade] = useState(false)
  const [truncating, setTruncating] = useState(false)
  const [restartIdentity, setRestartIdentity] = useState(false)
  const [ddlDialog, setDdlDialog] = useState<
    | { kind: 'add-column' }
    | { kind: 'edit-column'; column: ColumnInfo }
    | { kind: 'drop-column'; column: ColumnInfo }
    | { kind: 'create-index' }
    | { kind: 'rename' }
    | { kind: 'add-fk' }
    | { kind: 'add-check' }
    | { kind: 'edit-comment' }
    | { kind: 'drop-constraint'; name: string }
    | null
  >(null)
  const { open: openMenu, menu } = useMenu()

  const dbPath = `/api/connections/${connId}/db/${encodeURIComponent(db)}`
  const structure = useQuery({
    queryKey: ['structure', connId, db, schema, table],
    queryFn: () =>
      api<TableStructure>(`${dbPath}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/structure`),
  })

  const canEdit = user?.role !== 'viewer'

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['structure', connId, db, schema, table] })
    void queryClient.invalidateQueries({ queryKey: ['tables', connId, db, schema] })
    void queryClient.invalidateQueries({ queryKey: ['rows', connId, db, schema, table] })
  }

  const drop = useMutation({
    mutationFn: (target: DropTarget) =>
      api(`${dbPath}/drop`, {
        body: {
          kind: target.kind,
          schema,
          name: target.name,
          table: target.table,
          cascade,
          confirmName: target.name,
        },
      }),
    onSuccess: (_data, target) => {
      toast.ok(t('common.success'))
      setDropping(null)
      setCascade(false)
      if (target.kind === 'table' || target.kind === 'view' || target.kind === 'matview') {
        navigate(`/c/${connId}/explorer?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}`)
        void queryClient.invalidateQueries({ queryKey: ['tables', connId, db, schema] })
      } else {
        invalidateAll()
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const truncate = useMutation({
    mutationFn: () =>
      api(`${dbPath}/truncate`, {
        body: { schema, table, restartIdentity, cascade, confirmName: table },
      }),
    onSuccess: () => {
      toast.ok(t('common.success'))
      setTruncating(false)
      setCascade(false)
      invalidateAll()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const tablePath = `${dbPath}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`

  const maintenance = useMutation({
    mutationFn: (op: MaintenanceOp) => api(`${tablePath}/maintenance`, { body: { op } }),
    onSuccess: () => {
      toast.ok(t('ddl.applied'))
      invalidateAll()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const refreshMatview = useMutation({
    mutationFn: (concurrently: boolean) =>
      api(`${dbPath}/matviews/refresh`, { body: { schema, name: table, concurrently } }),
    onSuccess: () => {
      toast.ok(t('ddl.applied'))
      invalidateAll()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const dropColumn = useMutation({
    mutationFn: (column: string) =>
      api(`${tablePath}/alter`, { body: { actions: [{ kind: 'drop_column', column, cascade }] } }),
    onSuccess: () => {
      toast.ok(t('ddl.applied'))
      setDdlDialog(null)
      setCascade(false)
      invalidateAll()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const dropConstraint = useMutation({
    mutationFn: (name: string) =>
      api(`${tablePath}/alter`, { body: { actions: [{ kind: 'drop_constraint', name, cascade }] } }),
    onSuccess: () => {
      toast.ok(t('ddl.applied'))
      setDdlDialog(null)
      setCascade(false)
      invalidateAll()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const s = structure.data
  if (structure.isError) {
    return (
      <div className="page" style={{ paddingTop: 16 }}>
        <QueryError error={structure.error} onRetry={() => void structure.refetch()} />
      </div>
    )
  }
  if (structure.isLoading || !s) {
    return (
      <div className="row" style={{ padding: 24, justifyContent: 'center' }}>
        <span className="spinner" />
      </div>
    )
  }

  const relDropKind: DropKind = s.kind === 'view' ? 'view' : s.kind === 'matview' ? 'matview' : 'table'

  return (
    <div className="page" style={{ paddingTop: 16 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Badge kind="accent">{s.kind}</Badge>
        <span className="mono muted" style={{ fontSize: 'var(--text-xs)' }}>
          {t('explorer.rowEstimate')}: {formatCount(s.rowEstimate)} · {formatBytes(s.totalBytes)}
        </span>
        {(s.comment || (canEdit && s.kind === 'table')) && (
          <span className="row muted" style={{ fontSize: 'var(--text-xs)', gap: 4 }}>
            {s.comment && <span className="truncate" style={{ maxWidth: 280 }}>«{s.comment}»</span>}
            {canEdit && s.kind === 'table' && (
              <Button
                variant="ghost"
                size="sm"
                icon={Pencil}
                aria-label={t('ddl.editComment')}
                title={t('ddl.editComment')}
                onClick={() => setDdlDialog({ kind: 'edit-comment' })}
              />
            )}
          </span>
        )}
        <span className="grow" />
        {canEdit && s.kind === 'table' && (
          <>
            <Button size="sm" icon={Pencil} onClick={() => setDdlDialog({ kind: 'rename' })}>
              {t('ddl.rename')}
            </Button>
            <Button
              size="sm"
              icon={Wrench}
              loading={maintenance.isPending}
              onClick={(e) =>
                openMenu(e, [
                  { label: 'VACUUM', onSelect: () => maintenance.mutate('vacuum') },
                  { label: 'VACUUM (ANALYZE)', onSelect: () => maintenance.mutate('vacuum_analyze') },
                  { label: 'ANALYZE', onSelect: () => maintenance.mutate('analyze') },
                  { label: 'REINDEX', onSelect: () => maintenance.mutate('reindex') },
                ])
              }
            >
              {t('ddl.maintenance')}
            </Button>
            <Button size="sm" icon={Eraser} onClick={() => setTruncating(true)}>
              {t('explorer.truncate')}
            </Button>
          </>
        )}
        {canEdit && s.kind === 'matview' && (
          <Button
            size="sm"
            icon={RefreshCcw}
            loading={refreshMatview.isPending}
            onClick={(e) =>
              openMenu(e, [
                { label: t('ddl.refreshMatview'), onSelect: () => refreshMatview.mutate(false) },
                { label: t('ddl.refreshConcurrently'), onSelect: () => refreshMatview.mutate(true) },
              ])
            }
          >
            {t('ddl.refreshMatview')}
          </Button>
        )}
        {canEdit && (
          <Button
            size="sm"
            variant="danger-outline"
            icon={Trash2}
            onClick={() => setDropping({ kind: relDropKind, name: table })}
          >
            {t('explorer.dropObject', { kind: s.kind })}
          </Button>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          {t('db.columns')}
          {canEdit && s.kind === 'table' && (
            <Button size="sm" icon={Plus} onClick={() => setDdlDialog({ kind: 'add-column' })}>
              {t('ddl.addColumn')}
            </Button>
          )}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('common.type')}</th>
              <th>{t('explorer.nullable')}</th>
              <th>{t('explorer.default')}</th>
              {canEdit && s.kind === 'table' && <th style={{ width: 70 }} />}
            </tr>
          </thead>
          <tbody>
            {s.columns.map((col) => (
              <tr key={col.name}>
                <td className="mono">
                  {col.isPrimaryKey && <span style={{ color: 'var(--path-conn)' }}>⚷ </span>}
                  {col.name}
                </td>
                <td className="mono muted">{col.dataType}</td>
                <td className="muted">{col.nullable ? t('common.yes') : t('common.no')}</td>
                <td className="mono muted truncate" style={{ maxWidth: 260 }}>
                  {col.isIdentity ? 'IDENTITY' : col.default ?? ''}
                </td>
                {canEdit && s.kind === 'table' && (
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Pencil}
                        aria-label={t('ddl.editColumn')}
                        onClick={() => setDdlDialog({ kind: 'edit-column', column: col })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        aria-label={t('common.delete')}
                        disabled={s.columns.length === 1}
                        onClick={() => setDdlDialog({ kind: 'drop-column', column: col })}
                      />
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-header">
          {t('db.indexes')}
          {canEdit && s.kind === 'table' && (
            <Button size="sm" icon={Plus} onClick={() => setDdlDialog({ kind: 'create-index' })}>
              {t('ddl.createIndex')}
            </Button>
          )}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('common.definition')}</th>
              <th className="num">{t('common.size')}</th>
              <th className="num">{t('explorer.scans')}</th>
              {canEdit && <th style={{ width: 40 }} />}
            </tr>
          </thead>
          <tbody>
            {s.indexes.map((index) => (
              <tr key={index.name}>
                <td className="mono">{index.name}</td>
                <td className="mono muted truncate" style={{ maxWidth: 420 }} title={index.definition}>
                  {index.definition}
                </td>
                <td className="num">{formatBytes(index.sizeBytes)}</td>
                <td className="num">{formatCount(index.scans)}</td>
                {canEdit && (
                  <td>
                    {!index.isPrimary && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        aria-label={t('common.delete')}
                        onClick={() => setDropping({ kind: 'index', name: index.name })}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(s.foreignKeys.length > 0 || s.referencedBy.length > 0 || (canEdit && s.kind === 'table')) && (
        <div className="panel">
          <div className="panel-header">
            {t('explorer.foreignKeys')}
            {canEdit && s.kind === 'table' && (
              <Button size="sm" icon={Plus} onClick={() => setDdlDialog({ kind: 'add-fk' })}>
                {t('ddl.addForeignKey')}
              </Button>
            )}
          </div>
          <table className="table">
            <tbody>
              {s.foreignKeys.map((fk) => (
                <tr key={fk.name}>
                  <td className="mono">{fk.name}</td>
                  <td className="mono muted">
                    ({fk.columns.join(', ')}) → {fk.refSchema}.{fk.refTable} ({fk.refColumns.join(', ')})
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {fk.onDelete !== 'NO ACTION' ? `ON DELETE ${fk.onDelete}` : ''}
                  </td>
                  {canEdit && (
                    <td style={{ width: 40 }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        aria-label={t('common.delete')}
                        onClick={() => setDdlDialog({ kind: 'drop-constraint', name: fk.name })}
                      />
                    </td>
                  )}
                </tr>
              ))}
              {s.referencedBy.map((fk) => (
                <tr key={`in-${fk.name}`}>
                  <td className="mono muted">{t('explorer.referencedBy')}</td>
                  <td className="mono muted">
                    {fk.refSchema}.{fk.refTable} ({fk.refColumns.join(', ')}) → ({fk.columns.join(', ')})
                  </td>
                  <td />
                  {canEdit && <td />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {s.triggers.length > 0 && (
        <div className="panel">
          <div className="panel-header">{t('db.triggers')}</div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('explorer.timing')}</th>
                <th>{t('explorer.events')}</th>
                <th>{t('explorer.enabled')}</th>
                {canEdit && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {s.triggers.map((trigger) => (
                <tr key={trigger.name} title={trigger.definition}>
                  <td className="mono">{trigger.name}</td>
                  <td className="muted">{trigger.timing}</td>
                  <td className="mono muted">{trigger.events.join(', ')}</td>
                  <td>{trigger.enabled ? <Badge kind="ok">on</Badge> : <Badge kind="muted">off</Badge>}</td>
                  {canEdit && (
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        aria-label={t('common.delete')}
                        onClick={() => setDropping({ kind: 'trigger', name: trigger.name, table })}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(s.checks.length > 0 || (canEdit && s.kind === 'table')) && (
        <div className="panel">
          <div className="panel-header">
            {t('explorer.checks')}
            {canEdit && s.kind === 'table' && (
              <Button size="sm" icon={Plus} onClick={() => setDdlDialog({ kind: 'add-check' })}>
                {t('ddl.addCheck')}
              </Button>
            )}
          </div>
          <table className="table">
            <tbody>
              {s.checks.map((check) => (
                <tr key={check.name}>
                  <td className="mono">{check.name}</td>
                  <td className="mono muted">{check.definition}</td>
                  {canEdit && (
                    <td style={{ width: 40 }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        aria-label={t('common.delete')}
                        onClick={() => setDdlDialog({ kind: 'drop-constraint', name: check.name })}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {user?.role === 'admin' && s.kind === 'table' && (
        <GrantsPanel connId={connId} db={db} schema={schema} table={table} />
      )}

      <div className="panel">
        <div className="panel-header">
          DDL
          <Button
            size="sm"
            variant="ghost"
            icon={Copy}
            onClick={() => {
              void navigator.clipboard.writeText(s.ddl)
              toast.ok(t('common.copied'))
            }}
          >
            {t('common.copy')}
          </Button>
        </div>
        <pre className="ddl-block">{s.ddl}</pre>
      </div>

      {dropping && (
        <ConfirmDialog
          title={t('explorer.dropObject', { kind: dropping.kind })}
          typeToConfirm={dropping.name}
          loading={drop.isPending}
          onConfirm={() => drop.mutate(dropping)}
          onClose={() => {
            setDropping(null)
            setCascade(false)
          }}
        >
          <Checkbox label={t('common.cascadeHint')} checked={cascade} onChange={setCascade} />
        </ConfirmDialog>
      )}
      {truncating && (
        <ConfirmDialog
          title={t('explorer.truncate')}
          message={<span className="text-danger">{t('explorer.truncateWarning')}</span>}
          typeToConfirm={table}
          loading={truncate.isPending}
          onConfirm={() => truncate.mutate()}
          onClose={() => {
            setTruncating(false)
            setCascade(false)
          }}
        >
          <Checkbox label={t('explorer.restartIdentity')} checked={restartIdentity} onChange={setRestartIdentity} />
          <Checkbox label={t('common.cascadeHint')} checked={cascade} onChange={setCascade} />
        </ConfirmDialog>
      )}
      {menu}
      {(ddlDialog?.kind === 'add-column' || ddlDialog?.kind === 'edit-column') && (
        <ColumnDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          existing={ddlDialog.kind === 'edit-column' ? ddlDialog.column : null}
          onClose={() => setDdlDialog(null)}
        />
      )}
      {ddlDialog?.kind === 'drop-column' && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('ddl.dropColumnConfirm', { name: ddlDialog.column.name })}
          loading={dropColumn.isPending}
          onConfirm={() => dropColumn.mutate(ddlDialog.column.name)}
          onClose={() => {
            setDdlDialog(null)
            setCascade(false)
          }}
        >
          <Checkbox label={t('common.cascadeHint')} checked={cascade} onChange={setCascade} />
        </ConfirmDialog>
      )}
      {ddlDialog?.kind === 'create-index' && (
        <CreateIndexDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          columns={s.columns.map((col) => col.name)}
          onClose={() => setDdlDialog(null)}
        />
      )}
      {ddlDialog?.kind === 'rename' && (
        <RenameTableDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          onClose={() => setDdlDialog(null)}
          onRenamed={(newName) => {
            setDdlDialog(null)
            navigate(
              `/c/${connId}/explorer?db=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(newName)}&tab=structure`,
            )
          }}
        />
      )}
      {ddlDialog?.kind === 'add-fk' && (
        <ForeignKeyDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          columns={s.columns.map((col) => col.name)}
          onClose={() => setDdlDialog(null)}
        />
      )}
      {ddlDialog?.kind === 'add-check' && (
        <CheckDialog connId={connId} db={db} schema={schema} table={table} onClose={() => setDdlDialog(null)} />
      )}
      {ddlDialog?.kind === 'edit-comment' && (
        <TableCommentDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          initial={s.comment ?? ''}
          onClose={() => setDdlDialog(null)}
        />
      )}
      {ddlDialog?.kind === 'drop-constraint' && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('ddl.dropConstraint', { name: ddlDialog.name })}
          loading={dropConstraint.isPending}
          onConfirm={() => dropConstraint.mutate(ddlDialog.name)}
          onClose={() => {
            setDdlDialog(null)
            setCascade(false)
          }}
        >
          <Checkbox label={t('common.cascadeHint')} checked={cascade} onChange={setCascade} />
        </ConfirmDialog>
      )}
    </div>
  )
}
