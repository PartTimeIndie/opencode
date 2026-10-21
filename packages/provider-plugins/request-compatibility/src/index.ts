import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
import { ProviderTransform } from "./transform"
import { selectSmallModel } from "./small-model"
export default {
  id: "request-compatibility",
  transforms: ProviderTransform,
  selectSmallModel,
  async provider() {},
} satisfies ProviderPluginModule
