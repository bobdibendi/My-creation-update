/**
 * Monaco worker bootstrap.
 *
 * Monaco 0.52 ESM resolves its web workers through `MonacoEnvironment`.
 * Without it, language features fall back to a local (main-thread) worker and
 * `$loadForeignModule` ends up calling `FileAccess.asBrowserUri()` with no
 * `_VSCODE_FILE_ROOT`, crashing with
 * `TypeError: Cannot read properties of undefined (reading 'toUrl')`.
 *
 * We therefore register dedicated Vite-bundled workers (?worker imports):
 * each entry ships a static request-handler factory (`initialize(...)`),
 * so Monaco never needs to resolve a runtime module URL.
 *
 * This module must be imported BEFORE anything that creates an editor.
 */
import type * as monacoType from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

const environment: monacoType.Environment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'json':
        return new jsonWorker()
      default:
        return new editorWorker()
    }
  },
}

// Guard against double-definition (HMR / duplicate imports).
if (!self.MonacoEnvironment?.getWorker) self.MonacoEnvironment = environment

export {}
