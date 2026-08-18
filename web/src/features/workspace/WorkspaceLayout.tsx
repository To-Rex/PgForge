import { Navigate, Outlet, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import type { ConnectionSummary } from '@pgforge/shared'
import { useConnection, useConnections } from '../../lib/queries.js'

export interface WorkspaceCtx {
  connId: string
  connection: ConnectionSummary
  db: string
  setDb: (db: string) => void
}

export function useWorkspace(): WorkspaceCtx {
  return useOutletContext<WorkspaceCtx>()
}

export function WorkspaceLayout() {
  const { connId } = useParams<{ connId: string }>()
  const connections = useConnections()
  const connection = useConnection(connId)
  const [searchParams, setSearchParams] = useSearchParams()

  if (connections.isLoading) {
    return (
      <div className="page" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span className="spinner" />
      </div>
    )
  }
  if (!connection || !connId) {
    return <Navigate to="/" replace />
  }

  const db = searchParams.get('db') ?? connection.defaultDatabase
  const setDb = (next: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('db', next)
        // Object selections belong to the previous database.
        params.delete('schema')
        params.delete('table')
        return params
      },
      { replace: false },
    )
  }

  const ctx: WorkspaceCtx = { connId, connection, db, setDb }
  return <Outlet context={ctx} />
}
