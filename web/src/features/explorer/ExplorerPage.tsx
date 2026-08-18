import { Table2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { DbSwitcher } from '../../components/layout/DbSwitcher.js'
import { PathBar, type PathSegment } from '../../components/layout/PathBar.js'
import { EmptyState } from '../../components/ui/basics.js'
import { Tabs } from '../../components/ui/Tabs.js'
import { useWorkspace } from '../workspace/WorkspaceLayout.js'
import { DataGrid } from './DataGrid.js'
import { InlineSqlPane } from './InlineSqlPane.js'
import { RoutinesPanel, SequencesPanel } from './RoutinesPanel.js'
import { SchemaTree, type TreeSelection } from './SchemaTree.js'
import { StructureView } from './StructureView.js'

type ViewTab = 'data' | 'structure' | 'sql'

export function ExplorerPage() {
  const { t } = useTranslation()
  const { connId, connection, db, setDb } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  const schema = searchParams.get('schema')
  const table = searchParams.get('table')
  const group = searchParams.get('group') as 'routines' | 'sequences' | null
  const tab = (searchParams.get('tab') as ViewTab | null) ?? 'data'

  const select = (selection: TreeSelection) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.set('schema', selection.schema)
      if (selection.kind === 'relation') {
        params.set('table', selection.name)
        params.delete('group')
      } else {
        params.set('group', selection.kind)
        params.delete('table')
      }
      return params
    })
  }

  const setTab = (next: ViewTab) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.set('tab', next)
      return params
    })
  }

  const segments: PathSegment[] = [
    { kind: 'conn', label: connection.name },
    { kind: 'db', label: db },
  ]
  if (schema) segments.push({ kind: 'schema', label: schema })
  if (table) segments.push({ kind: 'object', label: table })
  if (group) segments.push({ kind: 'object', label: t(group === 'routines' ? 'db.functions' : 'db.sequences') })

  return (
    <>
      <PathBar
        segments={segments}
        actions={<DbSwitcher connId={connId} db={db} onChange={setDb} />}
      />
      <div className="explorer">
        <SchemaTree
          connId={connId}
          db={db}
          selectedSchema={schema}
          selectedTable={table}
          selectedGroup={group}
          onSelect={select}
        />
        <div className="content-pane">
          {schema && table ? (
            <>
              <Tabs<ViewTab>
                tabs={[
                  { key: 'data', label: t('explorer.data') },
                  { key: 'structure', label: t('explorer.structure') },
                  { key: 'sql', label: 'SQL' },
                ]}
                active={tab}
                onChange={setTab}
              />
              {tab === 'data' ? (
                <DataGrid key={`${db}.${schema}.${table}`} connId={connId} db={db} schema={schema} table={table} />
              ) : tab === 'structure' ? (
                <StructureView key={`${db}.${schema}.${table}`} connId={connId} db={db} schema={schema} table={table} />
              ) : (
                <InlineSqlPane key={`${db}.${schema}.${table}`} connId={connId} db={db} schema={schema} table={table} />
              )}
            </>
          ) : schema && group === 'routines' ? (
            <RoutinesPanel connId={connId} db={db} schema={schema} />
          ) : schema && group === 'sequences' ? (
            <SequencesPanel connId={connId} db={db} schema={schema} />
          ) : (
            <EmptyState icon={Table2} title={t('explorer.noTable')} hint={t('explorer.noTableHint')} />
          )}
        </div>
      </div>
    </>
  )
}
