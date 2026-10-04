import Editor, { type OnMount } from '@monaco-editor/react';
import { Bot, Save } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { call } from '../../api/client';
import { contextOptions } from '../../commands';
import { languageFor, useEditor } from '../../state/editor';
import { useAi, useApp } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { useAllProblems } from '../panels/problems';
import { monaco } from './monacoSetup';

type Ed = Parameters<OnMount>[0];

const SEVERITY = { info: monaco.MarkerSeverity.Info, warning: monaco.MarkerSeverity.Warning, error: monaco.MarkerSeverity.Error, blocking: monaco.MarkerSeverity.Error } as const;

export function CodeEditor({ path }: { path: string }) {
  const file = useEditor((s) => s.files[path]);
  const { open, update, save, reload, setCursor } = useEditor();
  const reveal = useUi((s) => s.reveal);
  const settings = useApp((s) => s.settings);
  const problems = useAllProblems();
  const editorRef = useRef<Ed | null>(null);

  useEffect(() => {
    void open(path);
  }, [open, path]);

  // Diagnostics for this file as Monaco markers.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const markers = problems
      .filter((d) => d.target?.file === path && d.target.line)
      .map((d) => {
        const line = Math.min(d.target!.line!, model.getLineCount());
        const col = d.target!.column ?? 1;
        return {
          severity: SEVERITY[d.severity],
          message: `${d.message}${d.hint ? `\n${d.hint}` : ''}`,
          source: d.source,
          code: d.code,
          startLineNumber: line,
          startColumn: col,
          endLineNumber: line,
          endColumn: Math.max(col + 1, model.getLineMaxColumn(line)),
        };
      });
    monaco.editor.setModelMarkers(model, 'iotos', markers);
  }, [problems, path, file?.saved]);

  useEffect(() => {
    if (reveal && reveal.path === path && editorRef.current) {
      editorRef.current.revealLineInCenter(reveal.line);
      editorRef.current.setPosition({ lineNumber: reveal.line, column: reveal.column });
      editorRef.current.focus();
    }
  }, [reveal, path, file !== undefined]);

  if (!file) return <div className="empty">Loading {path}…</div>;
  const dirty = file.content !== file.saved;
  return (
    <>
      {file.conflict && (
        <div className="editor-banner">
          <span className="grow">This file changed on disk while you had unsaved edits.</span>
          <button className="btn sm" onClick={() => void reload(path)}>
            Reload from disk
          </button>
          <button className="btn sm" onClick={() => void save(path, true)}>
            Overwrite
          </button>
        </div>
      )}
      <div className="toolbar" style={{ background: 'var(--bg-2)' }}>
        <span className="mono faint ellipsis grow">{path}</span>
        <button
          className="btn sm ghost"
          title="Explain this file with AI"
          onClick={() => {
            const sel = editorRef.current?.getModel()?.getValueInRange(editorRef.current.getSelection()!) ?? '';
            void useAi.getState().run('Explaining', () => call('ai.explain', { subject: sel.trim() ? `this code from ${path}:\n\`\`\`\n${sel}\n\`\`\`` : `the file ${path}`, options: contextOptions() }));
          }}
        >
          <Bot size={12} /> Explain
        </button>
        <button className="btn sm ghost" disabled={!dirty} onClick={() => void save(path)} title="Save (⌘/Ctrl+S)">
          <Save size={12} /> Save
        </button>
      </div>
      <div className="monaco-host" data-testid="code-editor">
        <Editor
          path={path}
          language={languageFor(path)}
          theme="iotos-dark"
          value={file.content}
          onChange={(v) => update(path, v ?? '')}
          onMount={(ed) => {
            editorRef.current = ed;
            ed.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, column: e.position.column }));
            ed.onDidBlurEditorText(() => setCursor(null));
          }}
          options={{
            fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
            fontSize: settings?.editor.fontSize ?? 13,
            wordWrap: settings?.editor.wordWrap ? 'on' : 'off',
            minimap: { enabled: true, scale: 1, renderCharacters: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            smoothScrolling: true,
            automaticLayout: true,
            tabSize: path.endsWith('.py') ? 4 : 2,
            readOnly: path.startsWith('.iotos/'),
            fixedOverflowWidgets: true,
          }}
        />
      </div>
    </>
  );
}
