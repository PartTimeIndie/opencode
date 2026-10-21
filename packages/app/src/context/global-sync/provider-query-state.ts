export function providerQueryErrorVisible(input: { isError: boolean; isFetching: boolean }) {
  return input.isError && !input.isFetching
}
