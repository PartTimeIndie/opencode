import { describe, expect, test } from 'bun:test'
import { videoPreviewRatio } from './session-question-video'

describe('video preview metadata ratio', () => {
  test('keeps portrait and landscape geometry', () => {
    expect(videoPreviewRatio(540, 960)).toBe(9 / 16)
    expect(videoPreviewRatio(1920, 1080)).toBe(16 / 9)
  })
  test('uses a finite fallback before valid metadata arrives', () => {
    for (const [width, height] of [[0, 0], [540, 0], [NaN, 960], [Infinity, 960], [90, -1]]) {
      expect(videoPreviewRatio(width, height)).toBe(16 / 9)
    }
  })
})
