import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PgRoleInfo, PgRoleInput } from '@pgforge/shared'
import { DbSwitcher } from '../../components/layout/DbSwitcher.js'
import { PathBar } from '../../components/layout/PathBar.js'
import { Badge, Button, Checkbox, EmptyState, Field, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog, Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'

export function RolesPage() {
  const { t } = useTranslation()
  const { connId, connection, db, setDb } = useWorkspace()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const [dialog, setDialog] = useState<
    | { kind: 'create' }
    | { kind: 'edit'; role: PgRoleInfo }
    | { kind: 'drop'; role: PgRoleInfo }
    | null
  >(null)

  const isAdmin = user?.role === 'admin'

  const roles = useQuery({
    queryKey: ['pg-roles', connId],
    queryFn: () => api<PgRoleInfo[]>(`/api/connections/${connId}/roles`),
  })

  const drop = useMutation({
    mutationFn: (name: string) =>
      api(`/api/connections/${connId}/roles/${encodeURIComponent(name)}/drop`, {
        body: { confirmName: name },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pg-roles', connId] })
      toast.ok(t('common.success'))
      setDialog(null)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const flags = (role: PgRoleInfo): string[] => {
    const list: string[] = []
    if (role.superuser) list.push('SUPERUSER')
    if (role.createDb) list.push('CREATEDB')
    if (role.createRole) list.push('CREATEROLE')
    if (role.replication) list.push('REPLICATION')
    if (role.bypassRls) list.push('BYPASSRLS')
    return list
  }

  return (
    <>
      <PathBar
        segments={[
          { kind: 'conn', label: connection.name },
          { kind: 'object', label: 'roles' },
        ]}
        actions={<DbSwitcher connId={connId} db={db} onChange={setDb} />}
      />
      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('roles.title')}</h1>
            <p className="page-sub">{t('roles.subtitle')}</p>
          </div>
          {isAdmin && (
            <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: 'create' })}>
              {t('roles.add')}
            </Button>
          )}
        </div>

        <div className="panel">
          {roles.data?.length === 0 ? (
            <EmptyState icon={KeyRound} title={t('roles.title')} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('roles.login')}</th>
                  <th>{t('roles.privileges')}</th>
                  <th>{t('roles.memberOf')}</th>
                  <th className="num">{t('roles.connLimit')}</th>
                  {isAdmin && <th style={{ width: 80 }} />}
                </tr>
              </thead>
              <tbody>
                {roles.data?.map((role) => (
                  <tr key={role.name}>
                    <td className="mono">{role.name}</td>
                    <td>
                      <Badge kind={role.login ? 'ok' : 'muted'}>
                        {role.login ? t('common.yes') : t('common.no')}
                      </Badge>
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                        {flags(role).map((flag) => (
                          <Badge key={flag} kind={flag === 'SUPERUSER' ? 'warn' : 'muted'}>
                            {flag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="mono muted truncate" style={{ maxWidth: 240 }}>
                      {role.memberOf.join(', ')}
                    </td>
                    <td className="num">{role.connLimit === -1 ? '∞' : role.connLimit}</td>
                    {isAdmin && (
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Pencil}
                            aria-label={t('common.edit')}
                            onClick={() => setDialog({ kind: 'edit', role })}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Trash2}
                            aria-label={t('common.delete')}
                            onClick={() => setDialog({ kind: 'drop', role })}
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
      </div>

      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <RoleDialog
          connId={connId}
          existing={dialog.kind === 'edit' ? dialog.role : null}
          allRoles={roles.data ?? []}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'drop' && (
        <ConfirmDialog
          title={t('roles.dropConfirmTitle')}
          typeToConfirm={dialog.role.name}
          loading={drop.isPending}
          onConfirm={() => drop.mutate(dialog.role.name)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

function RoleDialog({
  connId,
  existing,
  allRoles,
  onClose,
}: {
  connId: string
  existing: PgRoleInfo | null
  allRoles: PgRoleInfo[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<PgRoleInput>({
    name: existing?.name ?? '',
    password: '',
    login: existing?.login ?? true,
    superuser: existing?.superuser ?? false,
    createDb: existing?.createDb ?? false,
    createRole: existing?.createRole ?? false,
    replication: existing?.replication ?? false,
    connLimit: existing?.connLimit ?? -1,
    memberOf: existing?.memberOf ?? [],
  })

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, password: form.password || undefined }
      if (existing) {
        const { name: _name, ...update } = body
        return api(`/api/connections/${connId}/roles/${encodeURIComponent(existing.name)}`, {
          method: 'PATCH',
          body: update,
        })
      }
      return api(`/api/connections/${connId}/roles`, { body })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pg-roles', connId] })
      toast.ok(t('common.success'))
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const toggleMembership = (group: string, member: boolean) => {
    setForm((f) => ({
      ...f,
      memberOf: member ? [...(f.memberOf ?? []), group] : (f.memberOf ?? []).filter((g) => g !== group),
    }))
  }

  const candidateGroups = allRoles.filter((role) => role.name !== form.name)

  return (
    <Modal
      title={existing ? t('roles.edit') : t('roles.add')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!form.name} loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('common.name')}>
          <TextInput
            mono
            value={form.name}
            disabled={existing !== null}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoFocus={!existing}
          />
        </Field>
        <Field label={t('roles.password')} hint={existing ? t('roles.passwordKeep') : undefined}>
          <TextInput
            mono
            type="password"
            autoComplete="new-password"
            value={form.password ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
        </Field>
        <Field label={t('roles.connLimit')}>
          <TextInput
            type="number"
            min={-1}
            value={form.connLimit ?? -1}
            onChange={(e) => setForm((f) => ({ ...f, connLimit: Number(e.target.value) }))}
          />
        </Field>
        <div />
        <Checkbox label={t('roles.login')} checked={form.login} onChange={(v) => setForm((f) => ({ ...f, login: v }))} />
        <Checkbox
          label={t('roles.superuser')}
          checked={form.superuser}
          onChange={(v) => setForm((f) => ({ ...f, superuser: v }))}
        />
        <Checkbox
          label={t('roles.createDb')}
          checked={form.createDb}
          onChange={(v) => setForm((f) => ({ ...f, createDb: v }))}
        />
        <Checkbox
          label={t('roles.createRole')}
          checked={form.createRole}
          onChange={(v) => setForm((f) => ({ ...f, createRole: v }))}
        />
        <Checkbox
          label={t('roles.replication')}
          checked={form.replication}
          onChange={(v) => setForm((f) => ({ ...f, replication: v }))}
        />
      </div>
      {candidateGroups.length > 0 && (
        <Field label={t('roles.memberOf')}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {candidateGroups.map((group) => (
              <Checkbox
                key={group.name}
                label={<span className="mono">{group.name}</span>}
                checked={(form.memberOf ?? []).includes(group.name)}
                onChange={(v) => toggleMembership(group.name, v)}
              />
            ))}
          </div>
        </Field>
      )}
    </Modal>
  )
}
