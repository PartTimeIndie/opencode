import { describe, expect, test } from "bun:test"
import { longFixture } from "../e2e/smoke/session-timeline.fixture"
import { createRealSessionArchive } from "../e2e/utils/real-session-archive"

describe("real session archive E2E fixture", () => {
  test("serves opaque pages from a real shard without reactivating", async () => {
    await using archive = await createRealSessionArchive({
      session: longFixture.sessions.find((session) => session.id === longFixture.targetID)!,
      messages: longFixture.messages[longFixture.targetID],
    })
    const before = await archive.inspect()
    const catalog = await archive.listCatalog()
    const newest = await archive.pageMessages(longFixture.targetID, 159)
    const older = await archive.pageMessages(longFixture.targetID, 159, newest.cursor)
    const oldest = await archive.pageMessages(longFixture.targetID, 159, older.cursor)

    expect(before).toMatchObject({
      location: "archived",
      revision: 1,
      sessionCount: 1,
      activeSessionCount: 0,
      archivedMessageCount: 340,
      archivedLegacyMessageCount: 340,
    })
    expect(before.shardBytes).toBeGreaterThan(0)
    expect(catalog).toMatchObject({
      hasMore: false,
      rows: [
        {
          sessionID: longFixture.targetID,
          title: longFixture.expected.targetTitle,
          location: "archived",
          messageCount: 340,
        },
      ],
    })
    expect(newest.items).toHaveLength(159)
    expect(older.items).toHaveLength(159)
    expect(oldest.items).toHaveLength(22)
    expect(newest.cursor).toBeString()
    expect(older.cursor).toBeString()
    expect(oldest.cursor).toBeUndefined()
    expect(await archive.inspect()).toEqual(before)
  }, 60_000)
})
