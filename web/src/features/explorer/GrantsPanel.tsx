import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PgRoleInfo, TableGrants, TablePrivilegeKind } from '@pgforge/shared'
import { Button, Checkbox, Field, Select } from '../../components/ui/basics.js'
import { Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { toast } from '../../stores/toast.js'

const PRIVILEGES: TablePrivilegeKind[] = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
]

export function GrantsPanel({
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
  const queryClient = useQueryClient()
  const [granting, setGranting] = useState(false)
  const dbPath = `/api/connections/${connId}/db/${encodeURIComponent(db)}`

  const grants = useQuery({
    queryKey: ['grants', connId, db, schema, table],
    queryFn: () =>
      api<TableGrants[]>(`${dbPath}/grants/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`),
  })

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['grants', connId, db, schema, table] })

  const revoke = useMutation({
    mutationFn: (entry: TableGrants) =>
      api(`${dbPath}/grants/revoke`, {
        body: {
          role: entry.grantee,
          schema,
          table,
          privileges: entry.privileges.filter((p): p is TablePrivilegeKind =>
            (PRIVILEGES as string[]).includes(p),
          ),
        },
      }),
    onSuccess: () => {
      toast.ok(t('ddl.applied'))
      invalidate()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <div className="panel">
      <div className="panel-header">
        {t('roles.grants')}
        <Button size="sm" icon={Plus} onClick={() => setGranting(true)}>
          {t('roles.grant')}
        </Button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('roles.grantee')}</th>
            <th>{t('roles.privileges')}</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {grants.data?.map((entry) => (
            <tr key={entry.grantee}>
              <td className="mono">{entry.grantee}</td>
              <td className="mono muted">{entry.privileges.join(', ')}</td>
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={X}
                  aria-label={t('roles.revoke')}
                  title={t('roles.revoke')}
                  loading={revoke.isPending}
                  onClick={() => revoke.mutate(entry)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {granting && (
        <GrantDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          onDone={() => {
            setGranting(false)
            invalidate()
          }}
          onClose={() => setGranting(false)}
        />
      )}
    </div>
  )
}

function GrantDialog({
  connId,
  db,
  schema,
  table,
  onDone,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  table: string
  onDone: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [role, setRole] = useState('')
  const [privileges, setPrivileges] = useState<TablePrivilegeKind[]>(['SELECT'])

  const roles = useQuery({
    queryKey: ['pg-roles', connId],
    queryFn: () => api<PgRoleInfo[]>(`/api/connections/${connId}/roles`),
  })

  const grant = useMutation({
    mutationFn: () =>
      api(`/api/connections/${connId}/db/${encodeURIComponent(db)}/grants`, {
        body: { role, schema, table, privileges },
      }),
    onSuccess: () => {
      toast.ok(t('ddl.applied'))
      onDone()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={`${t('roles.grant')} — ${table}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!role || privileges.length === 0}
            loading={grant.isPending}
            onClick={() => grant.mutate()}
          >
            {t('roles.grant')}
          </Button>
        </>
      }
    >
      <Field label={t('roles.grantee')}>
        <Select className="mono" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">—</option>
          {roles.data?.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('roles.privileges')}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {PRIVILEGES.map((privilege) => (
            <Checkbox
              key={privilege}
              label={<span className="mono">{privilege}</span>}
              checked={privileges.includes(privilege)}
              onChange={(on) =>
                setPrivileges((prev) =>
                  on ? [...prev, privilege] : prev.filter((p) => p !== privilege),
                )
              }
            />
          ))}
        </div>
      </Field>
    </Modal>
  )
}
