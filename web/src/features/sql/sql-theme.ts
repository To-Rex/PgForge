import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'

/** Syntax colors come from CSS variables so the editor follows the app theme. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--syn-keyword)', fontWeight: '500' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className], color: 'var(--path-schema)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--accent-strong)' },
  { tag: [tags.variableName, tags.propertyName, tags.name], color: 'var(--syn-ident)' },
  { tag: tags.punctuation, color: 'var(--text-muted)' },
])

export function sqlHighlighting(): Extension {
  return syntaxHighlighting(highlight)
}
