// V8 keeps function closures in an Error's lazy stack. A signal can outlive
// its view, so never create its abort reason on a UI cleanup call stack.
const disposed = new DOMException("Plugin disposed", "AbortError")
disposed.stack = ""
Object.freeze(disposed)

export function abortPluginWork(controller: AbortController) {
  controller.abort(disposed)
}
