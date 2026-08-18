import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppRole, AppUser } from '@pgforge/shared'
import { Badge, Button, Field, Select, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog, Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { formatDate } from '../../lib/format.js'
import { useMeta } from '../../lib/queries.js'
import { LANGUAGES, setLanguage, type LangCode } from '../../i18n/index.js'
import { useAuthStore } from '../../stores/auth.js'
import { useThemeStore } from '../../stores/theme.js'
import { toast } from '../../stores/toast.js'
import { DeliveryPanel } from './DeliveryPanel.js'

export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const { theme, setTheme } = useThemeStore()
  const meta = useMeta()

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t('settings.title')}</h1>
      </div>

      <div className="panel">
        <div className="panel-header">{t('settings.appearance')}</div>
        <div className="row" style={{ padding: 14, gap: 16, flexWrap: 'wrap' }}>
          <Field label={t('common.theme')}>
            <Select
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
              style={{ width: 160 }}
            >
              <option value="dark">{t('common.themeDark')}</option>
              <option value="light">{t('common.themeLight')}</option>
            </Select>
          </Field>
          <Field label={t('common.language')}>
            <Select
              value={i18n.language}
              onChange={(e) => setLanguage(e.target.value as LangCode)}
              style={{ width: 160 }}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {user?.role === 'admin' && <UsersPanel />}
      {user?.role === 'admin' && <DeliveryPanel />}

      <div className="panel">
        <div className="panel-header">{t('settings.about')}</div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
          <div className="row">
            <span className="muted" style={{ width: 180 }}>{t('settings.version')}</span>
            <span className="mono">PgForge {meta.data?.version ?? '—'}</span>
          </div>
          <div className="row">
            <span className="muted" style={{ width: 180 }}>{t('settings.pgTools')}</span>
            <span className="mono">
              {meta.data?.pgToolsAvailable ? meta.data.pgToolsVersion : t('backup.toolsMissing')}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function UsersPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const currentUser = useAuthStore((s) => s.user)
  const [dialog, setDialog] = useState<
    { kind: 'create' } | { kind: 'edit'; user: AppUser } | { kind: 'delete'; user: AppUser } | null
  >(null)

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<AppUser[]>('/api/users'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      setDialog(null)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const roleBadge = (role: AppRole) => (
    <Badge kind={role === 'admin' ? 'warn' : role === 'editor' ? 'accent' : 'muted'}>
      {t(role === 'admin' ? 'settings.roleAdmin' : role === 'editor' ? 'settings.roleEditor' : 'settings.roleViewer')}
    </Badge>
  )

  return (
    <div className="panel">
      <div className="panel-header">
        {t('settings.users')}
        <Button size="sm" icon={Plus} onClick={() => setDialog({ kind: 'create' })}>
          {t('settings.addUser')}
        </Button>
      </div>
      <div style={{ padding: '8px 14px 0' }} className="muted">
        <span style={{ fontSize: 'var(--text-xs)' }}>{t('settings.roleHint')}</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('auth.email')}</th>
            <th>{t('settings.role')}</th>
            <th>{t('settings.lastLogin')}</th>
            <th style={{ width: 80 }} />
          </tr>
        </thead>
        <tbody>
          {users.data?.map((user) => (
            <tr key={user.id}>
              <td>{user.name}</td>
              <td className="mono">{user.email}</td>
              <td>{roleBadge(user.role)}</td>
              <td className="mono muted">{formatDate(user.lastLoginAt)}</td>
              <td>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Pencil}
                    aria-label={t('common.edit')}
                    onClick={() => setDialog({ kind: 'edit', user })}
                  />
                  {user.id !== currentUser?.id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Trash2}
                      aria-label={t('common.delete')}
                      onClick={() => setDialog({ kind: 'delete', user })}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <UserDialog existing={dialog.kind === 'edit' ? dialog.user : null} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('settings.deleteUserConfirm', { email: dialog.user.email })}
          loading={remove.isPending}
          onConfirm={() => remove.mutate(dialog.user.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

function UserDialog({ existing, onClose }: { existing: AppUser | null; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    email: existing?.email ?? '',
    password: '',
    role: existing?.role ?? ('viewer' as AppRole),
  })

  const save = useMutation({
    mutationFn: () => {
      if (existing) {
        const body: Record<string, string> = { name: form.name, email: form.email, role: form.role }
        if (form.password) body.password = form.password
        return api(`/api/users/${existing.id}`, { method: 'PATCH', body })
      }
      return api('/api/users', { body: form })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.ok(t('common.success'))
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={existing ? t('settings.editUser') : t('settings.addUser')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!form.name || !form.email || (!existing && form.password.length < 10)}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')}>
        <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
      </Field>
      <Field label={t('auth.email')}>
        <TextInput
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
      </Field>
      <Field label={t('auth.password')} hint={existing ? t('roles.passwordKeep') : undefined}>
        <TextInput
          type="password"
          autoComplete="new-password"
          minLength={10}
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
        />
      </Field>
      <Field label={t('settings.role')}>
        <Select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as AppRole }))}>
          <option value="viewer">{t('settings.roleViewer')}</option>
          <option value="editor">{t('settings.roleEditor')}</option>
          <option value="admin">{t('settings.roleAdmin')}</option>
        </Select>
      </Field>
    </Modal>
  )
}
