import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ColumnInfo,
  FilterOp,
  RowFilter,
  RowsPage,
  RowSort,
  RowValues,
  TableStructure,
} from '@pgforge/shared'
import { Button, Select, TextInput } from '../../components/ui/basics.js'
import { ConfirmDialog, useMenu } from '../../components/ui/overlays.js'
import { QueryError } from '../../components/ui/QueryError.js'
import { api, ApiError, downloadFile } from '../../lib/api.js'
import { displayValue, formatCount, formatMs } from '../../lib/format.js'
import { useAuthStore } from '../../stores/auth.js'
import { toast } from '../../stores/toast.js'
import { ColumnDialog, ImportCsvDialog } from './ddl-dialogs.js'
import { RowEditor } from './RowEditor.js'

const OPS: FilterOp[] = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts', 'ends', 'in', 'is_null', 'not_null',
]
const PAGE_SIZE = 100

export function DataGrid({
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
  const user = useAuthStore((s) => s.user)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<RowSort | null>(null)
  const [filters, setFilters] = useState<RowFilter[]>([])
  const [search, setSearch] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [filterDraft, setFilterDraft] = useState<{ column?: string } | null>(null)
  const [editingCell, setEditingCell] = useState<{ row: number; col: number; draft: string } | null>(null)
  const [editorRow, setEditorRow] = useState<{ mode: 'insert' } | { mode: 'edit'; row: unknown[] } | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [columnDialog, setColumnDialog] = useState<ColumnInfo | null>(null)
  const [droppingColumn, setDroppingColumn] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const { open: openMenu, menu } = useMenu()

  const base = `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`

  const rows = useQuery({
    queryKey: ['rows', connId, db, schema, table, page, sort, filters, search],
    queryFn: () =>
      api<RowsPage>(`${base}/rows/query`, {
        body: {
          page,
          pageSize: PAGE_SIZE,
          sorts: sort ? [sort] : [],
          filters,
          search: search || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  })

  const data = rows.data
  const editable = (data?.editable ?? false) && user?.role !== 'viewer'
  const pkIndexes = useMemo(() => {
    if (!data) return []
    return data.primaryKey
      .map((name) => data.columns.findIndex((c) => c.name === name))
      .filter((i) => i >= 0)
  }, [data])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['rows', connId, db, schema, table] })
    setSelected(new Set())
  }

  const pkValues = (row: unknown[]): RowValues => {
    const pk: RowValues = {}
    if (!data) return pk
    for (const idx of pkIndexes) pk[data.columns[idx]!.name] = row[idx]
    return pk
  }

  const update = useMutation({
    mutationFn: (input: { pk: RowValues; changes: RowValues }) =>
      api(`${base}/rows/update`, { body: input }),
    onSuccess: () => {
      invalidate()
      setEditingCell(null)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const remove = useMutation({
    mutationFn: (pks: RowValues[]) => api(`${base}/rows/delete`, { body: { pks } }),
    onSuccess: () => {
      invalidate()
      setConfirmingDelete(false)
      toast.ok(t('common.success'))
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const structureUrl = `/api/connections/${connId}/db/${encodeURIComponent(db)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`
  const canAlter = user?.role !== 'viewer'

  const dropColumn = useMutation({
    mutationFn: (column: string) =>
      api(`${structureUrl}/alter`, { body: { actions: [{ kind: 'drop_column', column }] } }),
    onSuccess: () => {
      toast.ok(t('ddl.applied'))
      setDroppingColumn(null)
      invalidate()
      void queryClient.invalidateQueries({ queryKey: ['structure', connId, db, schema, table] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.generic')),
  })

  const openColumnEditor = async (columnName: string) => {
    try {
      const structure = await api<TableStructure>(`${structureUrl}/structure`)
      const column = structure.columns.find((c) => c.name === columnName)
      if (column) setColumnDialog(column)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('errors.generic'))
    }
  }

  const columnMenu = (e: React.MouseEvent, columnName: string) => {
    e.stopPropagation()
    openMenu(e, [
      {
        label: t('ddl.sortAsc'),
        icon: <ArrowUp size={13} />,
        onSelect: () => {
          setPage(0)
          setSort({ column: columnName, dir: 'asc' })
        },
      },
      {
        label: t('ddl.sortDesc'),
        icon: <ArrowDown size={13} />,
        onSelect: () => {
          setPage(0)
          setSort({ column: columnName, dir: 'desc' })
        },
      },
      {
        label: t('ddl.filterByColumn'),
        icon: <Filter size={13} />,
        onSelect: () => setFilterDraft({ column: columnName }),
      },
      ...(canAlter
        ? [
            {
              label: t('ddl.editColumn'),
              onSelect: () => void openColumnEditor(columnName),
            },
            {
              label: t('common.delete'),
              danger: true,
              onSelect: () => setDroppingColumn(columnName),
            },
          ]
        : []),
    ])
  }

  const toggleSort = (column: string) => {
    setPage(0)
    setSort((prev) =>
      prev?.column !== column
        ? { column, dir: 'asc' }
        : prev.dir === 'asc'
          ? { column, dir: 'desc' }
          : null,
    )
  }

  const commitCellEdit = () => {
    if (!editingCell || !data) return
    const column = data.columns[editingCell.col]!
    const row = data.rows[editingCell.row]!
    update.mutate({ pk: pkValues(row), changes: { [column.name]: editingCell.draft } })
  }

  const onCellKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') commitCellEdit()
    if (e.key === 'Escape') setEditingCell(null)
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <>
      <div className="sql-toolbar" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void rows.refetch()} aria-label={t('common.refresh')} />
        <Button size="sm" icon={Filter} onClick={() => setFilterDraft((v) => (v ? null : {}))}>
          {t('explorer.addFilter')}
        </Button>
        {editable && (
          <Button size="sm" icon={Plus} onClick={() => setEditorRow({ mode: 'insert' })}>
            {t('explorer.insertRow')}
          </Button>
        )}
        {canAlter && (
          <Button size="sm" icon={Upload} onClick={() => setImporting(true)}>
            {t('ddl.importCsv')}
          </Button>
        )}
        {editable && selected.size > 0 && (
          <Button size="sm" variant="danger-outline" icon={Trash2} onClick={() => setConfirmingDelete(true)}>
            {t('explorer.deleteRows', { count: selected.size })}
          </Button>
        )}
        <span className="grow" />
        <TextInput
          placeholder={t('explorer.searchInTable')}
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(0)
              setSearch(searchDraft)
            }
          }}
          style={{ width: 200, height: 26, fontSize: 'var(--text-xs)' }}
        />
        <Button
          size="sm"
          icon={Download}
          onClick={() =>
            void downloadFile(`${base}/export`, { format: 'csv', filters, sorts: sort ? [sort] : [] }).catch(
              (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
            )
          }
        >
          CSV
        </Button>
        <Button
          size="sm"
          icon={Download}
          onClick={() =>
            void downloadFile(`${base}/export`, { format: 'json', filters, sorts: sort ? [sort] : [] }).catch(
              (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
            )
          }
        >
          JSON
        </Button>
      </div>

      {(filters.length > 0 || filterDraft) && (
        <div className="sql-toolbar" style={{ flexWrap: 'wrap' }}>
          {filters.map((filter, i) => (
            <span key={i} className="filter-chip">
              {filter.column} {t(`data.op_${filter.op}`)} {filter.value ?? ''}
              <button
                type="button"
                aria-label={t('common.delete')}
                onClick={() => {
                  setPage(0)
                  setFilters((prev) => prev.filter((_, j) => j !== i))
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {filterDraft && data && (
            <FilterForm
              key={filterDraft.column ?? '_all'}
              columns={data.columns.map((c) => c.name)}
              initialColumn={filterDraft.column}
              onAdd={(filter) => {
                setPage(0)
                setFilters((prev) => [...prev, filter])
                setFilterDraft(null)
              }}
              onCancel={() => setFilterDraft(null)}
            />
          )}
        </div>
      )}

      <div className="grid-wrap">
        {rows.isError && <QueryError error={rows.error} onRetry={() => void rows.refetch()} />}
        {data && (
          <table className="data-grid">
            <thead>
              <tr>
                {editable && (
                  <th className="row-check">
                    <input
                      type="checkbox"
                      checked={selected.size > 0 && selected.size === data.rows.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(data.rows.map((_, i) => i)) : new Set())
                      }
                    />
                  </th>
                )}
                {data.columns.map((col) => (
                  <th key={col.name}>
                    <div className="col-head" onClick={() => toggleSort(col.name)}>
                      <span>{col.name}</span>
                      <span className="col-type">{col.dataType}</span>
                      {sort?.column === col.name &&
                        (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('common.actions')}
                        style={{ display: 'inline-flex', padding: 2, borderRadius: 3, color: 'var(--text-faint)' }}
                        onClick={(e) => columnMenu(e, col.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') columnMenu(e as unknown as React.MouseEvent, col.name)
                        }}
                      >
                        <ChevronDown size={12} />
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className={selected.has(rowIdx) ? 'selected' : ''}
                  onDoubleClick={() => editable && setEditorRow({ mode: 'edit', row })}
                >
                  {editable && (
                    <td className="row-check" onDoubleClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(rowIdx)}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(rowIdx)
                            else next.delete(rowIdx)
                            return next
                          })
                        }}
                      />
                    </td>
                  )}
                  {row.map((value, colIdx) => {
                    const isEditing = editingCell?.row === rowIdx && editingCell.col === colIdx
                    return (
                      <td
                        key={colIdx}
                        className={`${value === null ? 'null' : ''}${editable ? ' editable-cell' : ''}`}
                        onDoubleClick={(e) => {
                          if (!editable) return
                          e.stopPropagation()
                          setEditingCell({ row: rowIdx, col: colIdx, draft: displayValue(value) })
                        }}
                        title={displayValue(value)}
                      >
                        {isEditing ? (
                          <input
                            className="input mono"
                            style={{ height: 22, fontSize: 'var(--text-xs)', minWidth: 120 }}
                            value={editingCell.draft}
                            autoFocus
                            onChange={(e) =>
                              setEditingCell((c) => (c ? { ...c, draft: e.target.value } : c))
                            }
                            onKeyDown={onCellKey}
                            onBlur={() => setEditingCell(null)}
                          />
                        ) : value === null ? (
                          t('explorer.nullValue')
                        ) : (
                          displayValue(value)
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid-footer">
        {rows.isFetching ? <span className="spinner" /> : null}
        <span className="mono">
          {formatCount(data?.total)} {t('common.rows')}
          {data?.totalIsEstimate ? ` (${t('common.estimated')})` : ''}
        </span>
        {data && <span className="mono">{formatMs(data.durationMs)}</span>}
        {data && !data.editable && <span>{t('explorer.noPk')}</span>}
        <span className="grow" />
        <div className="pager">
          <Button variant="ghost" size="sm" icon={ChevronLeft} disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="prev" />
          <span className="mono">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={ChevronRight}
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            aria-label="next"
          />
        </div>
      </div>

      {editorRow && data && (
        <RowEditor
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          columns={data.columns}
          primaryKey={data.primaryKey}
          existing={editorRow.mode === 'edit' ? editorRow.row : null}
          onDone={() => {
            setEditorRow(null)
            invalidate()
          }}
          onClose={() => setEditorRow(null)}
        />
      )}
      {confirmingDelete && data && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('explorer.deleteRowsConfirm', { count: selected.size, table: `${schema}.${table}` })}
          loading={remove.isPending}
          onConfirm={() => remove.mutate([...selected].map((i) => pkValues(data.rows[i]!)))}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
      {menu}
      {columnDialog && (
        <ColumnDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          existing={columnDialog}
          onClose={() => {
            setColumnDialog(null)
            invalidate()
          }}
        />
      )}
      {droppingColumn && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('ddl.dropColumnConfirm', { name: droppingColumn })}
          loading={dropColumn.isPending}
          onConfirm={() => dropColumn.mutate(droppingColumn)}
          onClose={() => setDroppingColumn(null)}
        />
      )}
      {importing && (
        <ImportCsvDialog
          connId={connId}
          db={db}
          schema={schema}
          table={table}
          onDone={(inserted) => {
            setImporting(false)
            toast.ok(t('ddl.imported', { count: inserted }))
            invalidate()
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </>
  )
}

function FilterForm({
  columns,
  initialColumn,
  onAdd,
  onCancel,
}: {
  columns: string[]
  initialColumn?: string
  onAdd: (filter: RowFilter) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [column, setColumn] = useState(initialColumn ?? columns[0] ?? '')
  const [op, setOp] = useState<FilterOp>('eq')
  const [value, setValue] = useState('')
  const needsValue = op !== 'is_null' && op !== 'not_null'

  return (
    <div className="row">
      <Select value={column} onChange={(e) => setColumn(e.target.value)} style={{ width: 140, height: 26, fontSize: 'var(--text-xs)' }}>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
      <Select value={op} onChange={(e) => setOp(e.target.value as FilterOp)} style={{ width: 120, height: 26, fontSize: 'var(--text-xs)' }}>
        {OPS.map((o) => (
          <option key={o} value={o}>
            {t(`data.op_${o}`)}
          </option>
        ))}
      </Select>
      {needsValue && (
        <TextInput
          mono
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && column) onAdd({ column, op, value })
          }}
          style={{ width: 160, height: 26, fontSize: 'var(--text-xs)' }}
          autoFocus
        />
      )}
      <Button size="sm" variant="primary" disabled={!column} onClick={() => onAdd({ column, op, value: needsValue ? value : undefined })}>
        {t('common.apply')}
      </Button>
      <Button size="sm" variant="ghost" icon={X} onClick={onCancel} aria-label={t('common.cancel')} />
    </div>
  )
}
