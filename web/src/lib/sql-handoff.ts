const KEY = 'pgforge.pending-sql'

/** Stash SQL for the editor page to pick up right after navigation. */
export function stashSql(sql: string): void {
  try {
    sessionStorage.setItem(KEY, sql)
  } catch {
    /* storage unavailable — the editor simply opens empty */
  }
}

/** One-shot read: returns the stashed SQL and clears it. */
export function takePendingSql(): string | null {
  try {
    const value = sessionStorage.getItem(KEY)
    if (value !== null) sessionStorage.removeItem(KEY)
    return value
  } catch {
    return null
  }
}

export function functionTemplate(schema: string): string {
  return [
    `CREATE OR REPLACE FUNCTION ${schema}.my_function(arg integer)`,
    'RETURNS integer',
    'LANGUAGE plpgsql',
    'AS $$',
    'BEGIN',
    '  RETURN arg * 2;',
    'END;',
    '$$;',
  ].join('\n')
}

export function viewTemplate(schema: string): string {
  return `CREATE OR REPLACE VIEW ${schema}.my_view AS\nSELECT 1 AS example;`
}
