import { useQuery } from '@tanstack/react-query'
import type {
  AdviceResponse,
  AppMeta,
  AutocompleteData,
  ConnectionSummary,
  DatabaseInfo,
  SavedQuery,
  SchemaInfo,
  TableInfo,
} from '@pgforge/shared'
import { api } from './api.js'

export function useConnections() {
  return useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ConnectionSummary[]>('/api/connections'),
  })
}

export function useConnection(connId: string | undefined) {
  const { data } = useConnections()
  return data?.find((c) => c.id === connId)
}

export function useDatabases(connId: string, enabled = true) {
  return useQuery({
    queryKey: ['databases', connId],
    queryFn: () => api<DatabaseInfo[]>(`/api/connections/${connId}/databases`),
    enabled,
  })
}

export function useSchemas(connId: string, db: string) {
  return useQuery({
    queryKey: ['schemas', connId, db],
    queryFn: () => api<SchemaInfo[]>(`/api/connections/${connId}/db/${encodeURIComponent(db)}/schemas`),
  })
}

export function useTables(connId: string, db: string, schema: string | null) {
  return useQuery({
    queryKey: ['tables', connId, db, schema],
    queryFn: () =>
      api<TableInfo[]>(
        `/api/connections/${connId}/db/${encodeURIComponent(db)}/schemas/${encodeURIComponent(schema!)}/tables`,
      ),
    enabled: schema !== null,
  })
}

export function useAutocomplete(connId: string, db: string) {
  return useQuery({
    queryKey: ['autocomplete', connId, db],
    queryFn: () =>
      api<AutocompleteData>(`/api/connections/${connId}/db/${encodeURIComponent(db)}/autocomplete`),
    staleTime: 60_000,
  })
}

export function useSavedQueries(connId: string | undefined) {
  return useQuery({
    queryKey: ['saved-queries', connId ?? null],
    queryFn: () =>
      api<SavedQuery[]>(`/api/saved-queries${connId ? `?connectionId=${connId}` : ''}`),
  })
}

export function useAdvice(connId: string, db: string, enabled = true) {
  return useQuery({
    queryKey: ['advice', connId, db],
    queryFn: () =>
      api<AdviceResponse>(`/api/connections/${connId}/db/${encodeURIComponent(db)}/advice`),
    enabled,
    // Catalog scans are not free; the numbers behind them move slowly anyway.
    staleTime: 60_000,
  })
}

export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: () => api<AppMeta>('/api/meta'),
    staleTime: Infinity,
  })
}
