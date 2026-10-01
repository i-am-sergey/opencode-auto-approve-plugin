import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import tuiPlugin from '../plugins/auto-approve/tui.ts';
import { AutoApproveNotifications } from '../plugins/auto-approve/rpc.ts';

describe('auto-approve TUI notifications', () => {
  it('displays session-scoped status without exposing reviewer input', async () => {
    const toasts = [];
    let listener;
    let unsubscribed = false;
    const dispose = await tuiPlugin.setup({
      client: {
        rpc: (definition) => {
          assert.strictEqual(definition, AutoApproveNotifications);
          return { events: { on: (name, callback) => {
            assert.equal(name, 'status');
            listener = callback;
            return () => { unsubscribed = true; };
          } } };
        },
      },
      ui: { toast: { show: (toast) => { toasts.push(toast); } } },
    });

    for (const status of ['reviewing', 'approved', 'abstained', 'external-resolution']) {
      listener({ data: { sessionID: 'test-session', status } });
    }
    assert.deepEqual(toasts.map(({ sessionID, variant }) => ({ sessionID, variant })), [
      { sessionID: 'test-session', variant: 'info' },
      { sessionID: 'test-session', variant: 'success' },
      { sessionID: 'test-session', variant: 'warning' },
      { sessionID: 'test-session', variant: 'info' },
    ]);
    assert.match(toasts[1].message, /Approved once by auto-approve/);
    assert.match(toasts[3].message, /responder is unknown/);
    assert.ok(toasts.every(({ title, message }) => title === 'Auto-approve' && !message.includes('test-session')));

    listener({ data: { sessionID: 'test-session', status: 'unknown' } });
    listener({ data: { sessionID: 42, status: 'approved' } });
    assert.equal(toasts.length, 4);
    dispose();
    assert.equal(unsubscribed, true);
  });
});
