import { expect, test } from '@playwright/test'
import { base64Encode } from '@opencode-ai/core/util/encode'
import { mockOpenCodeServer } from '../utils/mock-server'

// FFmpeg lavfi color=c=teal:size=90x160:rate=2:duration=2, libvpx, 5k.
// Embedded so a clean checkout needs neither FFmpeg nor an external media URL.
const portrait = 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJqEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggJU7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiECfQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYgu/9EgKSgUYpyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhB3NZQDgkLCBWrqBoJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAwc3PWY8CLY8WILv/RICkoFGJnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAyLjAwMDAwMDAwMAAfQ7Z1QKjngQCj1YEAAIDwBQCdASpaAKAAAEcIhYWIhYSIAgICdaoD+AIGmhak569GXiOevRl4jnr0ZeI569GXiOevRl4jlAD++2iX/z0zXmD/Jz/9uR/tyP9uR/+2wgCjmIEB9AARAgABEBAAGAAYWC/0AAiFa2AAAKOYgQPoABECAAEQEAAYABhYL/QACIVrYAAAo5iBBdwAEQIAARAQABgAGFgv9AAIhWtgAAAcU7trkbuPs4EAt4r3gQHxggGm8IED'

const directory = 'C:/OpenCode/PortraitVideo'
const sessionID = 'ses_portrait_video'

test('portrait preview keeps native 9:16 size beside editable controls and supports play/pause/markers', async ({ page }) => {
  const request = {
    id: 'que_portrait_preview', sessionID, detached: true,
    questions: [{ type: 'form', question: 'Tune clip', form: {
      version: 1, id: 'portrait-tuning', title: 'Portrait tuning',
      fields: [
        { id: 'preview', type: 'video_preview', label: 'Preview', src: portrait },
        { id: 'start', type: 'number', label: 'Start', defaultValue: 0 },
        { id: 'notes', type: 'textarea', label: 'Notes' },
      ],
      layout: { type: 'hstack', gap: '16px', children: [
        { type: 'vstack', width: '330px', children: [{ type: 'field', field: 'preview' }] },
        { type: 'vstack', width: 'fill', children: [{ type: 'field', field: 'start' }, { type: 'field', field: 'notes' }] },
      ] },
      actions: [{ id: 'mark', trigger: { event: 'markStart', source: 'preview' }, steps: [
        { type: 'setValue', target: 'values.start', value: 'round(${state.preview.currentTime}, 2)' },
      ] }],
    } }],
  }
  await mockOpenCodeServer(page, {
    directory,
    project: { id: 'proj_portrait', worktree: directory, vcs: 'git', name: 'portrait', time: { created: 1, updated: 1 }, sandboxes: [] },
    sessions: [{ id: sessionID, slug: sessionID, projectID: 'proj_portrait', directory, title: 'Portrait video', version: 'dev', time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }), questions: () => [request],
    events: () => [{ directory, payload: { id: 'evt_portrait', type: 'surface.asked', properties: request } }],
  })
  await page.addInitScript(({ directory, sessionID, dirBase64 }) => {
    localStorage.setItem('settings.v3', '{}')
    localStorage.setItem('opencode.global.dat:server', JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem('opencode.global.dat:tabs', JSON.stringify([{ type: 'session', dirBase64, sessionId: sessionID }]))
  }, { directory, sessionID, dirBase64: base64Encode(directory) })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const popup = page.locator('[data-component="question-popup"]')
  const video = popup.locator('[data-slot="question-form-video"]')
  await expect(video).toBeVisible({ timeout: 30000 })
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth / el.videoHeight)).toBeCloseTo(9 / 16, 2)
  const box = await video.boundingBox()
  expect(box!.height).toBeGreaterThan(400)
  expect(box!.width / box!.height).toBeCloseTo(9 / 16, 2)
  const notes = popup.locator('textarea')
  await expect(notes).toBeVisible()
  expect((await notes.boundingBox())!.x).toBeGreaterThan(box!.x + box!.width)
  await video.evaluate((el: HTMLVideoElement) => el.play())
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0.1)
  await video.evaluate((el: HTMLVideoElement) => { el.pause(); el.currentTime = 0.75 })
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true)
  await expect.poll(() => popup.locator('[data-slot="question-form-video-time"]').textContent()).toContain('0.75')
  await popup.getByRole('button', { name: 'Start hier' }).click()
  await expect(popup.locator('input[type="number"]')).toHaveValue('0.75')
  await notes.fill('Keep the effect aftermath')
  await expect(notes).toHaveValue('Keep the effect aftermath')
  await page.screenshot({ path: test.info().outputPath('portrait-preview.png'), fullPage: true })
})
