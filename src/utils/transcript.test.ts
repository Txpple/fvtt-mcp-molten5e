import { describe, it, expect } from 'vitest';
import { validateExportDestinations } from './transcript.js';

describe('validateExportDestinations', () => {
  it('rejects when neither destination is given', () => {
    const r = validateExportDestinations({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/localPath, remotePath, or both/);
  });

  it('rejects a non-absolute local path', () => {
    const r = validateExportDestinations({ localPath: 'relative/log.md' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/absolute/);
  });

  it('accepts an absolute local path', () => {
    // Use a POSIX-absolute path; isAbsolute on win32 also accepts a drive path, but POSIX form is
    // portable for the test runner regardless of platform.
    const abs = process.platform === 'win32' ? 'C:\\tmp\\log.md' : '/tmp/log.md';
    expect(validateExportDestinations({ localPath: abs }).ok).toBe(true);
  });

  it('accepts remote-only', () => {
    expect(validateExportDestinations({ remotePath: 'worlds/w/exports/log.md' }).ok).toBe(true);
  });

  it('accepts both', () => {
    const abs = process.platform === 'win32' ? 'C:\\tmp\\log.md' : '/tmp/log.md';
    expect(
      validateExportDestinations({ localPath: abs, remotePath: 'worlds/w/exports/log.md' }).ok
    ).toBe(true);
  });
});
