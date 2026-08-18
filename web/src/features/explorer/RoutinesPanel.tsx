import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, FunctionSquare, Hash, Plus, RotateCcw, SquarePen, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { RoutineInfo, SequenceInfo } from '@pgforge/shared'
import { Badge, Button, EmptyState } from '../../components/ui/basics.js'
import { ConfirmDialog } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { functionTemplate, stashSql } from '../../lib/sql-handoff.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { CreateSequenceDialog, RestartSequenceDialog } from './ddl-dialogs.js'

export function RoutinesPanel({ connId, db, schema }: { connId: string; db: string; schema: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dropping, setDropping] = useState<RoutineInfo | null>(null)

  const openInSql = (sql: string) => {
    stashSql(sql)
    navigate(`/c/${connId}/sql?db=${encodeURIComponent(db)}`)
  }

  const dbPath = `/api/connections/${connId}/db/${encodeURIComponent(db)}`
  const routines = useQuery({
    queryKey: ['routines', connId, db, schema],
    queryFn: () => api<RoutineInfo[]>(`${dbPath}/schemas/${encodeURIComponent(schema)}/routines`),
  })

  const drop = useMutation({
    mutationFn: (routine: RoutineInfo) =>
      api(`${dbPath}/drop`, {
        body: {
          kind: routine.kind,
          schema,
          name: routine.name,
          args: routine.arguments,
          confirmName: routine.name,
        },
      }),
    onSuccess: () => {
      toast.ok(t('common.success'))
      setDropping(null)
      void queryClient.invalidateQueries({ queryKey: ['routines', connId, db, schema] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  if (routines.data?.length === 0) {
    return <EmptyState icon={FunctionSquare} title={t('db.functions')} hint="—" />
  }

  return (
    <div className="page" style={{ paddingTop: 16 }}>
      <div className="panel">
        <div className="panel-header">
          {`${t('db.functions')} / ${t('db.procedures')}`}
          {user?.role !== 'viewer' && (
            <Button size="sm" icon={Plus} onClick={() => openInSql(functionTemplate(schema))}>
              {t('ddl.newFunction')}
            </Button>
          )}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>{t('common.name')}</th>
              <th>{t('common.type')}</th>
              <th>{t('explorer.returns')}</th>
              <th>{t('explorer.language')}</th>
              {user?.role !== 'viewer' && <th style={{ width: 40 }} />}
            </tr>
          </thead>
          <tbody>
            {routines.data?.map((routine) => {
              const key = `${routine.name}(${routine.arguments})`
              const open = expanded === key
              return (
                <RoutineRow
                  key={key}
                  routine={routine}
                  open={open}
                  canEdit={user?.role !== 'viewer'}
                  onToggle={() => setExpanded(open ? null : key)}
                  onDrop={() => setDropping(routine)}
                  onEdit={() => openInSql(routine.definition)}
                />
              )
            })}
          </tbody>
        </table>
        {routines.isLoading && (
          <div className="row" style={{ padding: 16, justifyContent: 'center' }}>
            <span className="spinner" />
          </div>
        )}
      </div>
      {dropping && (
        <ConfirmDialog
          title={t('explorer.dropObject', { kind: dropping.kind })}
          message={<code>{`${dropping.name}(${dropping.arguments})`}</code>}
          typeToConfirm={dropping.name}
          loading={drop.isPending}
          onConfirm={() => drop.mutate(dropping)}
          onClose={() => setDropping(null)}
        />
      )}
    </div>
  )
}

function RoutineRow({
  routine,
  open,
  canEdit,
  onToggle,
  onDrop,
  onEdit,
}: {
  routine: RoutineInfo
  open: boolean
  canEdit: boolean
  onToggle: () => void
  onDrop: () => void
  onEdit: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td style={{ width: 24 }}>
          <ChevronRight
            size={13}
            style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}
          />
        </td>
        <td className="mono">
          {routine.name}
          <span className="faint">({routine.arguments})</span>
        </td>
        <td>
          <Badge kind={routine.kind === 'function' ? 'accent' : 'warn'}>{routine.kind}</Badge>
        </td>
        <td className="mono muted">{routine.returnType}</td>
        <td className="muted">{routine.language}</td>
        {canEdit && (
          <td onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
              <Button
                variant="ghost"
                size="sm"
                icon={SquarePen}
                aria-label={t('ddl.editInSql')}
                title={t('ddl.editInSql')}
                onClick={onEdit}
              />
              <Button variant="ghost" size="sm" icon={Trash2} aria-label="drop" onClick={onDrop} />
            </div>
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={canEdit ? 6 : 5} style={{ padding: 0 }}>
            <pre className="ddl-block" style={{ maxHeight: 320 }}>{routine.definition}</pre>
          </td>
        </tr>
      )}
    </>
  )
}

export function SequencesPanel({ connId, db, schema }: { connId: string; db: string; schema: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const [dropping, setDropping] = useState<SequenceInfo | null>(null)
  const [creating, setCreating] = useState(false)
  const [restarting, setRestarting] = useState<SequenceInfo | null>(null)

  const dbPath = `/api/connections/${connId}/db/${encodeURIComponent(db)}`
  const sequences = useQuery({
    queryKey: ['sequences', connId, db, schema],
    queryFn: () => api<SequenceInfo[]>(`${dbPath}/schemas/${encodeURIComponent(schema)}/sequences`),
  })

  const drop = useMutation({
    mutationFn: (seq: SequenceInfo) =>
      api(`${dbPath}/drop`, {
        body: { kind: 'sequence', schema, name: seq.name, confirmName: seq.name },
      }),
    onSuccess: () => {
      toast.ok(t('common.success'))
      setDropping(null)
      void queryClient.invalidateQueries({ queryKey: ['sequences', connId, db, schema] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <div className="page" style={{ paddingTop: 16 }}>
      <div className="panel">
        <div className="panel-header">
          {t('db.sequences')}
          {user?.role !== 'viewer' && (
            <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
              {t('ddl.createSequence')}
            </Button>
          )}
        </div>
        {sequences.data?.length === 0 ? (
          <EmptyState icon={Hash} title={t('db.sequences')} hint="—" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.type')}</th>
                <th className="num">last_value</th>
                <th className="num">increment</th>
                {user?.role !== 'viewer' && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {sequences.data?.map((seq) => (
                <tr key={seq.name}>
                  <td className="mono">{seq.name}</td>
                  <td className="mono muted">{seq.dataType}</td>
                  <td className="num">{seq.lastValue ?? '—'}</td>
                  <td className="num">{seq.increment}</td>
                  {user?.role !== 'viewer' && (
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={RotateCcw}
                          aria-label={t('ddl.restartSequence')}
                          title={t('ddl.restartSequence')}
                          onClick={() => setRestarting(seq)}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          aria-label="drop"
                          onClick={() => setDropping(seq)}
                        />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {dropping && (
        <ConfirmDialog
          title={t('explorer.dropObject', { kind: 'sequence' })}
          typeToConfirm={dropping.name}
          loading={drop.isPending}
          onConfirm={() => drop.mutate(dropping)}
          onClose={() => setDropping(null)}
        />
      )}
      {creating && (
        <CreateSequenceDialog connId={connId} db={db} schema={schema} onClose={() => setCreating(false)} />
      )}
      {restarting && (
        <RestartSequenceDialog
          connId={connId}
          db={db}
          schema={schema}
          name={restarting.name}
          onClose={() => setRestarting(null)}
        />
      )}
    </div>
  )
}
