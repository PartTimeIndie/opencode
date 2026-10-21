// Exercise the exact independently owned provider declarations in normalization tests.
export const requestProfiles = Object.assign({}, ...(await Promise.all([
  import("../../../provider-plugins/openai/src/request-profiles"),
  import("../../../provider-plugins/openai-compatible/src/request-profiles"),
  import("../../../provider-plugins/anthropic/src/request-profiles"),
  import("../../../provider-plugins/openrouter/src/request-profiles"),
])).map((module) => module.requestProfiles))

export const nativeModels = Object.assign({}, ...(await Promise.all([
  import("../../../provider-plugins/openai/src/native"),
  import("../../../provider-plugins/openai-compatible/src/native"),
  import("../../../provider-plugins/anthropic/src/native"),
  import("../../../provider-plugins/openrouter/src/native"),
])).map((module) => module.nativeModels))
