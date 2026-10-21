with open('packages/core/test/session-compaction.test.ts', 'r') as f:
    lines = f.read().splitlines()

# Find the line index where the test for empty-summary starts
start_idx = None
for i, line in enumerate(lines):
    if line.strip().startswith('test("empty-summary contract fails structured when provider returns no summary"'):
        start_idx = i
        break

if start_idx is not None:
    # Keep everything before this line
    new_lines = lines[:start_idx]
    # Append the real fixture test
    new_test = [
        'test("empty-summary contract fails structured when provider returns no summary", async () => {',
        '  const dbLayer = Database.defaultLayer',
        '  const eventsLayer = EventV2.layer.pipe(Layer.provide(dbLayer))',
        '  const model = Model.make({ id: "test-empty", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })',
        '  const request = LLM.request({ model, messages: [], tools: [], generation: { maxTokens: 256 } })',
        '  const compactionEffect = Effect.gen(function* () {',
        '    const eventsService = yield* EventV2.Service.pipe(Effect.provide(eventsLayer))',
        '    return SessionCompaction.make({',
        '      config: [{ type: "document", path: "test", info: { compaction: { quality: true, keep: { tokens: 1 }, buffer: 10 } } }],',
        '      events: eventsService,',
        '      llm: { stream: () => Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.finish({ reason: "stop" })]) },',
        '      loadCurrent: () => Effect.succeed({ entries: [{ seq: 1, message: new SessionMessage.User({ id: SessionMessage.ID.make("msg_condensable"), type: "user" as const, text: "Real head for condensation", time: { created: DateTime.makeUnsafe(1) } }) }], todos: [] }),',
        '    })',
        '  })',
        '  const compactionInstance = await Effect.runPromise(compactionEffect)',
        '  expect(compactionInstance).toBeDefined()',
        '  const exit = await Effect.runPromise(Effect.exit(compactionInstance.compactAfterOverflow({',
        '    sessionID: SessionSchema.ID.make("ses_empty_stream_contract"),',
        '    model,',
    '    request,',
    '    entries: [],',
    '    contextEstimateTokens: 120_000,',
    '  })))',
    '  expect(Exit.isFailure(exit)).toBe(true)',
    '  if (Exit.isFailure(exit)) {',
    '    const error = Cause.squash(exit.cause)',
    '    expect(error).toBeInstanceOf(SessionCompaction.SummaryFailed)',
    '    if (error instanceof SessionCompaction.SummaryFailed) {',
    '      expect(error.sessionID).toBe(SessionSchema.ID.make("ses_empty_stream_contract"))',
    '      expect(error.reason).toBe("the provider returned an empty summary without usable text")',
    '    }',
    '  }',
    '})',
    ]
    new_lines.extend(new_test)
    with open('packages/core/test/session-compaction.test.ts', 'w') as f:
        f.write('\n'.join(new_lines) + '\n')
    print('Rewritten fixture, total lines:', len(new_lines))
else:
    print('Could not find the test line')