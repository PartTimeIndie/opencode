import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { sessionHealth } from "../script/session-health"

const now = 2_000_000

function fixture() {
  const db = new Database(":memory:")
  db.exec(`
    create table session (id text primary key, title text, directory text, time_updated integer,
      tokens_input integer, tokens_cache_read integer, tokens_cache_write integer);
    create table session_message (session_id text, type text, seq integer, data text);
    create table session_activity (session_id text, status text, lease_until integer, heartbeat_at integer,
      time_updated integer, time_created integer);
    create table background_job (parent_session_id text, child_session_id text, type text, status text, lease_until integer);
    create table session_question (session_id text, state text, mode text);
    insert into session values ('parent', 'Parent', 'C:/project', 2000000, 10000000, 9000000, 1000000);
    insert into session values ('child', 'Child', 'C:/project', 2000000, 1000, 0, 0);
  `)
  return db
}

describe("session health reads real SQLite projections", () => {
  test("uses the latest recorded request input, excluding lifetime sums and unmetered placeholders", () => {
    using db = fixture()
    const insert = db.query("insert into session_message values (?, 'assistant', ?, ?)")
    insert.run("parent", 1, JSON.stringify({ tokens: { input: 1000, cache: { read: 2000, write: 100 } } }))
    insert.run("parent", 2, JSON.stringify({ tokens: { input: 2000, cache: { read: 3000, write: 200 } } }))
    insert.run("parent", 3, JSON.stringify({ content: [] }))
    insert.run("child", 1, JSON.stringify({ tokens: { input: 6000 } }))
    expect(sessionHealth(db, { now }).map((row) => row.id)).toEqual(["child", "parent"])
    expect(sessionHealth(db, { now }).find((row) => row.id === "parent")).toMatchObject({
      context_estimate_tokens: 5200,
      lifetime_input_tokens: 20_000_000,
      lifetime_cache_read_tokens: 9_000_000,
      context_estimate_source: "latest recorded assistant input usage",
    })
  })

  test("counts rows and separates expired leases from live and recovering activities", () => {
    using db = fixture()
    db.exec(`insert into session_activity values
      ('parent', 'completed', null, null, 1000, 1000),
      ('parent', 'completed', null, null, 1000, 1000),
      ('parent', 'running', 1999999, 1990000, 1000, 1000),
      ('parent', 'running', null, null, 1000, 1000),
      ('parent', 'recovering', 2001000, 2000000, 2000000, 1000),
      ('child', 'running', 2000000, 1000, 1000, 1000)`)
    expect(sessionHealth(db, { now }).find((row) => row.id === "parent")).toMatchObject({
      running: true,
      activities: { total: 5, running: 1, recovering: 1, stale: 2 },
    })
    expect(sessionHealth(db, { now }).find((row) => row.id === "child")).toMatchObject({
      running: false,
      activities: { total: 1, running: 0, stale: 1 },
    })
  })

  test("counts each parent and child job association once and excludes stale jobs from running", () => {
    using db = fixture()
    db.exec(`insert into background_job values
      ('parent', 'child', 'task', 'running', 2001000),
      ('parent', 'child', 'task', 'running', 1999999),
      ('parent', 'parent', 'task', 'completed', null),
      ('parent', null, 'task', 'completed', null)`)
    expect(sessionHealth(db, { now }).find((row) => row.id === "parent")).toMatchObject({
      running: true,
      jobs: { total: 4, running: 1, stale: 1 },
    })
    expect(sessionHealth(db, { now }).find((row) => row.id === "child")).toMatchObject({
      running: true,
      jobs: { total: 2, running: 1, stale: 1 },
    })
  })

  test("blocking questions represent user waits while passive questions do not", () => {
    using db = fixture()
    db.exec(`insert into session_activity values
      ('parent', 'running', 2001000, 2000000, 2000000, 1000),
      ('child', 'running', 2001000, 2000000, 2000000, 1000);
      insert into session_question values ('parent', 'active', 'blocking'), ('child', 'active', 'passive')`)
    expect(sessionHealth(db, { now }).find((row) => row.id === "parent")).toMatchObject({
      running: false,
      waiting_for_user: true,
    })
    expect(sessionHealth(db, { now }).find((row) => row.id === "child")).toMatchObject({
      running: true,
      waiting_for_user: false,
    })
  })

  test("expired work alone does not pull old sessions into the active window", () => {
    using db = fixture()
    db.exec(`update session set time_updated = 0;
      insert into session_activity values ('parent', 'running', 1999999, 0, 0, 0);
      insert into background_job values ('child', null, 'task', 'running', 1999999)`)
    expect(sessionHealth(db, { now, hours: 0.1 })).toEqual([])
    expect(sessionHealth(db, { now, hours: 0.1, all: true })).toHaveLength(2)
  })

  test("legacy missing tables and malformed messages report unknown context without mutating storage", () => {
    using db = fixture()
    db.exec("insert into session_message values ('parent', 'assistant', 1, 'invalid json')")
    db.exec("pragma query_only = on")
    expect(sessionHealth(db, { now })[0]).toMatchObject({
      context_estimate_tokens: null,
      context_estimate_source: "unavailable",
    })
    db.exec("pragma query_only = off")
    db.exec(
      "drop table session_message; drop table session_activity; drop table background_job; drop table session_question",
    )
    expect(sessionHealth(db, { now })[0]).toMatchObject({ running: false, context_estimate_tokens: null })
  })
})
