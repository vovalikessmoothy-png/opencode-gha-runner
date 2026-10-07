import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LaunchRequest } from '../src/contracts.js';
import type { Identity } from '../src/runner/identity.js';
import { materializeProfileSnapshot, uploadProfileChanges } from '../src/runner/profile-snapshot.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('profile snapshot is checksum-verified, extracted as a git baseline, and uploaded via run capability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-snapshot-'));
  try {
    const source = path.join(root, 'source');
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(source, 'notes'), { recursive: true });
    const before = Buffer.from('before');
    await writeFile(path.join(source, 'notes/state.txt'), before);
    const archive = path.join(root, 'snapshot.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, 'notes/state.txt']);
    const snapshot = await readFile(archive);
    const identity: Identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false };
    const spec = {
      runId: 'run-test', profileId: 'profile-test',
      profileWorkspace: {
        bindingId: 'binding-test', snapshotUrl: 'https://api.invalid/snapshot', snapshotSha256: hash(snapshot), snapshotSize: snapshot.length,
        savebackUrl: 'https://api.invalid/v1/worker/launches/run-test/profile-changes', savebackToken: 'x'.repeat(48),
        artifacts: [], excludedPatterns: [],
      },
    } as unknown as LaunchRequest;
    await materializeProfileSnapshot(spec, workspace, identity, async () => new Response(snapshot));
    assert.equal(await readFile(path.join(workspace, 'notes/state.txt'), 'utf8'), 'before');
    execFileSync('git', ['-C', workspace, 'status', '--porcelain']);

    const after = Buffer.from('after');
    await writeFile(path.join(workspace, 'notes/state.txt'), after);
    const requests: Array<{ url: string; authorization: string | null; body: Buffer }> = [];
    await uploadProfileChanges({
      spec, workspace, identity,
      files: [{ path: 'artifacts/notes/state.txt', sha256: hash(after), size: after.length }],
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: Buffer.from(init?.body as Uint8Array) });
        return new Response(null, { status: 204 });
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.authorization, `Bearer ${'x'.repeat(48)}`);
    assert.equal(new URL(requests[0]!.url).searchParams.get('path'), 'notes/state.txt');
    assert.deepEqual(requests[0]!.body, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile snapshot checksum mismatch is rejected before extraction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-snapshot-bad-'));
  try {
    const workspace = path.join(root, 'workspace');
    const identity: Identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false };
    const spec = { profileWorkspace: { bindingId: 'binding', snapshotUrl: 'https://api.invalid/snapshot', snapshotSha256: '0'.repeat(64), snapshotSize: 3, savebackUrl: 'https://api.invalid/save', savebackToken: 'x'.repeat(48), artifacts: [], excludedPatterns: [] } } as unknown as LaunchRequest;
    await assert.rejects(() => materializeProfileSnapshot(spec, workspace, identity, async () => new Response('bad')), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
