import { Option, Schema } from "effect"

const zaiErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  error: Schema.Struct({ code: Schema.Union([Schema.String, Schema.Number]) }),
})))

/** Z.AI business codes are read from the JSON envelope, never from translated prose. */
export function zaiRateLimitCode(body: unknown) {
  const decoded = Option.getOrUndefined(zaiErrorBody(body))
  const code = String(decoded?.error.code)
  if (code === "1302" || code === "1308" || code === "1310") return code
  return undefined
}

/** Account quota is terminal; an explicit minute token window is not. */
export function isQuotaExceeded(message: string) {
  if (
    /"code"\s*:\s*"?(?:1308|1310)\b|usage_limit_reached|insufficient[-_\s]?(?:quota|credits)|requires more credits|fewer max_tokens|已达到\s*\d+\s*小时的使用上限|余额不足|无可用资源包|请充值/i.test(
      message,
    ) ||
    /(?:quota|usage)[^\n]{0,48}(?:exhaust|used up|reached)|(?:account|period|daily|weekly|monthly|hourly)[^\n]{0,48}(?:quota|usage)[^\n]{0,48}exceeded|"(?:code|type)"\s*:\s*"(?:quota_exceeded|account_quota_exceeded|billing_hard_limit_reached)"/i.test(
      message,
    )
  )
    return true

  // Cerebras uses the same quota code for different token windows. Exempt only
  // an explicit minute window, never an ambiguous or daily/account limit.
  if (/"code"\s*:\s*"token_quota_exceeded"/i.test(message) && /tokens per minute|\btpm\b/i.test(message)) return false
  return /quota[-_\s]?exceeded/i.test(message)
}
