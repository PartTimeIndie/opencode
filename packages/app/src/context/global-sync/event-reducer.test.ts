import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, Project, SurfaceBlockingRequest, Session } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"
import { isV2PermissionRequest } from "../permission-request"
import { sessionActivity } from "@/utils/session-activity"

const rootSession = (input: { id: string; parentID?: string; archived?: number; revert?: Session["revert"] }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    revert: input.revert,
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) as Session

const userMessage = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    mode: "blocking",
    revision: 1,
    actions: [],
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const textPart = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

const permissionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    permission: title,
    patterns: ["*"],
    metadata: {},
    always: [],
  }) as PermissionRequest

const questionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    questions: [
      {
        question: title,
        header: title,
        options: [{ label: title, description: title }],
      },
    ],
  }) as SurfaceBlockingRequest

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    turnCompletion: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

describe("applyGlobalEvent", () => {
  test("upserts project.updated in sorted position", () => {
    const project = [{ id: "a" }, { id: "c" }] as Project[]
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "project.updated", properties: { id: "b" } },
      project,
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject(next) {
        if (typeof next === "function") next(project)
      },
    })

    expect(project.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(refreshCount).toBe(0)
  })

  test("handles global.disposed by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "global.disposed" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(1)
  })

  test("ignores server.connected because reconnects are not invalidations", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "server.connected" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(0)
  })
})

describe("applyDirectoryEvent", () => {
  test("initializes text delta accumulation from the current part text", () => {
    const part = { ...textPart("part", "session", "message"), text: "existing" }
    const [store, setStore] = createStore(baseState({ part: { message: [part] } }))

    applyDirectoryEvent({
      event: {
        type: "message.part.delta",
        properties: { messageID: "message", partID: "part", field: "text", delta: " appended" },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part_text_accum_delta.part).toBe("existing appended")
    expect((store.part.message?.[0] as { text: string }).text).toBe("existing appended")
  })

  test("preserves a Home-specific retained session limit", () => {
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [rootSession({ id: "a" }), rootSession({ id: "b" }), rootSession({ id: "c" })],
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "d" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      retainedLimit: 3,
    })

    expect(store.session).toHaveLength(3)
  })

  test("inserts root sessions in sorted order and updates sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "b" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b"])
    expect(store.sessionTotal).toBe(2)

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "c", parentID: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.sessionTotal).toBe(2)
  })

  test("an archived uncached session does not interrupt later status events", () => {
    const [store, setStore] = createStore(baseState({ session: [], sessionTotal: 2 }))
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({ event, store, setStore, push() {}, directory: "/tmp", loadLsp() {} })
    expect(() => apply({ type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } })).not.toThrow()
    apply({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "busy" } } })
    expect(store.session_status.ses_2?.type).toBe("busy")
  })

  test("cleans session caches when archived", () => {
    const message = userMessage("msg_1", "ses_1")
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" }), rootSession({ id: "ses_2" })],
        sessionTotal: 2,
        message: { ses_1: [message] },
        part: { [message.id]: [textPart("prt_1", "ses_1", message.id)] },
        session_diff: { ses_1: [] },
        todo: { ses_1: [] },
        permission: { ses_1: [] },
        question: { ses_1: [] },
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)
    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
  })

  test("applies V2 semantic title updates without waiting for a session refresh", () => {
    const [store, setStore] = createStore(
      baseState({ session: [{ ...rootSession({ id: "ses_1" }), title: "New session - 2026-07-11" }] }),
    )

    applyDirectoryEvent({
      event: {
        type: "session.next.title.updated",
        properties: { sessionID: "ses_1", title: "Semantic session title", timestamp: 42 },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session[0]?.title).toBe("Semantic session title")
    expect(store.session[0]?.time.updated).toBe(42)
  })

  test("applies semantic metadata patches without replacing unrelated keys", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [
          {
            ...rootSession({ id: "ses_1" }),
            metadata: { "opencode.session.goal": "keep this", other: true },
          } as Session,
        ],
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "session.next.metadata.patched",
        properties: { sessionID: "ses_1", set: { access_control: { mode: "always" } }, unset: ["other"] },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session[0]?.metadata).toEqual({
      "opencode.session.goal": "keep this",
      access_control: { mode: "always" },
    })
  })

  test("refreshes the directory when a semantic title arrives before its session", () => {
    const [store, setStore] = createStore(baseState())
    const pushes: string[] = []

    applyDirectoryEvent({
      event: {
        type: "session.next.title.updated",
        properties: { sessionID: "ses_1", title: "Semantic session title", timestamp: 42 },
      },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {},
    })

    expect(pushes).toEqual(["/tmp"])
    expect(store.session).toEqual([])
  })

  test("cleans session caches when deleted and decrements only root totals", () => {
    const cases = [
      { info: rootSession({ id: "ses_1" }), expectedTotal: 1 },
      { info: rootSession({ id: "ses_2", parentID: "ses_1" }), expectedTotal: 2 },
    ]

    for (const item of cases) {
      const message = userMessage("msg_1", item.info.id)
      const [store, setStore] = createStore(
        baseState({
          session: [
            rootSession({ id: "ses_1" }),
            rootSession({ id: "ses_2", parentID: "ses_1" }),
            rootSession({ id: "ses_3" }),
          ],
          sessionTotal: 2,
          message: { [item.info.id]: [message] },
          part: { [message.id]: [textPart("prt_1", item.info.id, message.id)] },
          session_diff: { [item.info.id]: [] },
          todo: { [item.info.id]: [] },
          permission: { [item.info.id]: [] },
          question: { [item.info.id]: [] },
          session_status: { [item.info.id]: { type: "busy" } },
        }),
      )

      applyDirectoryEvent({
        event: { type: "session.deleted", properties: { info: item.info } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

      expect(store.session.find((x) => x.id === item.info.id)).toBeUndefined()
      expect(store.sessionTotal).toBe(item.expectedTotal)
      expect(store.message[item.info.id]).toBeUndefined()
      expect(store.part[message.id]).toBeUndefined()
      expect(store.session_diff[item.info.id]).toBeUndefined()
      expect(store.todo[item.info.id]).toBeUndefined()
      expect(store.permission[item.info.id]).toBeUndefined()
      expect(store.question[item.info.id]).toBeUndefined()
      expect(store.session_status[item.info.id]).toBeUndefined()
    }
  })

  test("cleans caches for trimmed idle sessions on session.created", () => {
    const dropped = rootSession({ id: "ses_b" })
    const kept = rootSession({ id: "ses_a" })
    const message = userMessage("msg_1", dropped.id)
    const todos: string[] = []
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [dropped],
        message: { [dropped.id]: [message] },
        part: { [message.id]: [textPart("prt_1", dropped.id, message.id)] },
        session_diff: { [dropped.id]: [] },
        todo: { [dropped.id]: [] },
        permission: { [dropped.id]: [] },
        question: { [dropped.id]: [] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: kept } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionTodo(_directory, sessionID, value) {
        if (value !== undefined) return
        todos.push(sessionID)
      },
    })

    expect(store.session.map((x) => x.id)).toEqual([kept.id])
    expect(store.message[dropped.id]).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_diff[dropped.id]).toBeUndefined()
    expect(store.todo[dropped.id]).toBeUndefined()
    expect(store.permission[dropped.id]).toBeUndefined()
    expect(store.question[dropped.id]).toBeUndefined()
    expect(store.session_status[dropped.id]).toBeUndefined()
    expect(todos).toEqual([dropped.id])
  })

  test("keeps working session caches when session list trimming runs", () => {
    const dropped = rootSession({ id: "ses_b" })
    const kept = rootSession({ id: "ses_a" })
    const message = userMessage("msg_1", dropped.id)
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [dropped],
        message: { [dropped.id]: [message] },
        part: { [message.id]: [textPart("prt_1", dropped.id, message.id)] },
        session_diff: { [dropped.id]: [] },
        todo: { [dropped.id]: [] },
        permission: { [dropped.id]: [] },
        question: { [dropped.id]: [] },
        session_status: { [dropped.id]: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: kept } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual([kept.id, dropped.id])
    expect(store.message[dropped.id]?.map((x) => x.id)).toEqual([message.id])
    expect(store.part[message.id]?.map((x) => x.id)).toEqual(["prt_1"])
    expect(store.session_diff[dropped.id]).toEqual([])
    expect(store.todo[dropped.id]).toEqual([])
    expect(store.permission[dropped.id]).toEqual([])
    expect(store.question[dropped.id]).toEqual([])
    expect(store.session_status[dropped.id]).toEqual({ type: "busy" })
  })

  test("cleanupDroppedSessionCaches clears part-only orphan state", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_keep" })],
        part: { msg_1: [textPart("prt_1", "ses_drop", "msg_1")] },
      }),
    )

    cleanupDroppedSessionCaches(store, setStore, store.session, "/tmp")

    expect(store.part.msg_1).toBeUndefined()
  })

  test("upserts and removes messages while clearing orphaned parts", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_3", sessionID)] },
        part: { msg_2: [textPart("prt_1", sessionID, "msg_2")] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_2", sessionID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2", "msg_3"])

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: {
            ...userMessage("msg_2", sessionID),
            role: "assistant",
          } as Message,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.find((x) => x.id === "msg_2")?.role).toBe("assistant")

    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: "msg_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_3"])
    expect(store.part.msg_2).toBeUndefined()
  })

  test("does not hydrate inactive timelines under sustained renderer event pressure", () => {
    const active = "ses_active"
    const inactive = Array.from({ length: 24 }, (_, index) => `ses_inactive_${index}`)
    const [store, setStore] = createStore(baseState({ message: { [active]: [] } }))

    for (let round = 0; round < 200; round++) {
      for (const sessionID of inactive) {
        const messageID = `msg_${sessionID}_${round}`
        applyDirectoryEvent({
          event: { type: "message.updated", properties: { info: userMessage(messageID, sessionID) } },
          store,
          setStore,
          push() {},
          directory: "/tmp",
          loadLsp() {},
        })
        applyDirectoryEvent({
          event: {
            type: "message.part.updated",
            properties: { part: textPart(`prt_${sessionID}_${round}`, sessionID, messageID) },
          },
          store,
          setStore,
          push() {},
          directory: "/tmp",
          loadLsp() {},
        })
      }
    }

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_active", active) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: textPart("prt_active", active, "msg_active") },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(Object.keys(store.message)).toEqual([active])
    expect(store.message[active]?.map((message) => message.id)).toEqual(["msg_active"])
    expect(Object.keys(store.part)).toEqual(["msg_active"])
  })

  test("projects nested child events when an ancestor timeline is active", () => {
    const parent = "ses_parent"
    const child = "ses_child"
    const messageID = "msg_child"
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: parent }), rootSession({ id: child, parentID: parent })],
        message: { [parent]: [] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage(messageID, child) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_child_control_panel",
            sessionID: child,
            messageID,
            type: "custom",
            kind: "opencode/control-panel",
            data: { version: 1, controlID: "child-control-panel" },
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[child]?.map((message) => message.id)).toEqual([messageID])
    expect(store.part[messageID]?.map((part) => part.id)).toEqual(["prt_child_control_panel"])
  })

  test("removes every message reported by v2 revert cleanup", () => {
    const sessionID = "ses_1"
    const revert = { messageID: "msg_2" }
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: sessionID, revert })],
        message: {
          [sessionID]: [
            userMessage("msg_1", sessionID),
            userMessage("msg_2", sessionID),
            userMessage("msg_3", sessionID),
          ],
        },
        part: {
          msg_2: [textPart("prt_2", sessionID, "msg_2")],
          msg_3: [textPart("prt_3", sessionID, "msg_3")],
        },
        part_text_accum_delta: { prt_2: "stale two", prt_3: "stale three" },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "session.next.revert.cleaned",
        properties: { sessionID, revert, messageIDs: ["msg_2", "msg_3"] },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual(["msg_1"])
    expect(store.part.msg_2).toBeUndefined()
    expect(store.part.msg_3).toBeUndefined()
    expect(store.part_text_accum_delta.prt_2).toBeUndefined()
    expect(store.part_text_accum_delta.prt_3).toBeUndefined()
    expect(store.session[0]?.revert).toBeUndefined()
  })

  test("truncates the retained assistant at the v2 part revert boundary", () => {
    const sessionID = "ses_1"
    const messageID = "msg_assistant"
    const revert = { messageID, partID: "text-second-part" }
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: sessionID, revert })],
        message: {
          [sessionID]: [
            userMessage("msg_user", sessionID),
            { ...userMessage(messageID, sessionID), role: "assistant" } as Message,
            userMessage("msg_later", sessionID),
          ],
        },
        part: {
          [messageID]: [
            textPart(`${messageID}:text-first-part`, sessionID, messageID),
            textPart(`${messageID}:text-second-part`, sessionID, messageID),
            textPart(`${messageID}:text-third-part`, sessionID, messageID),
          ],
          msg_later: [textPart("msg_later:text", sessionID, "msg_later")],
        },
        part_text_accum_delta: {
          [`${messageID}:text-first-part`]: "keep",
          [`${messageID}:text-second-part`]: "remove",
          [`${messageID}:text-third-part`]: "remove",
          "msg_later:text": "remove",
        },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "session.next.revert.cleaned",
        properties: { sessionID, timestamp: 2, revert, messageIDs: ["msg_later"] },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual(["msg_user", messageID])
    expect(store.part[messageID]?.map((part) => part.id)).toEqual([`${messageID}:text-first-part`])
    expect(store.part_text_accum_delta[`${messageID}:text-first-part`]).toBe("keep")
    expect(store.part_text_accum_delta[`${messageID}:text-second-part`]).toBeUndefined()
    expect(store.part_text_accum_delta[`${messageID}:text-third-part`]).toBeUndefined()
    expect(store.part.msg_later).toBeUndefined()
    expect(store.part_text_accum_delta["msg_later:text"]).toBeUndefined()
    expect(store.session[0]?.revert).toBeUndefined()
  })

  test("does not clear a newer revert when stale cleanup arrives", () => {
    const sessionID = "ses_1"
    const current = { messageID: "msg_2", partID: "part_new" }
    const [store, setStore] = createStore(baseState({ session: [rootSession({ id: sessionID, revert: current })] }))

    applyDirectoryEvent({
      event: {
        type: "session.next.revert.cleaned",
        properties: {
          sessionID,
          revert: { messageID: "msg_2", partID: "part_old" },
          messageIDs: [],
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session[0]?.revert).toEqual(current)
  })

  test.each(["legacy-first", "v2-first"] as const)("keeps one attachment representation for %s file events", (order) => {
    const sessionID = "ses_images"
    const messageID = "msg_images"
    const legacy: Part = {
      id: "prt_clipboard", sessionID, messageID, type: "file", mime: "image/png",
      filename: "image.png", url: "data:image/png;base64,AA==",
    }
    const projected = { ...legacy, id: `${messageID}:file:0`, url: "attachment://att_1" }
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [userMessage(messageID, sessionID)] } }))
    const apply = (part: Part) => applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part } },
      store, setStore, push() {}, directory: "/tmp", loadLsp() {},
    })
    for (const part of order === "legacy-first" ? [legacy, projected] : [projected, legacy]) apply(part)
    expect(store.part[messageID]).toEqual([projected])
    // Identical names/content are still separate attachments at different V2 slots.
    const second = { ...projected, id: `${messageID}:file:1` }
    apply(second)
    apply(legacy)
    expect(store.part[messageID]).toEqual([projected, second])
  })

  test("upserts and prunes message parts", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage(messageID, sessionID)] },
        part: { [messageID]: [textPart("prt_1", sessionID, messageID), textPart("prt_3", sessionID, messageID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: textPart("prt_2", sessionID, messageID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.part[messageID]?.map((x) => x.id)).toEqual(["prt_1", "prt_2", "prt_3"])

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart("prt_2", sessionID, messageID),
            text: "changed",
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    const updated = store.part[messageID]?.find((x) => x.id === "prt_2")
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("changed")

    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_3" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part[messageID]).toBeUndefined()
  })

  test("keeps accumulated streaming text when a stale part snapshot arrives", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage(messageID, sessionID)] },
        part: {
          [messageID]: [{ ...textPart("prt_1", sessionID, messageID), text: "visible streamed text" } as Part],
        },
        part_text_accum_delta: { prt_1: "visible streamed text" },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: { ...textPart("prt_1", sessionID, messageID), text: "visible" } as Part },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    const updated = store.part[messageID]?.[0]
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("visible streamed text")
    expect(store.part_text_accum_delta.prt_1).toBe("visible streamed text")
  })

  test("accepts complete part snapshots after streaming catches up", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage(messageID, sessionID)] },
        part: {
          [messageID]: [{ ...textPart("prt_1", sessionID, messageID), text: "visible streamed text" } as Part],
        },
        part_text_accum_delta: { prt_1: "visible streamed text" },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: { ...textPart("prt_1", sessionID, messageID), text: "visible streamed text done" } as Part },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    const updated = store.part[messageID]?.[0]
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("visible streamed text done")
    expect(store.part_text_accum_delta.prt_1).toBeUndefined()
  })

  test("drops a divergent stale accum snippet in favor of the current snapshot", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage(messageID, sessionID)] },
        part: {
          [messageID]: [{ ...textPart("prt_1", sessionID, messageID), text: "Docker bleibt ein Blocker." } as Part],
        },
        part_text_accum_delta: { prt_1: "Loading messages..." },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: { ...textPart("prt_1", sessionID, messageID), text: "Docker bleibt ein Blocker." } as Part },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    const updated = store.part[messageID]?.[0]
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("Docker bleibt ein Blocker.")
    expect(store.part_text_accum_delta.prt_1).toBeUndefined()
  })

  test("tracks permission and question request lifecycles", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        permission: { [sessionID]: [permissionRequest("perm_1", sessionID), permissionRequest("perm_3", sessionID)] },
        question: { [sessionID]: [questionRequest("q_1", sessionID), questionRequest("q_3", sessionID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_2", "perm_3"])

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.find((x) => x.id === "perm_2")?.permission).toBe("updated")

    applyDirectoryEvent({
      event: { type: "permission.replied", properties: { sessionID, requestID: "perm_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_3"])

    applyDirectoryEvent({
      event: { type: "surface.asked", properties: questionRequest("q_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_2", "q_3"])

    applyDirectoryEvent({
      event: { type: "surface.asked", properties: questionRequest("q_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    const updated = store.question[sessionID]?.find((x) => x.id === "q_2")
    expect(updated?.mode === "blocking" ? updated.questions[0]?.header : undefined).toBe("updated")

    applyDirectoryEvent({
      event: { type: "surface.dismissed", properties: { sessionID, requestID: "q_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_3"])
  })

  test("applies V2 question lifecycle events exactly once", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(baseState())
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })
    const request = questionRequest("q_v2", sessionID)

    apply({ type: "surface.asked", properties: request })
    apply({ type: "surface.asked", properties: request })
    expect(store.question[sessionID]?.map((question) => question.id)).toEqual(["q_v2"])

    apply({ type: "surface.replied", properties: { sessionID, requestID: "q_v2", answers: [["Yes"]] } })
    apply({ type: "surface.replied", properties: { sessionID, requestID: "q_v2", answers: [["Yes"]] } })
    apply({ type: "surface.asked", properties: request })
    expect(store.question[sessionID]).toEqual([])
  })

  test("does not reopen a rejected question from a replayed asked event", () => {
    const sessionID = "ses_settled_question_replay"
    const request = questionRequest("q_settled_question_replay", sessionID)
    const [store, setStore] = createStore(baseState())
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

    apply({ type: "surface.asked", properties: request })
    apply({ type: "surface.dismissed", properties: { sessionID, requestID: request.id } })
    apply({ type: "surface.asked", properties: request })

    expect(store.question[sessionID]).toEqual([])
  })

  test("normalizes V2 permission lifecycle events exactly once", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(baseState())
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })
    const request = {
      id: "per_v2",
      sessionID,
      action: "external_directory",
      resources: ["C:/Users/test/.config/opencode/*"],
      save: ["C:/Users/test/.config/opencode/*"],
      source: { type: "tool" as const, messageID: "msg_1", callID: "call_1" },
    }

    apply({ type: "permission.v2.asked", properties: request })
    apply({ type: "permission.v2.asked", properties: request })
    expect(store.permission[sessionID]?.map((permission) => permission.id)).toEqual(["per_v2"])
    expect(store.permission[sessionID]?.[0]).toMatchObject({
      permission: "external_directory",
      patterns: request.resources,
      always: request.save,
      tool: { messageID: "msg_1", callID: "call_1" },
    })
    expect(isV2PermissionRequest(store.permission[sessionID]![0]!)).toBe(true)

    apply({ type: "permission.v2.replied", properties: { sessionID, requestID: request.id, reply: "once" } })
    apply({ type: "permission.v2.replied", properties: { sessionID, requestID: request.id, reply: "once" } })
    expect(store.permission[sessionID]).toEqual([])
  })

  test("clears turn completion when a session becomes active again", () => {
    const sessionID = "ses_1"
    const cleared: string[] = []
    const [store, setStore] = createStore(
      baseState({
        turnCompletion: { [sessionID]: "incomplete" },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionTurnCompletion(_directory, id, status) {
        if (status === undefined) cleared.push(id)
      },
    })

    expect(store.turnCompletion[sessionID]).toBeUndefined()
    expect(cleared).toEqual([sessionID])
  })

  test("updates vcs branch in store and cache", () => {
    const [store, setStore] = createStore(baseState({ vcs: { branch: "main", default_branch: "main" } }))
    const [cacheStore, setCacheStore] = createStore({
      value: { branch: "main", default_branch: "main" } as State["vcs"],
    })

    applyDirectoryEvent({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/test" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      vcsCache: {
        store: cacheStore,
        setStore: setCacheStore,
        ready: () => true,
      },
    })

    expect(store.vcs).toEqual({ branch: "feature/test", default_branch: "main" })
    expect(cacheStore.value).toEqual({ branch: "feature/test", default_branch: "main" })
  })

  test("routes disposal and lsp events to side-effect handlers", () => {
    const [store, setStore] = createStore(baseState())
    const pushes: string[] = []
    let lspLoads = 0

    applyDirectoryEvent({
      event: { type: "server.instance.disposed" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    applyDirectoryEvent({
      event: { type: "lsp.updated" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    expect(pushes).toEqual(["/tmp"])
    expect(lspLoads).toBe(1)
  })

  test("maps v2 activity lifecycle events to busy and idle session status", () => {
    const sessionID = "ses_v2_activity"
    const [store, setStore] = createStore(baseState())
    const apply = (type: string) =>
      applyDirectoryEvent({
        event: { type, properties: { sessionID, activityID: "activity_1" } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

    apply("session.next.activity.started")
    expect(store.session_status[sessionID]).toEqual({ type: "busy" })
    apply("session.next.activity.completed")
    expect(store.session_status[sessionID]).toEqual({ type: "idle" })
  })

  test("ignores delayed duplicate lifecycle events from a completed activity", () => {
    const sessionID = "ses_v2_activity_order"
    const [store, setStore] = createStore(baseState())
    const apply = (type: string, activityID: string) =>
      applyDirectoryEvent({
        event: { type, properties: { sessionID, activityID } },
        store,
        setStore,
        push() {},
        directory: "/activity-order",
        loadLsp() {},
      })

    apply("session.next.activity.started", "activity_a")
    apply("session.next.activity.completed", "activity_a")
    apply("session.next.activity.started", "activity_b")
    apply("session.next.activity.started", "activity_a")
    apply("session.next.activity.completed", "activity_a")

    expect(store.session_status[sessionID]).toEqual({ type: "busy" })
  })

  test("does not resurrect busy when a completed activity start is replayed", () => {
    const sessionID = "ses_v2_activity_interrupt"
    const [store, setStore] = createStore(baseState())
    const apply = (type: string, activityID: string) =>
      applyDirectoryEvent({
        event: { type, properties: { sessionID, activityID } },
        store,
        setStore,
        push() {},
        directory: "/activity-interrupt",
        loadLsp() {},
      })

    apply("session.next.activity.started", "activity_a")
    apply("session.next.activity.interrupted", "activity_a")
    apply("session.next.activity.started", "activity_a")

    expect(store.session_status[sessionID]).toEqual({ type: "idle" })
  })

  test("finishes leftover client activity on idle once the latest assistant has settled", () => {
    const directory = "/idle-settled-activity"
    const sessionID = "ses_idle_settled"
    const [store, setStore] = createStore({
      ...baseState(),
      message: {
        [sessionID]: [{ id: "msg_final", role: "assistant" as const, finish: "stop", time: { completed: 1 } } as Message],
      },
      part: { msg_final: [{ type: "text" }] as Part[] },
    } as State)
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory,
        loadLsp() {},
      })

    apply({ type: "session.next.activity.started", properties: { sessionID, activityID: "activity_stuck" } })
    expect(sessionActivity(directory, sessionID)?.type).toBe("busy")

    apply({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    expect(sessionActivity(directory, sessionID)).toBeUndefined()
    expect(store.session_status[sessionID]).toEqual({ type: "idle" })
  })

  test("keeps client activity through a premature idle snapshot while tools are still running", () => {
    const directory = "/idle-premature-activity"
    const sessionID = "ses_idle_premature"
    const [store, setStore] = createStore({
      ...baseState(),
      message: {
        [sessionID]: [{ id: "msg_tools", role: "assistant" as const, finish: "tool-calls", time: { completed: 1 } } as Message],
      },
      part: { msg_tools: [{ type: "tool", state: { status: "running" } }] as Part[] },
    } as State)
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory,
        loadLsp() {},
      })

    apply({ type: "session.next.activity.started", properties: { sessionID, activityID: "activity_live" } })
    apply({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    expect(sessionActivity(directory, sessionID)?.type).toBe("busy")
  })

  test("ignores obsolete completion states from session.turn.completed", () => {
    const sessionID = "ses_obsolete_completion"
    const [store, setStore] = createStore(baseState())
    applyDirectoryEvent({
      event: { type: "session.turn.completed", properties: { sessionID, status: "obsolete" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.turnCompletion[sessionID]).toBeUndefined()
  })

  test("ignores turn completion verdicts while the session is still active", () => {
    // A deferred verdict from an earlier activity can be published while an auto-resumed
    // activity is already streaming. Storing it would show the red incomplete badge next
    // to live output; the running state wins until the newer activity settles.
    const sessionID = "ses_completion_while_busy"
    const [store, setStore] = createStore(baseState({ session_status: { [sessionID]: { type: "busy" } } }))
    applyDirectoryEvent({
      event: { type: "session.turn.completed", properties: { sessionID, status: "incomplete" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.session_status[sessionID]).toEqual({ type: "busy" })
    expect(store.turnCompletion[sessionID]).toBeUndefined()
  })

  test("stores turn completion verdicts once the session is idle again", () => {
    const sessionID = "ses_completion_idle"
    const [store, setStore] = createStore(baseState({ session_status: { [sessionID]: { type: "idle" } } }))
    applyDirectoryEvent({
      event: { type: "session.turn.completed", properties: { sessionID, status: "incomplete" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.turnCompletion[sessionID]).toBe("incomplete")
  })

  test("stores an unknown completion verdict once the session is idle again", () => {
    const sessionID = "ses_completion_unknown"
    const [store, setStore] = createStore(baseState({ session_status: { [sessionID]: { type: "idle" } } }))
    applyDirectoryEvent({
      event: { type: "session.turn.completed", properties: { sessionID, status: "unknown" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.turnCompletion[sessionID]).toBe("unknown")
  })

  test("replaces todo snapshots that have no stable item id", () => {
    const sessionID = "ses_todo_snapshot"
    const [store, setStore] = createStore(
      baseState({
        todo: {
          [sessionID]: [{ content: "Old task", priority: "low", status: "pending" }],
        },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "todo.updated",
        properties: {
          sessionID,
          todos: [
            { content: "Finish implementation", priority: "high", status: "pending" },
            { content: "Run Visual QA", priority: "medium", status: "pending" },
          ],
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.todo[sessionID]).toEqual([
      { content: "Finish implementation", priority: "high", status: "pending" },
      { content: "Run Visual QA", priority: "medium", status: "pending" },
    ])
  })

  test("clears a stale terminal state when a session becomes active again", () => {
    const sessionID = "ses_stale_completion"
    const cleared: string[] = []
    const [store, setStore] = createStore(
      baseState({
        turnCompletion: { [sessionID]: "done" },
      }),
    )
    applyDirectoryEvent({
      event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionTurnCompletion(_directory, id, status) {
        if (status === undefined) cleared.push(id)
      },
    })
    expect(store.turnCompletion[sessionID]).toBeUndefined()
    expect(cleared).toEqual([sessionID])
  })
})
