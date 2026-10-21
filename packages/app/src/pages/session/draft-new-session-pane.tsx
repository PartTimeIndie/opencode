import { createEffect, createMemo, onMount, untrack, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { useSearchParams } from "@solidjs/router"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { NewSessionDesignView } from "@/components/session"
import { StatusPopoverV2 } from "@/components/status-popover"
import { CommentsProvider, useComments } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { createDraftPromptState, PromptProvider, usePrompt } from "@/context/prompt"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePlatform } from "@/context/platform"
import { TerminalProvider } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import type { DraftTab } from "@/context/tabs"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { focusWithoutStealing } from "@/utils/focus"
import { useTitlebarRightMount } from "@/components/titlebar"

export function DraftNewSessionPane(props: { draft: DraftTab }) {
  return (
    <Show when={props.draft.directory} keyed>
      {(directory) => (
        <SDKProvider directory={directory}>
          <DirectoryDataProvider directory={directory} draftID={props.draft.draftID}>
            <TerminalProvider>
              <FileProvider>
                <PromptProvider>
                  <CommentsProvider>
                    <NewSessionContent draftID={props.draft.draftID} readPromptFromSearch={false} />
                  </CommentsProvider>
                </PromptProvider>
              </FileProvider>
            </TerminalProvider>
          </DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}

export function NewSessionContent(props: { draftID?: string; readPromptFromSearch?: boolean }) {
  const contextPrompt = usePrompt()
  const platform = usePlatform()
  const prompt = props.draftID ? createDraftPromptState(props.draftID, platform) : contextPrompt
  const sdk = useSDK()
  const sync = useSync()
  const comments = useComments()
  const language = useLanguage()
  const settings = useSettings()
  const rightMount = useTitlebarRightMount()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()

  let inputRef: HTMLDivElement | undefined

  const composer = createSessionComposerState()

  const [store, setStore] = createStore({
    worktree: "main",
  })

  const newSessionWorktree = createMemo(() => {
    if (store.worktree === "create") return "create"
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })

  createEffect(() => {
    if (props.readPromptFromSearch === false) return
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  onMount(() => {
    requestAnimationFrame(() => focusWithoutStealing(inputRef))
  })

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Show when={settings.visibility.status()}>
              <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                <StatusPopoverV2 />
              </Tooltip>
            </Show>
          </Portal>
        )}
      </Show>
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <div class="@container relative flex flex-col min-h-0 h-full flex-1">
          <div class="flex-1 min-h-0 overflow-hidden rounded-[10px]">
            <NewSessionDesignView>
              <SessionComposerRegion
                state={composer}
                ready
                centered={false}
                placement="inline"
                draftID={props.draftID}
                promptState={prompt}
                inputRef={(el) => {
                  inputRef = el
                }}
                newSessionWorktree={newSessionWorktree()}
                onNewSessionWorktreeReset={() => setStore("worktree", "main")}
                onSubmit={() => comments.clear()}
                onResponseSubmit={() => {}}
                setPromptDockRef={() => {}}
              />
            </NewSessionDesignView>
          </div>
        </div>
      </div>
    </div>
  )
}
