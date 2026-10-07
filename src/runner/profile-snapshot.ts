import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, readdir, lstat, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath, type LaunchRequest } from '../contracts.js';
import { runUnderIdentity, type Identity } from './identity.js';

const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

/** Download, authenticate and safely materialize the API-owned snapshot for one run. */
export async function materializeProfileSnapshot(
  spec: LaunchRequest,
  workspace: string,
  identity: Identity,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const profile = spec.profileWorkspace;
  if (!profile) throw new Error('profile snapshot requested for a non-profile run');
  if (!/^https:\/\//.test(profile.snapshotUrl)) throw new Error('profile snapshot URL must use HTTPS');
  if (!/^[0-9a-f]{64}$/.test(profile.snapshotSha256) || !Number.isSafeInteger(profile.snapshotSize)
      || profile.snapshotSize < 0 || profile.snapshotSize > MAX_SNAPSHOT_BYTES) {
    throw new Error('profile snapshot digest or size is invalid');
  }
  if (!/^https:\/\//.test(profile.savebackUrl) || profile.savebackToken.length < 32) {
    throw new Error('profile saveback capability is invalid');
  }

  const response = await fetchImpl(profile.snapshotUrl, { redirect: 'error' });
  if (!response.ok) throw new Error(`profile snapshot download failed (${response.status})`);
  const declaredLength = Number(response.headers.get('content-length') ?? profile.snapshotSize);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== profile.snapshotSize || declaredLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('profile snapshot response size is invalid');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('profile snapshot response has no body');
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > profile.snapshotSize || received > MAX_SNAPSHOT_BYTES) {
      await reader.cancel();
      throw new Error('profile snapshot exceeds declared size');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (bytes.length !== profile.snapshotSize) throw new Error('profile snapshot size mismatch');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== profile.snapshotSha256) throw new Error('profile snapshot checksum mismatch');

  const archive = path.join(path.dirname(workspace), `${path.basename(workspace)}.snapshot.tar.gz`);
  await mkdir(workspace, { recursive: true, mode: 0o750 });
  await writeFile(archive, bytes, { mode: 0o600 });
  await chmod(archive, 0o644);
  try {
    // Validate names before extraction, then reject links/devices before tar can create them.
    const names = await runUnderIdentity(identity, 'tar', ['-tzf', archive], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
    const entries = names.stdout.split('\n').filter(Boolean);
    if (entries.length > 100_000) throw new Error('profile snapshot has too many entries');
    for (const name of entries) {
      const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
      if (!isSafeRelativePath(normalized)) throw new Error(`unsafe profile snapshot path: ${name}`);
      if (normalized === '.git' || normalized.startsWith('.git/')) throw new Error('profile snapshot may not contain a git metadata directory');
    }
    const verbose = await runUnderIdentity(identity, 'tar', ['-tvzf', archive], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
    for (const line of verbose.stdout.split('\n').filter(Boolean)) {
      if (line[0] !== '-' && line[0] !== 'd') throw new Error('profile snapshot may contain only regular files and directories');
    }
    await mkdir(workspace, { recursive: true, mode: 0o750 });
    await runUnderIdentity(identity, 'tar', [
      '-xzf', archive, '-C', workspace, '--no-same-owner', '--no-same-permissions',
    ], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });

    // Ensure the extracted tree contains only regular files/directories and no links escaped.
    const root = await realpath(workspace);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('profile snapshot contains a non-regular entry');
        const resolved = await realpath(absolute);
        if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('profile snapshot entry escaped workspace');
        if (stat.isDirectory()) await walk(absolute);
        else if (stat.size > MAX_SNAPSHOT_BYTES) throw new Error('profile snapshot file exceeds size limit');
      }
    };
    await walk(root);

    for (const artifact of profile.artifacts) {
      const absolute = path.resolve(workspace, artifact.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`profile artifact escaped workspace: ${artifact.path}`);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size) throw new Error(`profile artifact size mismatch: ${artifact.path}`);
      const actual = createHash('sha256').update(await readFile(absolute)).digest('hex');
      if (actual !== artifact.sha256) throw new Error(`profile artifact checksum mismatch: ${artifact.path}`);
    }

    // A synthetic local baseline lets the existing profile diff collector identify edits.
    await runUnderIdentity(identity, 'git', ['-C', workspace, 'init', '--quiet'], { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: identity.home });
    await runUnderIdentity(identity, 'git', ['-C', workspace, 'add', '-A'], { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: identity.home });
    await runUnderIdentity(identity, 'git', ['-C', workspace, '-c', 'user.name=Profile Snapshot', '-c', 'user.email=profile-snapshot@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'API profile snapshot baseline'], { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: identity.home });
  } finally {
    await rm(archive, { force: true });
  }
}

export async function uploadProfileChanges(options: {
  spec: LaunchRequest;
  workspace: string;
  identity: Identity;
  files: Array<{ path: string; sha256: string; size: number }>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const profile = options.spec.profileWorkspace;
  if (!profile) throw new Error('profile saveback requested for a non-profile run');
  const fetchImpl = options.fetchImpl ?? fetch;
  let totalBytes = 0;
  for (const file of options.files) {
    const relative = file.path.replace(/^artifacts\//, '');
    if (!isSafeRelativePath(relative)) throw new Error(`unsafe profile saveback path: ${relative}`);
    totalBytes += file.size;
    if (file.size > 50 * 1024 * 1024 || totalBytes > 100 * 1024 * 1024) throw new Error('profile saveback exceeds API upload limits');
    const absolute = path.resolve(options.workspace, relative);
    const bytes = await readFile(absolute);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256 || bytes.length !== file.size) throw new Error(`profile saveback file changed after collection: ${relative}`);
    const url = new URL(profile.savebackUrl);
    url.searchParams.set('path', relative);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.savebackToken}`, 'content-type': 'application/octet-stream', 'x-content-sha256': file.sha256 },
      body: bytes,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`profile saveback upload failed (${response.status}) for ${relative}`);
  }
}
