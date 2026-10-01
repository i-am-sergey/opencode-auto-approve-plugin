import { after, before, describe, it } from 'node:test';
import strictAssert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { abstainCategory, captureReviewInput, createTrace, errorCategory, resolutionCategory, reviewerReason } from '../plugins/auto-approve/diagnostics.ts';

const testRoot = '/private/var/folders/hb/_k377k8s0bb3bk0_gv8l5k1w0000gn/T/opencode';
let directory;
before(async () => { directory = await mkdtemp(join(testRoot, 'auto-approve-trace-test-')); });
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('opt-in diagnostic trace', () => {
  it('captures one exact reviewer input in a separate owner-only, bounded file', async () => {
    const path = join(directory, 'review-input.json');
    const prompt = 'User context: "read /etc/hosts again"\nPermission request: {"action":"external_directory","resources":["/etc/*"]}';
    strictAssert.strictEqual(await captureReviewInput(false, prompt, path), false);
    await strictAssert.rejects(lstat(path), { code: 'ENOENT' });
    strictAssert.strictEqual(await captureReviewInput(true, prompt, path), true);
    const record = JSON.parse(await readFile(path, 'utf8'));
    strictAssert.strictEqual(record.input, prompt);
    strictAssert.strictEqual((await lstat(path)).mode & 0o777, 0o600);
    strictAssert.strictEqual((await lstat(path)).uid, process.getuid());
    strictAssert.strictEqual(await captureReviewInput(true, 'second sensitive input', path), false);
    strictAssert.strictEqual(JSON.parse(await readFile(path, 'utf8')).input, prompt);
  });

  it('refuses an oversized or symlinked reviewer input capture', async () => {
    const path = join(directory, 'oversized-review-input.json');
    strictAssert.strictEqual(await captureReviewInput(true, 'x'.repeat(32_768), path), false);
    await strictAssert.rejects(lstat(path), { code: 'ENOENT' });
    const target = join(directory, 'review-input-target');
    await writeFile(target, 'untouched');
    await symlink(target, path);
    strictAssert.strictEqual(await captureReviewInput(true, 'private input', path), false);
    strictAssert.strictEqual(await readFile(target, 'utf8'), 'untouched');
  });

  it('writes nothing when disabled', async () => {
    const path = join(directory, 'disabled.jsonl');
    const trace = createTrace(false, path);
    trace.record('ask');
    await trace.flush();
    await strictAssert.rejects(lstat(path), { code: 'ENOENT' });
  });

  it('writes only controlled fields and opaque correlation to an owner-only regular file', async () => {
    const path = join(directory, 'active.jsonl');
    const trace = createTrace(true, path);
    trace.record('generate-error', 'model-selection');
    await trace.flush();
    const stat = await lstat(path);
    strictAssert.strictEqual(stat.mode & 0o777, 0o600);
    strictAssert.strictEqual(stat.uid, process.getuid());
    strictAssert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort(), ['at', 'instance', 'reason', 'stage']);
    strictAssert.strictEqual(JSON.parse(await readFile(path, 'utf8')).reason, 'model-selection');
  });

  it('correlates records within one instance without recording input identifiers', async () => {
    const path = join(directory, 'correlated.jsonl');
    const first = createTrace(true, path);
    const second = createTrace(true, path);
    const sessionID = 'private-session-id';
    const requestID = 'private-request-id';
    const session = first.session(sessionID);
    const request = first.request(sessionID, requestID);
    strictAssert.match(session, /^[0-9a-f]{16}$/);
    strictAssert.match(request, /^[0-9a-f]{16}$/);
    strictAssert.strictEqual(first.session(sessionID), session);
    strictAssert.strictEqual(first.request(sessionID, requestID), request);
    strictAssert.notStrictEqual(first.session('different-session'), session);
    strictAssert.notStrictEqual(first.request(sessionID, 'different-request'), request);
    strictAssert.notStrictEqual(second.session(sessionID), session);
    strictAssert.notStrictEqual(second.request(sessionID, requestID), request);
    first.record('prompt-valid', undefined, { session });
    first.record('ask', undefined, { session, request });
    const reviewerText = 'unclear: private-token-should-not-be-written';
    first.record('decision-abstain', undefined, { session, request, abstain: abstainCategory(reviewerText) });
    await first.flush();
    second.record('ask', undefined, { session: second.session(sessionID), request: second.request(sessionID, requestID) });
    await second.flush();
    const content = await readFile(path, 'utf8');
    const records = content.trim().split('\n').map(JSON.parse);
    strictAssert.strictEqual(records.length, 4);
    strictAssert.strictEqual(records[0].instance, records[1].instance);
    strictAssert.strictEqual(records[1].instance, records[2].instance);
    strictAssert.notStrictEqual(records[2].instance, records[3].instance);
    strictAssert.strictEqual(records[0].session, records[1].session);
    strictAssert.strictEqual(records[1].request, records[2].request);
    strictAssert.strictEqual(records[2].abstain, 'uncertain');
    strictAssert.ok(!content.includes(sessionID) && !content.includes(requestID));
    strictAssert.ok(!content.includes(reviewerText) && !content.includes('private-token-should-not-be-written'));
  });

  it('categorizes abstentions without copying reviewer justification', () => {
    strictAssert.strictEqual(abstainCategory('Unsafe operation'), 'safety');
    strictAssert.strictEqual(abstainCategory('Insufficient context to decide'), 'insufficient-context');
    strictAssert.strictEqual(abstainCategory('Not clearly safe'), 'uncertain');
    strictAssert.strictEqual(abstainCategory('Outside the requested scope'), 'scope');
    strictAssert.strictEqual(abstainCategory('Private file /secret/password'), 'other');
  });

  it('records a bounded, redacted reviewer reason only for opted-in abstentions', async () => {
    const path = join(directory, 'reviewer-reason.jsonl');
    const enabled = createTrace(true, path);
    const justification = 'Scope is broader than requested: /etc/hosts and "read /etc/hosts again"; token=private-credential-value';
    enabled.record('decision-abstain', undefined, {
      session: enabled.session('private-session'),
      abstain: abstainCategory(justification),
      reviewerJustification: justification,
    });
    enabled.record('decision-approve', undefined, { reviewerJustification: justification });
    await enabled.flush();
    const content = await readFile(path, 'utf8');
    const [abstain, approval] = content.trim().split('\n').map(JSON.parse);
    strictAssert.strictEqual(abstain.reviewerReason,
      'Scope is broader than requested: [path] and [quoted]; token=[redacted]');
    strictAssert.strictEqual(abstain.abstain, 'scope');
    strictAssert.strictEqual(approval.reviewerReason, undefined);
    strictAssert.ok(!content.includes('/etc/hosts'));
    strictAssert.ok(!content.includes('private-credential-value'));
    strictAssert.ok(!content.includes('private-session'));
    strictAssert.strictEqual((await lstat(path)).mode & 0o777, 0o600);

    const disabledPath = join(directory, 'reviewer-reason-disabled.jsonl');
    const disabled = createTrace(false, disabledPath);
    disabled.record('decision-abstain', undefined, { reviewerJustification: justification });
    await disabled.flush();
    await strictAssert.rejects(lstat(disabledPath), { code: 'ENOENT' });
  });

  it('redacts URLs, emails, Windows paths, opaque strings, and control characters before byte truncation', () => {
    const text = 'Too broad: https://example.org/private?secret=x, user@example.org, C:\\private\\file, '
      + 'abcdefghijklmnopqrstuvwxyz0123456789\n' + '🔑'.repeat(200);
    const excerpt = reviewerReason(text);
    strictAssert.ok(excerpt.startsWith('Too broad: [url], [email], [path], [redacted]'));
    strictAssert.ok(!excerpt.includes('example.org') && !excerpt.includes('private'));
    strictAssert.ok(!excerpt.includes('\n'));
    strictAssert.ok(Buffer.byteLength(excerpt, 'utf8') <= 240);
    strictAssert.strictEqual(reviewerReason('"secret"'), '[quoted]');
  });

  it('refuses an existing symlink without changing its target', async () => {
    const target = join(directory, 'target');
    await writeFile(target, 'untouched');
    const link = join(directory, 'link');
    await symlink(target, link);
    const trace = createTrace(true, link);
    trace.record('ask');
    await trace.flush();
    strictAssert.strictEqual(await readFile(target, 'utf8'), 'untouched');
  });

  it('refuses a group-readable file and a full file', async () => {
    const readable = join(directory, 'readable');
    await writeFile(readable, 'untouched');
    await chmod(readable, 0o640);
    const first = createTrace(true, readable);
    first.record('ask');
    await first.flush();
    strictAssert.strictEqual(await readFile(readable, 'utf8'), 'untouched');

    const full = join(directory, 'full');
    await writeFile(full, 'x'.repeat(65_536), { mode: 0o600 });
    const second = createTrace(true, full);
    second.record('ask');
    await second.flush();
    strictAssert.strictEqual((await lstat(full)).size, 65_536);
  });

  it('maps errors into controlled categories rather than recording messages', () => {
    const selection = new Error('potentially sensitive error detail');
    selection.name = 'Generate.ModelSelectionError';
    strictAssert.strictEqual(errorCategory(selection), 'model-selection');
    strictAssert.strictEqual(errorCategory(new Error('secret detail')), 'other');
    strictAssert.strictEqual(errorCategory(new Error('Review aborted')), 'aborted');
  });

  it('does not claim a manual actor when a request is resolved', async () => {
    strictAssert.strictEqual(resolutionCategory(false, false), 'external-resolution');
    strictAssert.strictEqual(resolutionCategory(false, true), 'origin-unknown');
    strictAssert.strictEqual(resolutionCategory(true, false), 'self-resolution');
    const path = join(directory, 'resolution.jsonl');
    const trace = createTrace(true, path);
    trace.record('review-canceled', resolutionCategory(false, false));
    trace.record('resolution', resolutionCategory(false, true));
    trace.record('resolution', resolutionCategory(true, false));
    await trace.flush();
    const records = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    strictAssert.deepEqual(records.map(({ stage, reason }) => ({ stage, reason })), [
      { stage: 'review-canceled', reason: 'external-resolution' },
      { stage: 'resolution', reason: 'origin-unknown' },
      { stage: 'resolution', reason: 'self-resolution' },
    ]);
  });
});
