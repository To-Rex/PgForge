import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionInput, ConnectionSummary, ConnectionTestResult, SslMode } from '@pgforge/shared'
import { Button, Checkbox, Field, Select, TextInput } from '../../components/ui/basics.js'
import { Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { toast } from '../../stores/toast.js'

const SSL_MODES: SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full']
const COLORS = ['#5b9bd1', '#57b58a', '#c9a554', '#d26a5c', '#b18ad1', '#6fbfbf']

export function ConnectionDialog({
  existing,
  onClose,
}: {
  existing: ConnectionSummary | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ConnectionInput>({
    name: existing?.name ?? '',
    host: existing?.host ?? 'localhost',
    port: existing?.port ?? 5432,
    username: existing?.username ?? 'postgres',
    password: '',
    defaultDatabase: existing?.defaultDatabase ?? 'postgres',
    sslMode: existing?.sslMode ?? 'disable',
    color: existing?.color ?? COLORS[0],
    readOnly: existing?.readOnly ?? false,
  })
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)

  const set = <K extends keyof ConnectionInput>(key: K, value: ConnectionInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setTestResult(null)
  }

  const save = useMutation({
    mutationFn: () => {
      const body: ConnectionInput = { ...form }
      if (existing && !body.password) delete body.password
      return existing
        ? api<ConnectionSummary>(`/api/connections/${existing.id}`, { method: 'PUT', body })
        : api<ConnectionSummary>('/api/connections', { body })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] })
      toast.ok(t('common.success'))
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const test = useMutation({
    mutationFn: () =>
      api<ConnectionTestResult>('/api/connections/test', {
        body: existing ? { id: existing.id, config: form } : { config: form },
      }),
    onSuccess: setTestResult,
    onError: (err) =>
      setTestResult({ ok: false, error: err instanceof ApiError ? err.message : String(err) }),
  })

  return (
    <Modal
      title={existing ? t('conn.edit') : t('conn.add')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={test.isPending} onClick={() => test.mutate()}>
            {t('conn.test')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!form.name || !form.host || (!existing && !form.password)}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('common.name')}>
          <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label={t('conn.color')}>
          <div className="row">
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => set('color', color)}
                aria-label={color}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: color,
                  cursor: 'pointer',
                  border:
                    form.color === color ? '2px solid var(--text)' : '2px solid transparent',
                }}
              />
            ))}
          </div>
        </Field>
        <Field label={t('conn.host')}>
          <TextInput mono value={form.host} onChange={(e) => set('host', e.target.value)} />
        </Field>
        <Field label={t('conn.port')}>
          <TextInput
            mono
            type="number"
            value={form.port}
            onChange={(e) => set('port', Number(e.target.value))}
          />
        </Field>
        <Field label={t('conn.username')}>
          <TextInput mono value={form.username} onChange={(e) => set('username', e.target.value)} />
        </Field>
        <Field
          label={t('conn.password')}
          hint={existing ? t('conn.passwordKeep') : undefined}
        >
          <TextInput
            mono
            type="password"
            autoComplete="new-password"
            value={form.password ?? ''}
            onChange={(e) => set('password', e.target.value)}
          />
        </Field>
        <Field label={t('conn.database')}>
          <TextInput
            mono
            value={form.defaultDatabase}
            onChange={(e) => set('defaultDatabase', e.target.value)}
          />
        </Field>
        <Field label={t('conn.sslMode')}>
          <Select value={form.sslMode} onChange={(e) => set('sslMode', e.target.value as SslMode)}>
            {SSL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>
        </Field>
        <div className="span-2">
          <Checkbox
            label={
              <>
                {t('conn.readOnly')}
                <span className="muted"> — {t('conn.readOnlyHint')}</span>
              </>
            }
            checked={form.readOnly ?? false}
            onChange={(v) => set('readOnly', v)}
          />
        </div>
      </div>
      {testResult && (
        <div
          className="row mono"
          style={{
            fontSize: 'var(--text-sm)',
            color: testResult.ok ? 'var(--ok)' : 'var(--danger)',
          }}
        >
          {testResult.ok
            ? `✓ ${t('conn.testOk', { ms: testResult.latencyMs })} — ${testResult.serverVersion?.split(' on ')[0]}`
            : `✗ ${testResult.error}`}
        </div>
      )}
    </Modal>
  )
}
