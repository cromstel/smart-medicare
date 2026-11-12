import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySeedPasswordHashes,
  DEMO_ACCOUNTS,
  resolveDemoCredentials,
} from '../config/demoCredentials.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.resolve(here, '..', 'database', 'seed.sql');

describe('the seeded account passwords', () => {
  it('replaces every placeholder in the seed file with a real hash', () => {
    const seed = fs.readFileSync(seedPath, 'utf8');
    const hashes: Record<string, string> = {};
    for (const account of DEMO_ACCOUNTS) {
      hashes[account.hashPlaceholder] = `hash-for-${account.id}`;
    }

    const rendered = applySeedPasswordHashes(seed, hashes);

    // The failure this guards against is silent: a pattern that matches
    // nothing leaves the literal text in the statement, and the account then
    // exists but cannot be signed into with any password.
    expect(rendered).not.toMatch(/\$\{[A-Z_]*PASSWORD_HASH\}/);
    expect(rendered).toContain('hash-for-superAdmin');
    expect(rendered).toContain('hash-for-radiologyTechnician');
  });

  it('substitutes a placeholder that still carries the SEED_ prefix', () => {
    // The prefix was removed from the environment variables and from the
    // seed file, but the pattern kept asking for it. A pattern that demands a
    // prefix the file no longer has matches nothing.
    const rendered = applySeedPasswordHashes(
      "('${SEED_ADMIN_PASSWORD_HASH}')",
      { ADMIN_PASSWORD_HASH: 'a-real-hash' }
    );
    expect(rendered).toBe("('a-real-hash')");
  });

  it('refuses to leave a placeholder unresolved', () => {
    expect(() =>
      applySeedPasswordHashes("('${ADMIN_PASSWORD_HASH}')", { SOME_OTHER_ACCOUNT: 'x' })
    ).toThrow(/password hash/i);
  });

  it('gives every seeded account a password from the environment', () => {
    // The accounts are what a fresh checkout signs in with, so each one has
    // to resolve. A variable that is unset is a failure, not a fallback to a
    // shared development password.
    const names = DEMO_ACCOUNTS.map((account) => account.envVar);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
    expect(names).toContain('SUPER_ADMIN_PASSWORD');
    expect(names).toContain('ADMIN_PASSWORD');
  });

  it('resolves every account when its variable is set', () => {
    const saved: Record<string, string | undefined> = {};
    for (const account of DEMO_ACCOUNTS) {
      saved[account.envVar] = process.env[account.envVar];
      process.env[account.envVar] = `password-for-${account.id}`;
    }
    try {
      const credentials = resolveDemoCredentials();
      for (const account of DEMO_ACCOUNTS) {
        expect(credentials[account.id]).toBe(`password-for-${account.id}`);
      }
    } finally {
      for (const account of DEMO_ACCOUNTS) {
        if (saved[account.envVar] === undefined) delete process.env[account.envVar];
        else process.env[account.envVar] = saved[account.envVar];
      }
    }
  });
});
