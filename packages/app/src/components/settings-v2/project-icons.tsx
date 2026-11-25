import { For, Show, createMemo } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { getProjectAvatarVariant } from "@/context/layout"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { displayName, getProjectAvatarMonochrome, getProjectAvatarSource } from "@/pages/layout/helpers"
import { DialogEditProject } from "../dialog-edit-project"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

export function SettingsProjectIcons() {
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const server = useServer()
  const projects = createMemo(() => server.current ? global.createServerCtx(server.current).projects.inventory() : [])

  return (
    <div class="settings-v2-section" data-action="settings-project-icons">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.projectIcons")}</h3>
      <Show when={projects().length > 0} fallback={<p>{language.t("settings.general.projectIcons.empty")}</p>}>
        <SettingsListV2>
          <For each={projects()}>
            {(project) => (
              <SettingsRowV2 title={displayName(project)} description={<span class="break-all">{project.worktree}</span>}>
                <div class="flex items-center gap-2">
                  <ProjectAvatar
                    fallback={displayName(project)}
                    src={getProjectAvatarSource(project.id, project.icon)}
                    monochrome={getProjectAvatarMonochrome(project.id, project.icon)}
                    variant={getProjectAvatarVariant(project.icon?.color)}
                  />
                  <ButtonV2
                    size="small"
                    aria-label={`${language.t("common.edit")} ${displayName(project)} (${project.worktree})`}
                    onClick={() => {
                      const connection = server.current
                      if (!connection) return
                      dialog.push(() => <DialogEditProject project={project} server={connection} />)
                    }}
                  >
                    {language.t("common.edit")}
                  </ButtonV2>
                </div>
              </SettingsRowV2>
            )}
          </For>
        </SettingsListV2>
      </Show>
    </div>
  )
}
