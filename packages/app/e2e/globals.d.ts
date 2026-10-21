export {}

declare global {
  interface Window {
    __OPENCODE_TEST_PLATFORM__?: Record<string, unknown>
    __shortcutDemoRuns?: number
  }
}
