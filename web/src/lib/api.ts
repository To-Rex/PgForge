import type { AuthResponse } from '@pgforge/shared'
import i18n from '../i18n/index.js'
import { useAuthStore } from '../stores/auth.js'
import { rememberToken } from './auth-header.js'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
  rememberToken(token)
}

export function applyAuth(auth: AuthResponse): void {
  setAccessToken(auth.token)
  useAuthStore.getState().setUser(auth.user)
}

function clearAuth(): void {
  setAccessToken(null)
  useAuthStore.getState().clear()
}

let refreshInFlight: Promise<boolean> | null = null

/** Single-flight refresh: many 401s produce one refresh request. */
async function tryRefresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (!res.ok) return false
      applyAuth((await res.json()) as AuthResponse)
      return true
    } catch {
      return false
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

export interface ApiOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  /** Skip the automatic refresh-and-retry on 401. */
  noRetry?: boolean
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const exec = async (): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (accessToken) headers.authorization = `Bearer ${accessToken}`
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await fetch(path, {
        method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
        headers,
        credentials: 'include',
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw new ApiError(0, 'network', i18n.t('errors.network'))
    }
    return res
  }

  let res = await exec()
  if (res.status === 401 && !options.noRetry && !path.startsWith('/api/auth/')) {
    if (await tryRefresh()) {
      res = await exec()
    } else {
      clearAuth()
    }
  }

  if (!res.ok) {
    const fallback = { error: { code: 'unknown', message: i18n.t('errors.generic') } }
    const body = (await res.json().catch(() => fallback)) as {
      error?: { code?: string; message?: string; details?: unknown }
    }
    throw new ApiError(
      res.status,
      body.error?.code ?? 'unknown',
      body.error?.message ?? i18n.t('errors.generic'),
      body.error?.details,
    )
  }
  return (await res.json()) as T
}

/** Initial silent sign-in from the refresh cookie. */
export async function bootstrapSession(): Promise<void> {
  await tryRefresh()
  useAuthStore.getState().setReady()
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
  clearAuth()
}

/** Authenticated file download via blob + anchor. */
export async function downloadFile(path: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = {}
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new ApiError(res.status, 'download_failed', i18n.t('errors.generic'))
  }
  const disposition = res.headers.get('content-disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(disposition)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = match?.[1] ?? 'download'
  anchor.click()
  URL.revokeObjectURL(url)
}
