import { createEffect } from "solid-js"
import { useModels } from "./models"
import { usePermission } from "./permission"
import { safetyReviewBridgeWrite } from "./model-chain-safety-review-snapshot"

export function ModelChainSafetyReviewBridge() {
  const models = useModels()
  const permission = usePermission()

  createEffect(() => {
    const next = safetyReviewBridgeWrite({
      modelsReady: models.ready(),
      modelChainsReady: models.chain.ready(),
      permissionReady: permission.ready(),
      globalConfigReady: permission.globalConfigReady(),
      defaultChainID: models.chain.default(),
      chains: models.chain.list(),
      current: permission.globalSafetyReview(),
    })
    if (!next) return
    // Models owns the chain definition. Global config receives only this
    // validated bounded snapshot for host consumers that cannot read renderer
    // persistence, and it is the sole persisted safety-review source.
    void permission.setGlobalSafetyReview(next).catch(() => undefined)
  })

  return null
}
