import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AlterTableAction,
  ColumnInfo,
  CreateIndexInput,
  CreateSequenceInput,
  FkRefAction,
  IndexMethod,
  NewColumnSpec,
  TableStructure,
} from '@pgforge/shared'
import { Button, Checkbox, Field, Select, TextInput } from '../../components/ui/basics.js'
import { Modal } from '../../components/ui/overlays.js'
import { api, ApiError } from '../../lib/api.js'
import { getAuthHeader } from '../../lib/auth-header.js'
import { useSchemas, useTables } from '../../lib/queries.js'
import { toast } from '../../stores/toast.js'

const FK_ACTIONS: FkRefAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

const COMMON_TYPES = [
  'bigserial', 'bigint', 'serial', 'integer', 'smallint', 'text', 'varchar(255)',
  'boolean', 'numeric(12,2)', 'double precision', 'date', 'timestamptz', 'time',
  'uuid', 'jsonb', 'bytea', 'inet',
]

const INDEX_METHODS: IndexMethod[] = ['btree', 'hash', 'gin', 'gist', 'brin']

function TypeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <TextInput mono list="pgforge-types" value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id="pgforge-types">
        {COMMON_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </>
  )
}

function useDdlMutation(
  connId: string,
  db: string,
  schema: string,
  table: string | null,
  onDone: () => void,
) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['tables', connId, db, schema] })
      void queryClient.invalidateQueries({ queryKey: ['autocomplete', connId, db] })
      void queryClient.invalidateQueries({ queryKey: ['sequences', connId, db, schema] })
      if (table) {
        void queryClient.invalidateQueries({ queryKey: ['structure', connId, db, schema, table] })
        void queryClient.invalidateQueries({ queryKey: ['rows', connId, db, schema, table] })
      }
    },
    onOk: () => {
      toast.ok(t('ddl.applied'))
      onDone()
    },
    onErr: (err: unknown) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  }
}

// ── Create table ────────────────────────────────────────────────────────────

interface DraftColumn extends NewColumnSpec {
  key: number
}

let draftKey = 1

export function CreateTableDialog({
  connId,
  db,
  schema,
  onClose,
  onCreated,
}: {
  connId: string
  db: string
  schema: string
  onClose: () => void
  onCreated: (table: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [columns, setColumns] = useState<DraftColumn[]>([
    { key: draftKey++, name: 'id', type: 'bigserial', nullable: false, primaryKey: true },
  ])
  const helpers = useDdlMutation(connId, db, schema, null, onClose)

  const create = useMutation({
    mutationFn: () =>
      api(`/api/connections/${connId}/db/${encodeURIComponent(db)}/tables`, {
        body: {
          schema,
          name,
          columns: columns.map(({ key: _key, ...spec }) => ({
            ...spec,
            default: spec.default?.trim() || undefined,
          })),
        },
      }),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
      onCreated(name)
    },
    onError: helpers.onErr,
  })

  const patchColumn = (key: number, patch: Partial<DraftColumn>) => {
    setColumns((cols) => cols.map((c) => (c.key === key ? { ...c, ...patch } : c)))
  }

  const valid = name.trim().length > 0 && columns.length > 0 && columns.every((c) => c.name && c.type)

  return (
    <Modal
      title={`${t('ddl.createTable')} — ${schema}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')}>
        <TextInput mono value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <div className="field-label">{t('ddl.columns')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '45vh', overflowY: 'auto' }}>
        {columns.map((col) => (
          <div key={col.key} className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <TextInput
              mono
              placeholder={t('ddl.columnName')}
              value={col.name}
              onChange={(e) => patchColumn(col.key, { name: e.target.value })}
              style={{ width: 150 }}
            />
            <div style={{ width: 170 }}>
              <TypeInput value={col.type} onChange={(type) => patchColumn(col.key, { type })} />
            </div>
            <TextInput
              mono
              placeholder={t('ddl.defaultExpr')}
              value={col.default ?? ''}
              onChange={(e) => patchColumn(col.key, { default: e.target.value })}
              style={{ width: 150 }}
            />
            <Checkbox
              label="PK"
              checked={col.primaryKey ?? false}
              onChange={(v) => patchColumn(col.key, { primaryKey: v, nullable: v ? false : col.nullable })}
            />
            <Checkbox
              label="NULL"
              checked={col.nullable}
              onChange={(v) => patchColumn(col.key, { nullable: v })}
              disabled={col.primaryKey}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              aria-label={t('common.delete')}
              disabled={columns.length === 1}
              onClick={() => setColumns((cols) => cols.filter((c) => c.key !== col.key))}
            />
          </div>
        ))}
      </div>
      <Button
        size="sm"
        icon={Plus}
        onClick={() =>
          setColumns((cols) => [...cols, { key: draftKey++, name: '', type: 'text', nullable: true }])
        }
      >
        {t('ddl.addColumn')}
      </Button>
    </Modal>
  )
}

// ── Add / edit column ───────────────────────────────────────────────────────

export function ColumnDialog({
  connId,
  db,
  schema,
  table,
  existing,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  table: string
  /** null = add a new column. */
  existing: ColumnInfo | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(existing?.name ?? '')
  const [type, setType] = useState(existing?.dataType ?? 'text')
  const [nullable, setNullable] = useState(existing?.nullable ?? true)
  const [defaultExpr, setDefaultExpr] = useState(existing?.default ?? '')
  const [comment, setComment] = useState(existing?.comment ?? '')
  const [using, setUsing] = useState('')
  const helpers = useDdlMutation(connId, db, schema, table, onClose)

  const buildActions = (): AlterTableAction[] => {
    if (!existing) {
      const actions: AlterTableAction[] = [
        {
          kind: 'add_column',
          spec: { name, type, nullable, default: defaultExpr.trim() || undefined },
        },
      ]
      if (comment.trim()) {
        actions.push({ kind: 'set_comment', target: 'column', column: name, comment: comment.trim() })
      }
      return actions
    }
    const actions: AlterTableAction[] = []
    if (type.trim() !== existing.dataType) {
      actions.push({ kind: 'set_type', column: existing.name, type, using: using.trim() || undefined })
    }
    if (nullable !== existing.nullable) {
      actions.push({ kind: nullable ? 'drop_not_null' : 'set_not_null', column: existing.name })
    }
    const oldDefault = existing.default ?? ''
    if (defaultExpr.trim() !== oldDefault.trim()) {
      actions.push(
        defaultExpr.trim()
          ? { kind: 'set_default', column: existing.name, expression: defaultExpr.trim() }
          : { kind: 'drop_default', column: existing.name },
      )
    }
    if (comment.trim() !== (existing.comment ?? '').trim()) {
      actions.push({
        kind: 'set_comment',
        target: 'column',
        column: existing.name,
        comment: comment.trim() || null,
      })
    }
    // Rename last so earlier actions address the original column name.
    if (name !== existing.name) {
      actions.push({ kind: 'rename_column', column: existing.name, newName: name })
    }
    return actions
  }

  const actions = buildActions()
  const apply = useMutation({
    mutationFn: () =>
      api(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/alter`,
        { body: { actions } },
      ),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
    },
    onError: helpers.onErr,
  })

  const typeChanged = existing !== null && type.trim() !== existing.dataType

  return (
    <Modal
      title={existing ? `${t('ddl.editColumn')} — ${existing.name}` : t('ddl.addColumn')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!name || !type || actions.length === 0}
            loading={apply.isPending}
            onClick={() => apply.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('ddl.columnName')}>
        <TextInput mono value={name} onChange={(e) => setName(e.target.value)} autoFocus={!existing} />
      </Field>
      <Field label={t('ddl.columnType')}>
        <TypeInput value={type} onChange={setType} />
      </Field>
      {typeChanged && (
        <Field label={t('ddl.usingExpr')} hint={`USING ${existing.name}::${type}`}>
          <TextInput mono value={using} onChange={(e) => setUsing(e.target.value)} />
        </Field>
      )}
      <Field label={t('ddl.defaultExpr')}>
        <TextInput mono value={defaultExpr} onChange={(e) => setDefaultExpr(e.target.value)} />
      </Field>
      <Field label={t('ddl.commentLabel')}>
        <TextInput value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <Checkbox label={t('explorer.nullable')} checked={nullable} onChange={setNullable} />
    </Modal>
  )
}

// ── Rename table ────────────────────────────────────────────────────────────

export function RenameTableDialog({
  connId,
  db,
  schema,
  table,
  onClose,
  onRenamed,
}: {
  connId: string
  db: string
  schema: string
  table: string
  onClose: () => void
  onRenamed: (newName: string) => void
}) {
  const { t } = useTranslation()
  const [newName, setNewName] = useState(table)
  const helpers = useDdlMutation(connId, db, schema, table, onClose)

  const rename = useMutation({
    mutationFn: () =>
      api(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/alter`,
        { body: { actions: [{ kind: 'rename_table', newName }] } },
      ),
    onSuccess: () => {
      helpers.invalidate()
      toast.ok(t('ddl.applied'))
      onRenamed(newName)
    },
    onError: helpers.onErr,
  })

  return (
    <Modal
      title={`${t('ddl.rename')} — ${table}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!newName || newName === table}
            loading={rename.isPending}
            onClick={() => rename.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('ddl.newName')}>
        <TextInput mono value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
      </Field>
    </Modal>
  )
}

// ── Create index ────────────────────────────────────────────────────────────

export function CreateIndexDialog({
  connId,
  db,
  schema,
  table,
  columns,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  table: string
  columns: string[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<CreateIndexInput>({ columns: [], unique: false, method: 'btree' })
  const [name, setName] = useState('')
  const helpers = useDdlMutation(connId, db, schema, table, onClose)

  const create = useMutation({
    mutationFn: () =>
      api(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/indexes`,
        { body: { ...form, name: name.trim() || undefined } },
      ),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
    },
    onError: helpers.onErr,
  })

  const toggleColumn = (column: string, on: boolean) => {
    setForm((f) => ({
      ...f,
      columns: on ? [...f.columns, column] : f.columns.filter((c) => c !== column),
    }))
  }

  return (
    <Modal
      title={`${t('ddl.createIndex')} — ${table}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={form.columns.length === 0}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('ddl.indexName')}>
        <TextInput mono value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('db.columns')}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {columns.map((column) => (
            <Checkbox
              key={column}
              label={<span className="mono">{column}</span>}
              checked={form.columns.includes(column)}
              onChange={(v) => toggleColumn(column, v)}
            />
          ))}
        </div>
      </Field>
      <div className="form-grid">
        <Field label={t('ddl.method')}>
          <Select
            value={form.method}
            onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as IndexMethod }))}
          >
            {INDEX_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <div style={{ paddingTop: 22 }}>
          <Checkbox
            label={t('ddl.unique')}
            checked={form.unique}
            onChange={(unique) => setForm((f) => ({ ...f, unique }))}
          />
        </div>
      </div>
    </Modal>
  )
}

// ── Sequences ───────────────────────────────────────────────────────────────

export function CreateSequenceDialog({
  connId,
  db,
  schema,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<CreateSequenceInput>({ schema, name: '', cycle: false })
  const helpers = useDdlMutation(connId, db, schema, null, onClose)

  const create = useMutation({
    mutationFn: () =>
      api(`/api/connections/${connId}/db/${encodeURIComponent(db)}/sequences`, {
        body: {
          ...form,
          startValue: form.startValue?.trim() || undefined,
          increment: form.increment?.trim() || undefined,
          minValue: form.minValue?.trim() || undefined,
          maxValue: form.maxValue?.trim() || undefined,
        },
      }),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
    },
    onError: helpers.onErr,
  })

  const numField = (key: 'startValue' | 'increment' | 'minValue' | 'maxValue', label: string) => (
    <Field label={label}>
      <TextInput
        mono
        placeholder="—"
        value={form[key] ?? ''}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </Field>
  )

  return (
    <Modal
      title={`${t('ddl.createSequence')} — ${schema}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!form.name} loading={create.isPending} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')}>
        <TextInput mono value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
      </Field>
      <div className="form-grid">
        {numField('startValue', t('ddl.startValue'))}
        {numField('increment', t('ddl.increment'))}
        {numField('minValue', t('ddl.minValue'))}
        {numField('maxValue', t('ddl.maxValue'))}
      </div>
      <Checkbox label={t('ddl.cycle')} checked={form.cycle ?? false} onChange={(cycle) => setForm((f) => ({ ...f, cycle }))} />
    </Modal>
  )
}

// ── Constraints ─────────────────────────────────────────────────────────────

export function ForeignKeyDialog({
  connId,
  db,
  schema,
  table,
  columns,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  table: string
  columns: string[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [refSchema, setRefSchema] = useState(schema)
  const [refTable, setRefTable] = useState('')
  const [refColumns, setRefColumns] = useState<string[]>([])
  const [onDelete, setOnDelete] = useState<FkRefAction>('NO ACTION')
  const [onUpdate, setOnUpdate] = useState<FkRefAction>('NO ACTION')
  const helpers = useDdlMutation(connId, db, schema, table, onClose)

  const schemas = useSchemas(connId, db)
  const refTables = useTables(connId, db, refSchema)
  const refStructure = useQuery({
    queryKey: ['structure', connId, db, refSchema, refTable],
    queryFn: () =>
      api<TableStructure>(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(refSchema)}/${encodeURIComponent(refTable)}/structure`,
      ),
    enabled: refTable.length > 0,
  })

  useEffect(() => {
    // Default the referenced columns to the target's primary key.
    if (refStructure.data) setRefColumns(refStructure.data.primaryKey)
  }, [refStructure.data])

  const apply = useMutation({
    mutationFn: () =>
      api(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/alter`,
        {
          body: {
            actions: [
              {
                kind: 'add_foreign_key',
                name: name.trim() || undefined,
                columns: selected,
                refSchema,
                refTable,
                refColumns,
                onDelete,
                onUpdate,
              },
            ],
          },
        },
      ),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
    },
    onError: helpers.onErr,
  })

  const toggle = (list: string[], set: (v: string[]) => void, value: string, on: boolean) => {
    set(on ? [...list, value] : list.filter((v) => v !== value))
  }

  return (
    <Modal
      title={`${t('ddl.addForeignKey')} — ${table}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={selected.length === 0 || !refTable || refColumns.length === 0}
            loading={apply.isPending}
            onClick={() => apply.mutate()}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('ddl.constraintName')}>
        <TextInput mono value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('db.columns')}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {columns.map((column) => (
            <Checkbox
              key={column}
              label={<span className="mono">{column}</span>}
              checked={selected.includes(column)}
              onChange={(v) => toggle(selected, setSelected, column, v)}
            />
          ))}
        </div>
      </Field>
      <div className="form-grid">
        <Field label={t('db.schemas')}>
          <Select
            className="mono"
            value={refSchema}
            onChange={(e) => {
              setRefSchema(e.target.value)
              setRefTable('')
              setRefColumns([])
            }}
          >
            {schemas.data?.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('ddl.refTable')}>
          <Select className="mono" value={refTable} onChange={(e) => setRefTable(e.target.value)}>
            <option value="">—</option>
            {refTables.data
              ?.filter((rel) => rel.kind === 'table')
              .map((rel) => (
                <option key={rel.name} value={rel.name}>
                  {rel.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      {refStructure.data && (
        <Field label={t('ddl.refColumns')}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {refStructure.data.columns.map((column) => (
              <Checkbox
                key={column.name}
                label={<span className="mono">{column.name}</span>}
                checked={refColumns.includes(column.name)}
                onChange={(v) => toggle(refColumns, setRefColumns, column.name, v)}
              />
            ))}
          </div>
        </Field>
      )}
      <div className="form-grid">
        <Field label="ON DELETE">
          <Select value={onDelete} onChange={(e) => setOnDelete(e.target.value as FkRefAction)}>
            {FK_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ON UPDATE">
          <Select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value as FkRefAction)}>
            {FK_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

export function CheckDialog({
  connId,
  db,
  schema,
  table,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  table: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [expression, setExpression] = useState('')
  const helpers = useDdlMutation(connId, db, schema, table, onClose)

  const apply = useMutation({
    mutationFn: () =>
      api(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/alter`,
        { body: { actions: [{ kind: 'add_check', name: name.trim() || undefined, expression }] } },
      ),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
    },
    onError: helpers.onErr,
  })

  return (
    <Modal
      title={`${t('ddl.addCheck')} — ${table}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!expression.trim()} loading={apply.isPending} onClick={() => apply.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Field label={t('ddl.constraintName')}>
        <TextInput mono value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('ddl.checkExpr')} hint="population >= 0">
        <TextInput mono value={expression} onChange={(e) => setExpression(e.target.value)} autoFocus />
      </Field>
    </Modal>
  )
}

export function TableCommentDialog({
  connId,
  db,
  schema,
  table,
  initial,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  table: string
  initial: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [comment, setComment] = useState(initial)
  const helpers = useDdlMutation(connId, db, schema, table, onClose)

  const apply = useMutation({
    mutationFn: () =>
      api(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/alter`,
        {
          body: {
            actions: [{ kind: 'set_comment', target: 'table', comment: comment.trim() || null }],
          },
        },
      ),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
    },
    onError: helpers.onErr,
  })

  return (
    <Modal
      title={`${t('ddl.editComment')} — ${table}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('ddl.commentLabel')}>
        <textarea
          className="textarea"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          autoFocus
        />
      </Field>
    </Modal>
  )
}

// ── CSV import ──────────────────────────────────────────────────────────────

export function ImportCsvDialog({
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
  onDone: (inserted: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [file, setFile] = useState<File | null>(null)
  const [delimiter, setDelimiter] = useState(',')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!file) return
    setBusy(true)
    try {
      const form = new FormData()
      form.append('delimiter', delimiter)
      form.append('file', file)
      const res = await fetch(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/import`,
        { method: 'POST', credentials: 'include', headers: getAuthHeader(), body: form },
      )
      const body = (await res.json().catch(() => null)) as
        | { inserted?: number; error?: { message?: string } }
        | null
      if (!res.ok) throw new Error(body?.error?.message ?? t('errors.generic'))
      onDone(body?.inserted ?? 0)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`${t('ddl.importCsv')} — ${table}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!file} loading={busy} onClick={() => void submit()}>
            {t('ddl.importCsv')}
          </Button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>
        {t('ddl.importHint')}
      </div>
      <Field label={t('backup.file')}>
        <input
          type="file"
          accept=".csv,text/csv"
          className="input"
          style={{ paddingTop: 4 }}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <Field label={t('ddl.delimiter')}>
        <Select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} style={{ width: 140 }}>
          <option value=",">,</option>
          <option value=";">;</option>
          <option value="\t">Tab</option>
        </Select>
      </Field>
    </Modal>
  )
}

export function RestartSequenceDialog({
  connId,
  db,
  schema,
  name,
  onClose,
}: {
  connId: string
  db: string
  schema: string
  name: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('1')
  const helpers = useDdlMutation(connId, db, schema, null, onClose)

  const restart = useMutation({
    mutationFn: () =>
      api(`/api/connections/${connId}/db/${encodeURIComponent(db)}/sequences/restart`, {
        body: { schema, name, restartWith: value.trim() },
      }),
    onSuccess: () => {
      helpers.invalidate()
      helpers.onOk()
    },
    onError: helpers.onErr,
  })

  return (
    <Modal
      title={`${t('ddl.restartSequence')} — ${name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!/^-?\d+$/.test(value.trim())}
            loading={restart.isPending}
            onClick={() => restart.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('ddl.restartWith')}>
        <TextInput mono value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </Field>
    </Modal>
  )
}
