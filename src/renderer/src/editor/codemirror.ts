import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers
} from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#c58fd6' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#7ad3a2' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#e0b45f' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b6762', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#82b4f8' },
  { tag: [t.typeName, t.className, t.namespace], color: '#5fbfb8' },
  { tag: [t.propertyName, t.attributeName], color: '#d9a66b' },
  { tag: [t.tagName, t.heading], color: '#e5675c' },
  { tag: [t.link, t.url], color: '#82b4f8', textDecoration: 'underline' },
  { tag: t.invalid, color: '#e5675c' }
])

const theme = (fontFamily: string, fontSize: number): ReturnType<typeof EditorView.theme> =>
  EditorView.theme({
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg-app)', fontSize: `${fontSize}px` },
    '.cm-scroller': { fontFamily: `${fontFamily}, var(--font-mono)`, lineHeight: '1.55' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { backgroundColor: 'var(--bg-app)', color: 'var(--text-faint)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(217,166,107,.28)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(217,166,107,.16)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(217,166,107,.28)', outline: 'none' },
    '.cm-panels': { backgroundColor: 'var(--bg-elevated)', color: 'var(--text)', borderColor: 'var(--border)' },
    '.cm-panels input, .cm-panels button': { fontFamily: 'var(--font-ui)', fontSize: '12px' },
    '.cm-searchMatch': { backgroundColor: 'rgba(224,180,95,.3)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(224,180,95,.55)' }
  }, { dark: true })

/** Theme + highlighting shared by the editor and the diff view. */
export function viewExtensions(fontFamily: string, fontSize: number): Extension[] {
  return [syntaxHighlighting(highlight), theme(fontFamily, fontSize)]
}

/** Language support for a filename, or null when none matches / fails to load. */
export async function loadLanguage(path: string): Promise<Extension | null> {
  const desc = LanguageDescription.matchFilename(languages, path)
  if (!desc) return null
  return desc.load().catch(() => null)
}

export interface EditorHandle {
  view: EditorView
  /** Replace the whole document without firing onChange. */
  setDoc(text: string): void
  getDoc(): string
  /** Apply a new font to this editor without recreating it. */
  setFont(fontFamily: string, fontSize: number): void
  /** 1-based inclusive lines of a non-empty selection, else undefined. */
  selectedLines(): { fromLine: number; toLine: number } | undefined
  destroy(): void
}

export function createEditor(o: {
  parent: HTMLElement; doc: string; path: string; fontFamily: string; fontSize: number
  onChange(): void; onSave(): void
}): EditorHandle {
  const lang = new Compartment()
  const font = new Compartment()
  let silent = false
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), history(), drawSelection(),
        indentOnInput(), bracketMatching(), highlightSelectionMatches(), syntaxHighlighting(highlight),
        EditorState.allowMultipleSelections.of(true),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { o.onSave(); return true } },
          ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab
        ]),
        font.of(theme(o.fontFamily, o.fontSize)),
        lang.of([]),
        EditorView.updateListener.of((u) => { if (u.docChanged && !silent) o.onChange() })
      ]
    })
  })
  const desc = LanguageDescription.matchFilename(languages, o.path)
  if (desc) void desc.load().then((support) => { view.dispatch({ effects: lang.reconfigure(support) }) }).catch(() => undefined)
  return {
    view,
    setDoc(text) {
      silent = true
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      silent = false
    },
    getDoc: () => view.state.doc.toString(),
    setFont: (family, size) => view.dispatch({ effects: font.reconfigure(theme(family, size)) }),
    selectedLines() {
      const { from, to } = view.state.selection.main
      if (from === to) return undefined
      const a = view.state.doc.lineAt(from)
      let b = view.state.doc.lineAt(to)
      if (b.from === to && b.number > a.number) b = view.state.doc.line(b.number - 1) // selection ends at line start
      return { fromLine: a.number, toLine: b.number }
    },
    destroy: () => view.destroy()
  }
}
