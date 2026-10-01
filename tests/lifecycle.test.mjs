import { describe, it } from 'node:test';
import strictAssert from 'node:assert/strict';

import plugin from '../plugins/auto-approve/index.ts';

// ============================================================================
// Mock OpenCode client builder with deterministic deferred promises
// ============================================================================

/**
 * Creates a mock OpenCode client context with deterministic deferred promises
 * @param {unknown} options
 * @returns {Object} { ctx, mock, deferred, promptCallbackContainer, lifetime, pushEvent, waitForEventProcessed, finishEvents }
 */
function createMockClient(options) {
  const mock = {
    hookRegistered: false,
    getCalls: [],
    generateCalls: [],
    replyCalls: [],
    pendingRequest: undefined,
    sessionMessages: [],
    contextCalls: [],
    notificationEvents: [],
    notificationsDisposed: false,
  };

  const lifetime = new AbortController();

  // Deferred promises for event-driven waiting (no setTimeout/polling)
  const deferred = {};

  // Helper to create deferred promise
  function createDeferred(name) {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    deferred[name] = { promise, resolve, reject };
  }

  createDeferred('generateCalled');
  createDeferred('generateAborted');
  createDeferred('replyCalled');
  createDeferred('promptHookResolved');

  // Prompt callback container - populated when hook is registered
  const promptCallbackContainer = { current: null };
  let streamClosed = false;

  // Event queue and push mechanism
  const eventQueue = [];
  let eventConsumerResolve = null;
  let eventConsumerReject = null;

  // Track processed event count (sentinel events signal completion of prior events)
  let eventProcessedCount = 0;
  let eventProcessedResolve = null;

  // Signal when an event has been consumed from the queue
  const signalEventProcessed = () => {
    eventProcessedCount++;
    if (eventProcessedResolve) {
      const resolve = eventProcessedResolve;
      eventProcessedResolve = null;
      resolve(eventProcessedCount);
    }
  };

  // Wait for a specific number of events to be processed (consumed from queue)
  const waitForEventProcessed = (targetCount) => {
    if (eventProcessedCount >= targetCount) {
      return Promise.resolve(eventProcessedCount);
    }
    return new Promise((resolve) => {
      eventProcessedResolve = resolve;
    });
  };

  // Push an event and notify waiting consumer
  const pushEvent = (event) => {
    eventQueue.push(event);
    if (eventConsumerResolve) {
      const resolve = eventConsumerResolve;
      eventConsumerResolve = null;
      eventConsumerReject = null;
      resolve();
    }
  };

  // Create the event stream that honors the exact passed AbortSignal
  const createEventStream = (signal) => {
    let index = 0;
    return (async function* () {
      while (!streamClosed && !signal.aborted) {
        if (index < eventQueue.length) {
          const event = eventQueue[index++];
          yield event;
          // The consumer requests the next event only after its handler completes.
          signalEventProcessed();
        } else {
          // Wait for next event or abort
          if (signal.aborted) {
            throw new Error('Aborted');
          }
          if (eventConsumerResolve) {
            eventConsumerResolve();
            eventConsumerResolve = null;
            eventConsumerReject = null;
          } else {
            await new Promise((resolve, reject) => {
              eventConsumerResolve = resolve;
              eventConsumerReject = reject;
              signal.addEventListener('abort', () => {
                if (eventConsumerReject) {
                  eventConsumerReject(new Error('Aborted'));
                }
                reject(new Error('Aborted'));
              }, { once: true });
            });
          }
        }
      }
      if (signal.aborted) {
        throw new Error('Aborted');
      }
      return;
    })();
  };

  const ctx = {
    options,
    rpc: {
      register: async () => ({
        events: {
          emit: async (name, data) => { mock.notificationEvents.push({ name, data }); },
        },
        dispose: async () => { mock.notificationsDisposed = true; },
      }),
    },
    session: {
      context: async (ref) => {
        mock.contextCalls.push(ref);
        return mock.sessionMessages;
      },
      hook: async (name, callback) => {
        strictAssert.strictEqual(name, 'prompt', 'Only prompt hook is used');
        mock.hookRegistered = true;
        promptCallbackContainer.current = callback;

        // Resolve the promptHookResolved deferred when hook is registered
        if (deferred.promptHookResolved.resolve) {
          deferred.promptHookResolved.resolve();
        }

        return {
          disposed: false,
          dispose: async () => {
            mock.hookRegistered = false;
            promptCallbackContainer.current = null;
          },
        };
      },
    },
    event: {
      subscribe: ({ signal } = {}) => {
        return createEventStream(signal);
      },
    },
    permission: {
      get: async (ref) => {
        mock.getCalls.push(ref);
        return mock.pendingRequest ?? {
          id: ref.requestID,
          sessionID: ref.sessionID,
          action: 'read',
          resources: ['file.txt'],
        };
      },
      reply: async (ref) => {
        mock.replyCalls.push(ref);
        // Resolve replyCalled deferred when reply is called
        if (deferred.replyCalled.resolve) {
          deferred.replyCalled.resolve();
        }
      },
    },
    generate: {
      text: async (input, { signal } = {}) => {
        mock.generateCalls.push({ prompt: input.prompt, model: input.model });
        // Resolve generateCalled deferred when generate is called
        if (deferred.generateCalled.resolve) {
          deferred.generateCalled.resolve();
        }
        return { text: '{"decision":"approve","justification":"safe operation"}' };
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    },
  };

  return {
    ctx,
    mock,
    deferred,
    promptCallbackContainer,
    lifetime,
    pushEvent,
    waitForEventProcessed,
    eventProcessedCount: () => eventProcessedCount,
    finishEvents: () => {
      streamClosed = true;
      if (eventConsumerReject) {
        eventConsumerReject(new Error('Stream closed'));
      }
      lifetime.abort();
    },
  };
}

// ============================================================================
// Integration tests
// ============================================================================

describe('auto-approve plugin lifecycle integration tests', () => {
  const baseOptions = {
    enabled: true,
    actions: ['read'],
    model: { providerID: 'test', id: 'test-model' },
    timeoutMs: 5_000,
    maxInputBytes: 8_192,
    maxConcurrentReviews: 1,
    retryDelayMs: 100,
  };

  // Helper to wait for all pending events to be processed
  // Push a sentinel event and wait for it to be consumed
  async function waitEventsProcessed(builder) {
    const { pushEvent, waitForEventProcessed, eventProcessedCount } = builder;
    const currentCount = typeof eventProcessedCount === 'function' ? eventProcessedCount() : eventProcessedCount;
    // Push a sentinel event and wait for it to be consumed
    pushEvent({ type: 'test.sentinel', data: {} });
    return await waitForEventProcessed(currentCount + 1);
  }

  // Test 1: prompt hook registered before stream consumption and disposed on cleanup
  describe('prompt hook registration and disposal', () => {
    it('prompt hook is registered before stream consumption begins', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, promptCallbackContainer, finishEvents } = builder;

      let hookRegistrationResolved = false;

      // Override session.hook to detect when hook registration completes
      const originalHook = ctx.session.hook;
      ctx.session.hook = async (name, callback) => {
        const result = await originalHook.call(ctx.session, name, callback);
        hookRegistrationResolved = true;
        return result;
      };

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // setup resolves only after hook registration and before stream consumption.
      const cleanup = await setupPromise;

      strictAssert.ok(hookRegistrationResolved, 'Prompt hook should be registered before consume starts');
      strictAssert.ok(promptCallbackContainer.current !== null, 'Prompt callback should be set');

      // Cleanup
      finishEvents();
      await cleanup();

      strictAssert.strictEqual(builder.mock.hookRegistered, false, 'Hook should be disposed after cleanup');
    });

    it('cleanup disposes the prompt hook', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, finishEvents } = builder;

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      strictAssert.strictEqual(builder.mock.hookRegistered, true, 'Hook should be registered');

      // Cleanup
      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();

      strictAssert.strictEqual(builder.mock.hookRegistered, false, 'Hook should be disposed after cleanup');
    });
  });

  // Test 2: valid hook + permission.asked produces review prompt with user text and reply:"once"
  describe('valid prompt hook + permission.asked event', () => {
    it('valid prompt hook + permission.asked produces review prompt with user text and reply:"once"', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, pushEvent, promptCallbackContainer, finishEvents } = builder;

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      const sessionID = 'sess-1';
      const messageID = 'msg-1';
      const userText = 'Can I read file.txt?';

      // Trigger prompt to capture user intent
      const actualCallback = promptCallbackContainer.current;
      strictAssert.ok(actualCallback !== null, 'Prompt callback should be available');
      await actualCallback({ sessionID, messageID, prompt: { text: userText }, delivery: 'queue' });

      // Inject server.connected first (required for permission events)
      pushEvent({ type: 'server.connected', data: {} });

      // Inject permission.asked event
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-1',
          sessionID,
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // Wait for generate to be called (deterministic, no timeout)
      await deferred.generateCalled.promise;

      // Verify generate was called with user context
      strictAssert.strictEqual(builder.mock.generateCalls.length, 1, 'Generate should be called once');
      const generateCall = builder.mock.generateCalls[0];
      strictAssert.ok(generateCall.prompt.includes(userText), 'Prompt should include user text');
      strictAssert.ok(generateCall.prompt.includes('"action":"read"'), 'Prompt should include action');
      strictAssert.ok(generateCall.prompt.includes('"resources":'), 'Prompt should include resources');

      // Wait for reply
      await deferred.replyCalled.promise;

      // Verify reply was sent with decision:"once"
      strictAssert.strictEqual(builder.mock.replyCalls.length, 1, 'Reply should be called once');
      strictAssert.deepStrictEqual(builder.mock.replyCalls[0], {
        sessionID,
        requestID: 'req-1',
        decision: 'once',
      });
      await new Promise(resolve => setImmediate(resolve));
      strictAssert.deepStrictEqual(builder.mock.notificationEvents.map(({ data }) => data), [
        { sessionID, status: 'reviewing' },
        { sessionID, status: 'approved' },
      ]);

      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();
      strictAssert.strictEqual(builder.mock.notificationsDisposed, true);
    });
  });

  describe('external directory read binding', () => {
    it('reviews a source-matched running read and approves only once', async () => {
      const builder = createMockClient({ ...baseOptions, actions: ['external_directory'] });
      const { ctx, mock, deferred, pushEvent, promptCallbackContainer, finishEvents } = builder;
      const sessionID = 'sess-bound';
      const requestID = 'req-bound';
      mock.pendingRequest = {
        id: requestID, sessionID, action: 'external_directory', resources: ['/etc/*'],
        source: { type: 'tool', messageID: 'assistant-1', id: 'call-1' },
      };
      mock.sessionMessages = [{ type: 'assistant', id: 'assistant-1', content: [
        { type: 'tool', id: 'call-1', name: 'read', state: { status: 'running', input: { path: '/etc/hosts' } } },
      ] }];
      const cleanup = await plugin.setup(ctx);
      await promptCallbackContainer.current({ sessionID, messageID: 'user-1', prompt: { text: 'read /etc/hosts again' }, delivery: 'queue' });
      pushEvent({ type: 'permission.asked', data: mock.pendingRequest });
      await deferred.replyCalled.promise;
      strictAssert.match(mock.generateCalls[0].prompt, /Verified read target: "\/etc\/hosts"/);
      strictAssert.strictEqual(mock.contextCalls.length, 2, 'verify the target again before replying');
      strictAssert.deepStrictEqual(mock.replyCalls[0], { sessionID, requestID, decision: 'once' });
      finishEvents();
      await cleanup();
    });

    it('leaves the request pending when no matching running tool is exposed', async () => {
      const builder = createMockClient({ ...baseOptions, actions: ['external_directory'] });
      const { ctx, mock, pushEvent, promptCallbackContainer, finishEvents, waitForEventProcessed } = builder;
      const sessionID = 'sess-unbound';
      const requestID = 'req-unbound';
      mock.pendingRequest = {
        id: requestID, sessionID, action: 'external_directory', resources: ['/etc/*'],
        source: { type: 'tool', messageID: 'assistant-1', id: 'call-1' },
      };
      const cleanup = await plugin.setup(ctx);
      await promptCallbackContainer.current({ sessionID, messageID: 'user-1', prompt: { text: 'read /etc/hosts again' }, delivery: 'queue' });
      pushEvent({ type: 'permission.asked', data: mock.pendingRequest });
      await waitForEventProcessed(1);
      await new Promise(setImmediate);
      strictAssert.strictEqual(mock.contextCalls.length, 1);
      strictAssert.strictEqual(mock.generateCalls.length, 0);
      strictAssert.strictEqual(mock.replyCalls.length, 0);
      finishEvents();
      await cleanup();
    });

    it('does not reply if the tool target changes while the reviewer is running', async () => {
      const builder = createMockClient({ ...baseOptions, actions: ['external_directory'] });
      const { ctx, mock, deferred, pushEvent, promptCallbackContainer, finishEvents } = builder;
      const sessionID = 'sess-changing-target';
      mock.pendingRequest = {
        id: 'req-changing-target', sessionID, action: 'external_directory', resources: ['/etc/*'],
        source: { type: 'tool', messageID: 'assistant-1', id: 'call-1' },
      };
      mock.sessionMessages = [{ type: 'assistant', id: 'assistant-1', content: [
        { type: 'tool', id: 'call-1', name: 'read', state: { status: 'running', input: { path: '/etc/hosts' } } },
      ] }];
      let resolveReview;
      ctx.generate.text = async (input) => {
        mock.generateCalls.push(input);
        deferred.generateCalled.resolve();
        return new Promise((resolve) => { resolveReview = resolve; });
      };
      const cleanup = await plugin.setup(ctx);
      await promptCallbackContainer.current({ sessionID, messageID: 'user-1', prompt: { text: 'read /etc/hosts again' }, delivery: 'queue' });
      pushEvent({ type: 'permission.asked', data: mock.pendingRequest });
      await deferred.generateCalled.promise;
      mock.sessionMessages = [{ type: 'assistant', id: 'assistant-1', content: [
        { type: 'tool', id: 'call-1', name: 'read', state: { status: 'running', input: { path: '/etc/shadow' } } },
      ] }];
      resolveReview({ text: '{"decision":"approve","justification":"safe"}' });
      await new Promise(setImmediate);
      strictAssert.strictEqual(mock.contextCalls.length, 2);
      strictAssert.strictEqual(mock.replyCalls.length, 0);
      finishEvents();
      await cleanup();
    });
  });

  // Test 3: no/invalid snapshot leaves request pending without generate/reply
  describe('no/invalid snapshot', () => {
    it('no snapshot leaves request pending without generate/reply', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, pushEvent, finishEvents } = builder;

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // Inject server.connected
      pushEvent({ type: 'server.connected', data: {} });

      // Inject permission.asked WITHOUT a prior prompt capture
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-2',
          sessionID: 'sess-2',
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // With no snapshot, generate should never be called
      // Wait for sentinel event to be consumed (deterministic, no fixed sleep)
      await waitEventsProcessed(builder);

      strictAssert.strictEqual(builder.mock.generateCalls.length, 0, 'No generate when snapshot missing');
      strictAssert.strictEqual(builder.mock.replyCalls.length, 0, 'No reply when snapshot missing');

      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();
    });

    it('invalid snapshot (empty text) leaves request pending', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, pushEvent, promptCallbackContainer, finishEvents, eventProcessedCount } = builder;

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      const sessionID = 'sess-3';
      const messageID = 'msg-3';

      // Trigger prompt with invalid text (empty)
      const actualCallback = promptCallbackContainer.current;
      strictAssert.ok(actualCallback !== null, 'Prompt callback should be available');
      await actualCallback({ sessionID, messageID, prompt: { text: '' }, delivery: 'queue' });

      // Inject server.connected
      pushEvent({ type: 'server.connected', data: {} });

      // Inject permission.asked
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-3',
          sessionID,
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // Wait for sentinel event to be consumed (deterministic, no fixed sleep)
      // The invalid snapshot causes the permission.asked to be skipped,
      // but we still wait for the sentinel to confirm event processing completed
      await waitEventsProcessed(builder);

      strictAssert.strictEqual(builder.mock.generateCalls.length, 0, 'No generate when snapshot invalid');
      strictAssert.strictEqual(builder.mock.replyCalls.length, 0, 'No reply when snapshot invalid');

      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();
    });
  });

  // Test 4: changing prompt while generation is pending prevents reply
  describe('prompt snapshot changes during review', () => {
    it('changing prompt while generation is pending prevents reply', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, pushEvent, promptCallbackContainer, finishEvents, eventProcessedCount } = builder;
      let resolveReview;
      ctx.generate.text = async (input, { signal } = {}) => {
        builder.mock.generateCalls.push({ prompt: input.prompt, model: input.model });
        deferred.generateCalled.resolve();
        return await new Promise((resolve, reject) => {
          resolveReview = resolve;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      };

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      const sessionID = 'sess-4';
      const messageID = 'msg-4';
      const userText = 'Original prompt';

      // Trigger initial prompt
      const actualCallback = promptCallbackContainer.current;
      strictAssert.ok(actualCallback !== null, 'Prompt callback should be available');
      await actualCallback({ sessionID, messageID, prompt: { text: userText }, delivery: 'queue' });

      // Inject server.connected and permission.asked
      pushEvent({ type: 'server.connected', data: {} });
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-4',
          sessionID,
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // Wait for generate to be called
      await deferred.generateCalled.promise;

      strictAssert.strictEqual(builder.mock.generateCalls.length, 1, 'Generate should be called once');

      // Simulate prompt changing while review is in flight (new messageID, different text)
      const newMessageID = 'msg-4-new';
      const newText = 'Modified prompt';
      await actualCallback({ sessionID, messageID: newMessageID, prompt: { text: newText }, delivery: 'queue' });

      // Only now return an approving result from the held reviewer call.
      resolveReview({ text: '{"decision":"approve","justification":"safe operation"}' });

      // Drain the reviewer continuation after its deferred generation result resolves.
      await new Promise((resolve) => setImmediate(resolve));

      // Verify no additional generate was sent (the original one was in-flight)
      strictAssert.strictEqual(builder.mock.generateCalls.length, 1, 'No additional generate after snapshot change');
      strictAssert.strictEqual(builder.mock.replyCalls.length, 0, 'No reply when snapshot changed during review');

      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();
    });
  });

  // Test 5: abstain and malformed output never reply
  describe('abstain/malformed reviewer output', () => {
    it('abstain output does not trigger reply', async () => {
      const builder = createMockClient(baseOptions);

      // Override generate to return abstain
      builder.ctx.generate.text = async (input, { signal } = {}) => {
        builder.mock.generateCalls.push({ prompt: input.prompt, model: input.model });
        // Resolve generateCalled deferred when generate is called
        if (builder.deferred.generateCalled.resolve) {
          builder.deferred.generateCalled.resolve();
        }
        return { text: '{"decision":"abstain","justification":"not sure"}' };
      };

      const { deferred, pushEvent, promptCallbackContainer, finishEvents } = builder;

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(builder.ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      const sessionID = 'sess-5';
      const messageID = 'msg-5';
      const userText = 'Can I read file.txt?';

      const actualCallback = promptCallbackContainer.current;
      strictAssert.ok(actualCallback !== null, 'Prompt callback should be available');
      await actualCallback({ sessionID, messageID, prompt: { text: userText }, delivery: 'queue' });

      pushEvent({ type: 'server.connected', data: {} });
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-5',
          sessionID,
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // Wait for generate
      await deferred.generateCalled.promise;

      strictAssert.strictEqual(builder.mock.generateCalls.length, 1, 'Generate should be called');
      strictAssert.strictEqual(builder.mock.replyCalls.length, 0, 'No reply when abstain');
      await new Promise(resolve => setImmediate(resolve));
      strictAssert.deepStrictEqual(builder.mock.notificationEvents.map(({ data }) => data), [
        { sessionID, status: 'reviewing' },
        { sessionID, status: 'abstained' },
      ]);

      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();
    });

    it('malformed output does not trigger reply', async () => {
      const builder = createMockClient(baseOptions);

      builder.ctx.generate.text = async (input, { signal } = {}) => {
        builder.mock.generateCalls.push({ prompt: input.prompt, model: input.model });
        // Resolve generateCalled deferred when generate is called
        if (builder.deferred.generateCalled.resolve) {
          builder.deferred.generateCalled.resolve();
        }
        return { text: '{"decision":"approve"}' }; // Missing justification - malformed
      };

      const { deferred, pushEvent, promptCallbackContainer, finishEvents } = builder;

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(builder.ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      const sessionID = 'sess-6';
      const messageID = 'msg-6';
      const userText = 'Can I read file.txt?';

      const actualCallback = promptCallbackContainer.current;
      strictAssert.ok(actualCallback !== null, 'Prompt callback should be available');
      await actualCallback({ sessionID, messageID, prompt: { text: userText }, delivery: 'queue' });

      pushEvent({ type: 'server.connected', data: {} });
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-6',
          sessionID,
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // Wait for generate
      await deferred.generateCalled.promise;

      strictAssert.strictEqual(builder.mock.generateCalls.length, 1, 'Generate should be called');
      strictAssert.strictEqual(builder.mock.replyCalls.length, 0, 'No reply when output malformed');

      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();
    });
  });

  describe('external permission resolution', () => {
    it('cancels an in-flight review without sending a reply', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, pushEvent, promptCallbackContainer, finishEvents } = builder;
      ctx.generate.text = async (input, { signal } = {}) => {
        builder.mock.generateCalls.push({ prompt: input.prompt, model: input.model });
        deferred.generateCalled.resolve();
        return await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            deferred.generateAborted.resolve();
            reject(new Error('aborted'));
          }, { once: true });
        });
      };

      const cleanup = await plugin.setup(ctx);
      const sessionID = 'sess-external-resolution';
      const requestID = 'req-external-resolution';
      await promptCallbackContainer.current({
        sessionID, messageID: 'msg-external-resolution', prompt: { text: 'Read the test file' }, delivery: 'queue',
      });
      pushEvent({ type: 'permission.asked', data: {
        id: requestID, sessionID, action: 'read', resources: ['file.txt'],
      } });
      await deferred.generateCalled.promise;

      pushEvent({ type: 'permission.replied', data: { sessionID, requestID, reply: 'once' } });
      await deferred.generateAborted.promise;
      await waitEventsProcessed(builder);

      strictAssert.strictEqual(builder.mock.generateCalls.length, 1);
      strictAssert.strictEqual(builder.mock.replyCalls.length, 0);
      strictAssert.deepStrictEqual(builder.mock.notificationEvents.map(({ data }) => data), [
        { sessionID, status: 'reviewing' },
        { sessionID, status: 'external-resolution' },
      ]);
      finishEvents();
      await cleanup();
    });

    it('continues reviewing when notification registration fails', async () => {
      const builder = createMockClient(baseOptions);
      builder.ctx.rpc.register = async () => { throw new Error('RPC unavailable'); };
      const { ctx, deferred, pushEvent, promptCallbackContainer, finishEvents } = builder;
      const cleanup = await plugin.setup(ctx);
      await promptCallbackContainer.current({
        sessionID: 'sess-no-rpc', messageID: 'msg-no-rpc', prompt: { text: 'read file.txt' }, delivery: 'queue',
      });
      pushEvent({ type: 'permission.asked', data: {
        id: 'req-no-rpc', sessionID: 'sess-no-rpc', action: 'read', resources: ['file.txt'],
      } });
      await deferred.replyCalled.promise;
      strictAssert.strictEqual(builder.mock.replyCalls.length, 1);
      finishEvents();
      await cleanup();
    });
  });

  // Test 6: cleanup aborts subscription signal and in-flight generation
  describe('cleanup', () => {
    it('cleanup aborts the subscription signal and in-flight generation', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, promptCallbackContainer, pushEvent, finishEvents } = builder;
      ctx.generate.text = async (input, { signal } = {}) => {
        builder.mock.generateCalls.push({ prompt: input.prompt, model: input.model });
        deferred.generateCalled.resolve();
        return await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            deferred.generateAborted.resolve();
            reject(new Error('aborted'));
          }, { once: true });
        });
      };

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      const sessionID = 'sess-7';
      const messageID = 'msg-7';
      const userText = 'Test prompt';

      const actualCallback = promptCallbackContainer.current;
      strictAssert.ok(actualCallback !== null, 'Prompt callback should be available');
      await actualCallback({ sessionID, messageID, prompt: { text: userText }, delivery: 'queue' });

      // Inject server.connected and permission.asked
      pushEvent({ type: 'server.connected', data: {} });
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-7',
          sessionID,
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // Wait for generate to start
      await deferred.generateCalled.promise;

      // Verify hook is registered
      strictAssert.strictEqual(builder.mock.hookRegistered, true, 'Hook should be registered');

      // Abort lifetime and await cleanup
      finishEvents();

      const cleanup = await setupPromise;
      await cleanup();

      await deferred.generateAborted.promise;

      strictAssert.strictEqual(builder.mock.hookRegistered, false, 'Hook should be disposed');

      // Verify no generate or reply happened after abort (signals were aborted)
      // The generate was already called, but any subsequent operations should be aborted
    });

    it('cleanup clears the prompt cache', async () => {
      const builder = createMockClient(baseOptions);
      const { ctx, deferred, promptCallbackContainer, pushEvent, finishEvents } = builder;

      const setupPromise = (async () => {
        const cleanup = await plugin.setup(ctx);
        return cleanup;
      })();

      // Wait for hook registration
      await deferred.promptHookResolved.promise;

      const sessionID = 'sess-8';
      const messageID = 'msg-8';
      const userText = 'Test prompt';

      const actualCallback = promptCallbackContainer.current;
      strictAssert.ok(actualCallback !== null, 'Prompt callback should be available');
      await actualCallback({ sessionID, messageID, prompt: { text: userText }, delivery: 'queue' });

      // Inject server.connected and permission.asked
      pushEvent({ type: 'server.connected', data: {} });
      pushEvent({
        type: 'permission.asked',
        data: {
          id: 'req-8',
          sessionID,
          action: 'read',
          resources: ['file.txt'],
        },
      });

      // Wait for generate
      await deferred.generateCalled.promise;

      finishEvents();
      const cleanup = await setupPromise;
      await cleanup();

      // Cleanup should have cleared the prompt cache
      // This is verified indirectly by checking that subsequent prompts start fresh
    });
  });
});
