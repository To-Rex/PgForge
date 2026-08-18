export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'bad_request', message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(403, 'forbidden', message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'not_found', message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'conflict', message)
  }
}

/** Failure reaching or talking to a managed PostgreSQL server. */
export class UpstreamError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, 'upstream_error', message, details)
  }
}

interface PgErrorLike {
  code?: string
  detail?: string
  hint?: string
  position?: string
  severity?: string
  message: string
}

export function isPgError(err: unknown): err is PgErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'severity' in err &&
    'code' in err &&
    'message' in err
  )
}

const CONNECT_ERRNOS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
])

export function isConnectionFailure(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code && CONNECT_ERRNOS.has(code)) return true
  const message = err instanceof Error ? err.message : ''
  return /timeout|terminat|SSL|self-signed|certificate/i.test(message) && !isPgError(err)
}
