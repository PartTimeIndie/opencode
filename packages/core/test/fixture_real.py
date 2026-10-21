test("empty-summary contract fails structured when provider returns no summary", async () => {
  // Real isolated fixture matching session-empty-wake pattern:
  // subprocess env with OPENCODE_TEST_HOME/OPENCODE_DB/Config XDG BEFORE imports
  // Effect.gen with yield* EventV2.Service inside correct provided Layer
  // Effect.provide + Effect.scoped for full DB lifetime
  const dbLayer = Database.defaultLayer
  const eventsLayer = EventV2.layer.pipe(Layer.provide(dbLayer))
  const model = Model.make({ id: "test-empty", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
  const request = LLM.request({ model, messages: [], tools: [], generation: { maxTokens: 256 } })
  const compactionEffect = Effect.gen(function* () {
    const eventsService = yield* eventsLayer
    return SessionCompaction.make({
      config: [{ type: "document", path: "test", info: { compaction: { quality: true, keep: { tokens: 1 }, buffer: 10 } } }],
      events: eventsService,
      llm: { stream: () => Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.finish({ reason: "stop" })]) },
      loadCurrent: () => Effect.succeed({
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_condensable_head"),
              type: "user" as const,
              text: "Condensable context that produces a real selected head",
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
        ],
        todos: [],
      }),
    })
  }).pipe(Effect.provide(eventsLayer), Effect.scoped)
  const compactionInstance = await Effect.runPromise(compactionEffect)
  expect(compactionInstance).toBeDefined()
  const exit = await Effect.runPromise(
    Effect.exit(
      compactionInstance.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_empty_stream_contract"),
        model,
        request,
        entries: [],
        contextEstimateTokens: 120_000,
      }),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(SessionCompaction.SummaryFailed)
    if (error instanceof SessionCompaction.SummaryFailed) {
      expect(error.sessionID).toBe(SessionSchema.ID.make("ses_empty_stream_contract"))
      expect(error.reason).toBe("the provider returned an empty summary without usable text")
    }
  }
})