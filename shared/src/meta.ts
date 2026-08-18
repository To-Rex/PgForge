export interface AppMeta {
  version: string
  pgToolsAvailable: boolean
  pgToolsVersion: string | null
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface Paged<T> {
  items: T[]
  total: number
}
