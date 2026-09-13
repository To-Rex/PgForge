import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  Archive,
  Columns3,
  Database,
  Eye,
  FolderOpen,
  FunctionSquare,
  Hash,
  Layers,
  Network,
  Search,
  Server,
  Settings,
  Table2,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { SearchHit, SearchKind, SearchResponse, SearchScope } from '@pgforge/shared'
import { api } from '../../lib/api.js'
import { useConnections } from '../../lib/queries.js'

const KIND_ICON: Record<SearchKind, LucideIcon> = {
  database: Database,
  schema: FolderOpen,
  table: Table2,
  view: Eye,
  matview: Layers,
  foreign: Table2,
  sequence: Hash,
  function: FunctionSquare,
  procedure: FunctionSquare,
  column: Columns3,
}

interface Entry {
  key: string
  icon: LucideIcon
  label: string
  hint: string
  kind: string
  run: () => void
}

const DEBOUNCE_MS = 200
const MIN_TERM = 1

export function CommandPalette({
  open,
  onClose,
  connId,
  db,
}: {
  open: boolean
  onClose: () => void
  /** Undefined outside a workspace — the palette then offers connections only. */
  connId: string | undefined
  db: string | undefined
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const connections = useConnections()
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [scope, setScope] = useState<SearchScope>('database')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Reopening should always start clean; a stale query is worse than no query.
  useEffect(() => {
    if (open) {
      setTerm('')
      setDebounced('')
      setCursor(0)
    }
  }, [open])

  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [term])

  const canSearch = Boolean(connId && db) && debounced.length >= MIN_TERM
  const search = useQuery({
    queryKey: ['search', connId, db, scope, debounced],
    queryFn: () =>
      api<SearchResponse>(
        `/api/connections/${connId}/search?q=${encodeURIComponent(debounced)}` +
          `&scope=${scope}&db=${encodeURIComponent(db!)}`,
      ),
    enabled: open && canSearch,
    staleTime: 15_000,
  })

  const go = (path: string) => {
    onClose()
    navigate(path)
  }

  const hitPath = (hit: SearchHit): string => {
    const qs = new URLSearchParams({ db: hit.database })
    switch (hit.kind) {
      case 'database':
        return `/c/${connId}/explorer?${qs}`
      case 'schema':
        qs.set('schema', hit.name)
        return `/c/${connId}/explorer?${qs}`
      case 'sequence':
        qs.set('schema', hit.schema ?? 'public')
        qs.set('group', 'sequences')
        return `/c/${connId}/explorer?${qs}`
      case 'function':
      case 'procedure':
        qs.set('schema', hit.schema ?? 'public')
        qs.set('group', 'routines')
        return `/c/${connId}/explorer?${qs}`
      case 'column':
        qs.set('schema', hit.schema ?? 'public')
        qs.set('table', hit.table ?? '')
        qs.set('tab', 'structure')
        return `/c/${connId}/explorer?${qs}`
      default:
        qs.set('schema', hit.schema ?? 'public')
        qs.set('table', hit.name)
        qs.set('tab', 'data')
        return `/c/${connId}/explorer?${qs}`
    }
  }

  const entries = useMemo<Entry[]>(() => {
    const needle = debounced.toLowerCase()
    const out: Entry[] = []

    // Object hits first — they are what the palette exists for.
    for (const hit of search.data?.hits ?? []) {
      const qualified =
        hit.kind === 'database'
          ? hit.name
          : hit.kind === 'column'
            ? `${hit.database}.${hit.schema}.${hit.table}.${hit.name}`
            : `${hit.database}.${hit.schema}.${hit.name}`
      out.push({
        key: `hit:${qualified}:${hit.kind}`,
        icon: KIND_ICON[hit.kind],
        label: hit.name,
        hint: qualified,
        kind: t(`search.kind_${hit.kind}`),
        run: () => go(hitPath(hit)),
      })
    }

    const matches = (label: string) => !needle || label.toLowerCase().includes(needle)

    if (connId) {
      const suffix = db ? `?db=${encodeURIComponent(db)}` : ''
      const pages: { icon: LucideIcon; label: string; to: string }[] = [
        { icon: Server, label: t('nav.overview'), to: `/c/${connId}` },
        { icon: Table2, label: t('nav.explorer'), to: `/c/${connId}/explorer${suffix}` },
        { icon: Terminal, label: t('nav.sql'), to: `/c/${connId}/sql${suffix}` },
        { icon: Network, label: t('nav.erd'), to: `/c/${connId}/erd${suffix}` },
        { icon: Activity, label: t('nav.monitor'), to: `/c/${connId}/monitor${suffix}` },
        { icon: Users, label: t('nav.roles'), to: `/c/${connId}/roles` },
        { icon: Archive, label: t('nav.backups'), to: `/c/${connId}/backups${suffix}` },
      ]
      for (const page of pages) {
        if (!matches(page.label)) continue
        out.push({
          key: `page:${page.to}`,
          icon: page.icon,
          label: page.label,
          hint: '',
          kind: t('search.kind_page'),
          run: () => go(page.to),
        })
      }
    }

    for (const conn of connections.data ?? []) {
      if (!matches(conn.name)) continue
      out.push({
        key: `conn:${conn.id}`,
        icon: Database,
        label: conn.name,
        hint: `${conn.host}:${conn.port}`,
        kind: t('search.kind_connection'),
        run: () => go(`/c/${conn.id}`),
      })
    }

    if (matches(t('nav.settings'))) {
      out.push({
        key: 'page:/settings',
        icon: Settings,
        label: t('nav.settings'),
        hint: '',
        kind: t('search.kind_page'),
        run: () => go('/settings'),
      })
    }

    return out
    // `go` and `hitPath` close over stable values; recomputing on data is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.data, connections.data, debounced, connId, db, t])

  useEffect(() => setCursor(0), [entries.length])

  // Keep the highlighted row in view as the cursor moves through a long list.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (entries.length === 0 ? 0 : (c + 1) % entries.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (entries.length === 0 ? 0 : (c - 1 + entries.length) % entries.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      entries[cursor]?.run()
    } else if (e.key === 'Tab' && connId) {
      e.preventDefault()
      setScope((s) => (s === 'database' ? 'server' : 'database'))
    }
  }

  return createPortal(
    <div
      className="modal-overlay palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('search.title')}>
        <div className="palette-input">
          <Search size={15} className="faint" />
          <input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            aria-label={t('search.title')}
          />
          {connId && (
            <div className="palette-scope" role="group">
              <button
                type="button"
                className={scope === 'database' ? 'active' : ''}
                onClick={() => setScope('database')}
              >
                {db}
              </button>
              <button
                type="button"
                className={scope === 'server' ? 'active' : ''}
                onClick={() => setScope('server')}
              >
                {t('search.allDatabases')}
              </button>
            </div>
          )}
        </div>

        <div className="palette-list" ref={listRef}>
          {search.isFetching && <div className="palette-status">{t('search.searching')}</div>}
          {!search.isFetching && entries.length === 0 && (
            <div className="palette-status">
              {debounced.length >= MIN_TERM ? t('search.noResults') : t('search.hint')}
            </div>
          )}
          {entries.map((entry, i) => (
            <button
              key={entry.key}
              type="button"
              data-active={i === cursor}
              className={`palette-item${i === cursor ? ' active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={entry.run}
            >
              <entry.icon size={14} className="kind-icon" />
              <span className="palette-label mono">{entry.label}</span>
              {entry.hint && <span className="palette-hint mono">{entry.hint}</span>}
              <span className="palette-kind">{entry.kind}</span>
            </button>
          ))}
        </div>

        <div className="palette-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> {t('search.navigate')}
          </span>
          <span>
            <kbd>↵</kbd> {t('search.open')}
          </span>
          {connId && (
            <span>
              <kbd>Tab</kbd> {t('search.toggleScope')}
            </span>
          )}
          <span>
            <kbd>Esc</kbd> {t('common.close')}
          </span>
          {(search.data?.skipped.length ?? 0) > 0 && (
            <span className="grow faint" style={{ textAlign: 'right' }}>
              {t('search.skipped', { count: search.data!.skipped.length })}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
