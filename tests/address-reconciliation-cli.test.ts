import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseAddressReconciliationArgs, addressReconciliationUsage } from '../scripts/reconcile-address-selection.js';

describe('Explicit local address-reconciliation CLI arguments', () => {
  const args = ['--operation', randomUUID(), '--snapshot-operation', randomUUID(), '--reconciliation-operation', randomUUID()];
  it('defaults to proof-only dry-run and requires the literal apply flag', () => {
    expect(parseAddressReconciliationArgs(args)).toMatchObject({ help: false, input: { apply: false } });
    expect(parseAddressReconciliationArgs([...args, '--apply'])).toMatchObject({ help: false, input: { apply: true } });
    expect(parseAddressReconciliationArgs(['--help'])).toEqual({ help: true });
    expect(addressReconciliationUsage).toContain('Default: verify linked proof only');
  });
  it.each([[], ['--apply'], [...args, '--apply=true'], [...args, '--apply', '--apply'], [...args, '--owner', 'foreign-owner'], ['--operation', 'PRIVATE_INVALID_VALUE']].map((argv) => ({ argv })))('rejects invalid/ambiguous or owner-overriding arguments without opening a store: $argv', ({ argv }) => {
    expect(() => parseAddressReconciliationArgs(argv)).toThrow();
  });
  it('prints safe help and redacted argument errors without connecting to a database', () => {
    const help = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/reconcile-address-selection.ts', '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0); expect(help.stdout).toContain('Default: verify linked proof only');
    const invalid = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/reconcile-address-selection.ts', '--operation', 'PRIVATE_INVALID_ADDRESS'], { encoding: 'utf8' });
    expect(invalid.status).toBe(1); expect(invalid.stderr).toContain('INVALID_RECONCILIATION_ARGUMENTS');
    expect(invalid.stdout + invalid.stderr).not.toContain('PRIVATE_INVALID_ADDRESS');
  });
});
