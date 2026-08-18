import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FieldMeta, RowValues } from '@pgforge/shared'
import { Button, Checkbox } from '../../components/ui/basics.js'
import { Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { displayValue } from '../../lib/format.js'
import { toast } from '../../stores/toast.js'

interface CellDraft {
  value: string
  isNull: boolean
  /** Insert only: leave the column out so defaults apply. */
  useDefault: boolean
}

export function RowEditor({
  connId,
  db,
  schema,
  table,
  columns,
  primaryKey,
  existing,
  onDone,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  table: string
  columns: FieldMeta[]
  primaryKey: string[]
  existing: unknown[] | null
  onDone: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const isEdit = existing !== null
  const base = `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`

  const [drafts, setDrafts] = useState<Record<string, CellDraft>>(() => {
    const initial: Record<string, CellDraft> = {}
    columns.forEach((col, i) => {
      const value = existing?.[i]
      initial[col.name] = {
        value: existing ? displayValue(value) : '',
        isNull: existing ? value === null : false,
        useDefault: !existing,
      }
    })
    return initial
  })

  const setDraft = (name: string, patch: Partial<CellDraft>) => {
    setDrafts((prev) => ({ ...prev, [name]: { ...prev[name]!, ...patch } }))
  }

  const buildValues = (): RowValues => {
    const values: RowValues = {}
    for (const col of columns) {
      const draft = drafts[col.name]!
      if (!isEdit && draft.useDefault) continue
      values[col.name] = draft.isNull ? null : draft.value
    }
    return values
  }

  const save = useMutation({
    mutationFn: () => {
      if (isEdit) {
        const pk: RowValues = {}
        primaryKey.forEach((name) => {
          const idx = columns.findIndex((c) => c.name === name)
          pk[name] = existing![idx]
        })
        return api(`${base}/rows/update`, { body: { pk, changes: buildValues() } })
      }
      return api(`${base}/rows/insert`, { body: { values: buildValues() } })
    },
    onSuccess: () => {
      toast.ok(t('common.success'))
      onDone()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  return (
    <Modal
      title={isEdit ? t('explorer.editRow') : t('explorer.insertRow')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '55vh', overflowY: 'auto' }}>
        {columns.map((col) => {
          const draft = drafts[col.name]!
          const disabled = draft.isNull || (!isEdit && draft.useDefault)
          return (
            <div key={col.name} className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ width: 170, flexShrink: 0, paddingTop: 5 }}>
                <div className="mono" style={{ fontSize: 'var(--text-sm)' }}>
                  {col.name}
                  {primaryKey.includes(col.name) && (
                    <span style={{ color: 'var(--path-conn)' }}> ⚷</span>
                  )}
                </div>
                <div className="faint" style={{ fontSize: 'var(--text-xs)' }}>
                  {col.dataType}
                </div>
              </div>
              <textarea
                className="textarea grow"
                rows={draft.value.includes('\n') ? 3 : 1}
                value={draft.isNull ? '' : draft.value}
                disabled={disabled && draft.isNull}
                placeholder={draft.isNull ? 'NULL' : !isEdit && draft.useDefault ? 'DEFAULT' : ''}
                onChange={(e) => setDraft(col.name, { value: e.target.value, useDefault: false, isNull: false })}
              />
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
                <Checkbox
                  label="NULL"
                  checked={draft.isNull}
                  onChange={(v) => setDraft(col.name, { isNull: v, useDefault: false })}
                />
                {!isEdit && (
                  <Checkbox
                    label="DEFAULT"
                    checked={draft.useDefault}
                    onChange={(v) => setDraft(col.name, { useDefault: v, isNull: false })}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
