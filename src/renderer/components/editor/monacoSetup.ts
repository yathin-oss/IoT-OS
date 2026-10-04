import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';

/** Use the bundled Monaco (no CDN) with local workers; register firmware file types. */
export function setupMonaco(): void {
  self.MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      return label === 'json' ? new JsonWorker() : new EditorWorker();
    },
  };
  loader.config({ monaco });
  monaco.languages.register({ id: 'cpp', extensions: ['.ino'] });
  monaco.editor.defineTheme('iotos-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a7383', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'number', foreground: 'f5a97f' },
      { token: 'string', foreground: 'a6da95' },
      { token: 'type', foreground: '7dc4e4' },
    ],
    colors: {
      'editor.background': '#181b21',
      'editor.lineHighlightBackground': '#1f232b',
      'editorLineNumber.foreground': '#4a515d',
      'editorLineNumber.activeForeground': '#9aa3b2',
      'editorGutter.background': '#181b21',
      'editor.selectionBackground': '#2a4a78',
      'editorWidget.background': '#1e2229',
      'editorWidget.border': '#343a45',
    },
  });
}

export { monaco };
