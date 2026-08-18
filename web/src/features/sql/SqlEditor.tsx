import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { bracketMatching } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { AutocompleteData } from '@pgforge/shared'
import { sqlHighlighting } from './sql-theme.js'

export interface SqlEditorHandle {
  getText: () => string
  getSelection: () => string
  setText: (text: string) => void
}

function buildSchemaConfig(data: AutocompleteData | undefined): Record<string, string[]> {
  if (!data) return {}
  const schema: Record<string, string[]> = {}
  for (const s of data.schemas) {
    for (const table of s.tables) {
      schema[`${s.name}.${table.name}`] = table.columns
      // Unqualified lookup for the default schema.
      if (s.name === 'public') schema[table.name] = table.columns
    }
  }
  return schema
}

export function SqlEditor({
  initialText,
  autocompleteData,
  onChange,
  onRun,
  handleRef,
  placeholderText,
}: {
  initialText: string
  autocompleteData: AutocompleteData | undefined
  onChange: (text: string) => void
  onRun: () => void
  handleRef: (handle: SqlEditorHandle | null) => void
  placeholderText: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const onRunRef = useRef(onRun)
  const onChangeRef = useRef(onChange)
  onRunRef.current = onRun
  onChangeRef.current = onChange

  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: initialText,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightSelectionMatches(),
        placeholder(placeholderText),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onRunRef.current()
              return true
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        langCompartment.current.of(sql({ dialect: PostgreSQL, upperCaseKeywords: true })),
        sqlHighlighting(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    handleRef({
      getText: () => view.state.doc.toString(),
      getSelection: () => {
        const range = view.state.selection.main
        return range.empty ? '' : view.state.sliceDoc(range.from, range.to)
      },
      setText: (text) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      },
    })
    return () => {
      handleRef(null)
      view.destroy()
      viewRef.current = null
    }
    // The editor instance is created once per mount; content sync happens via handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: langCompartment.current.reconfigure(
        sql({
          dialect: PostgreSQL,
          upperCaseKeywords: true,
          schema: buildSchemaConfig(autocompleteData),
        }),
      ),
    })
  }, [autocompleteData])

  return <div ref={hostRef} className="sql-editor-host" />
}
