// Cancel native form navigation before any early return or asynchronous work.
export function preventNativeSubmit<Args extends unknown[], Result>(
  handler: (event: Event, ...args: Args) => Result,
) {
  return (event: Event, ...args: Args) => {
    event.preventDefault()
    return handler(event, ...args)
  }
}
