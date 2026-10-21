export function preserveNullableModelChains(source: string) {
  let output = source
  let search = 0
  let matched = 0

  while (search < output.length) {
    const modelMatch = /\bmodel\??\s*:\s*\{/.exec(output.slice(search))
    if (!modelMatch) break

    const modelStart = search + modelMatch.index
    const modelOpen = output.indexOf("{", modelStart)
    const modelEnd = matchingBrace(output, modelOpen)
    const model = output.slice(modelOpen, modelEnd + 1)
    const chainMatch = /\bchain\??\s*:\s*\{/.exec(model)
    if (!chainMatch) {
      search = modelEnd + 1
      continue
    }

    matched++
    const chainOpen = modelOpen + chainMatch.index + chainMatch[0].indexOf("{")
    const chainEnd = matchingBrace(output, chainOpen)
    if (!/^\s*\|\s*null/.test(output.slice(chainEnd + 1))) {
      output = `${output.slice(0, chainEnd + 1)} | null${output.slice(chainEnd + 1)}`
      search = chainEnd + 8
      continue
    }
    search = chainEnd + 1
  }

  if (matched === 0) throw new Error("No generated model.chain type was found to preserve explicit null")
  return output
}

function matchingBrace(source: string, start: number) {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++
    if (source[index] === "}") depth--
    if (depth === 0) return index
  }
  throw new Error(`Unmatched brace while patching generated model.chain near offset ${start}`)
}
