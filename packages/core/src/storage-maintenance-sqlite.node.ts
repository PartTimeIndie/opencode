import { DatabaseSync, type SQLInputValue } from "node:sqlite"

export class Database {
  readonly #native: DatabaseSync

  constructor(filename: string, options: { readonly readonly?: boolean; readonly strict?: boolean } = {}) {
    this.#native = new DatabaseSync(filename, { readOnly: options.readonly })
    this.#native.exec("PRAGMA busy_timeout = 5000")
  }

  query<Row, Params extends ReadonlyArray<unknown>>(query: string) {
    const statement = this.#native.prepare(query)
    return {
      get: (...params: Params) => statement.get(...(params as unknown as SQLInputValue[])) as Row | undefined,
      all: (...params: Params) => statement.all(...(params as unknown as SQLInputValue[])) as Row[],
      iterate: (...params: Params) => statement.iterate(...(params as unknown as SQLInputValue[])) as IterableIterator<Row>,
      finalize: () => undefined,
    }
  }

  prepare(query: string) {
    const statement = this.#native.prepare(query)
    return {
      run: (...params: ReadonlyArray<unknown>) => statement.run(...(params as SQLInputValue[])),
    }
  }

  run(query: string, params: ReadonlyArray<unknown> = []) {
    return this.#native.prepare(query).run(...(params as SQLInputValue[]))
  }

  transaction<Args extends ReadonlyArray<unknown>, Result>(callback: (...args: Args) => Result) {
    return (...args: Args) => {
      this.#native.exec("BEGIN")
      try {
        const result = callback(...args)
        this.#native.exec("COMMIT")
        return result
      } catch (cause) {
        this.#native.exec("ROLLBACK")
        throw cause
      }
    }
  }

  exec(query: string) {
    this.#native.exec(query)
  }

  close() {
    this.#native.close()
  }
}
