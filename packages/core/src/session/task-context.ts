export * as TaskContext from "./task-context"

import { Schema } from "effect"

/** Initial conversation history, independent of workspace and permissions. */
export const Mode = Schema.Literals(["fork", "fresh"])
export type Mode = typeof Mode.Type
