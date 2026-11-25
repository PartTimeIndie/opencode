interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../opencode/dist/types/src/node").Server.listen
    export type Listener = import("../../../opencode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../opencode/dist/types/src/node").Config.get
    export type Info = import("../../../opencode/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../opencode/dist/types/src/node").bootstrap
  export namespace DesktopRecovery {
    export const configure: (input: { ownerID: string; previousOwners: readonly string[] }, onOwner: (ownerID: string) => void) => void
  }
  export namespace CrashActivity {
    export const configure: (sink: (update: import("./sidecar-diagnostics").SidecarActivityUpdate) => void) => void
  }
  export namespace StorageWorker {
    export const run: (args: ReadonlyArray<string>) => Promise<void>
  }
}
