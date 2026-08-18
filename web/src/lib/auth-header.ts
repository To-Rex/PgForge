let currentToken: string | null = null

export function rememberToken(token: string | null): void {
  currentToken = token
}

export function getAuthHeader(): Record<string, string> {
  return currentToken ? { authorization: `Bearer ${currentToken}` } : {}
}
