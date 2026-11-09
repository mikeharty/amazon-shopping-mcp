import { pathToFileURL } from 'node:url';
import { DomainError } from '../packages/contracts/index.js';
import { loadConfig } from '../packages/core/config.js';
import { Store } from '../packages/store/index.js';
import { AddressSelectionReconciliation, addressReconciliationInput } from '../packages/store/address-reconciliation.js';

export const addressReconciliationUsage = 'Usage: node --env-file=.env --import tsx scripts/reconcile-address-selection.ts --operation UUID --snapshot-operation UUID --reconciliation-operation UUID [--apply]\nDefault: verify linked proof only. --apply explicitly appends the encrypted receipt and releases only the matching address-selection quarantine. No Amazon calls or order actions.';

export function parseAddressReconciliationArgs(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true as const };
  const values: Record<string, unknown> = { apply: false };
  const names: Record<string, string> = { '--operation': 'operationId', '--snapshot-operation': 'snapshotOperationId', '--reconciliation-operation': 'reconciliationOperationId' };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (seen.has(argument)) throw new Error('Invalid arguments');
    seen.add(argument);
    if (argument === '--apply') { values.apply = true; continue; }
    const name = names[argument]; const value = argv[++index];
    if (!name || !value || value.startsWith('--')) throw new Error('Invalid arguments');
    values[name] = value;
  }
  return { help: false as const, input: addressReconciliationInput.parse(values) };
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseAddressReconciliationArgs>;
  try { parsed = parseAddressReconciliationArgs(process.argv.slice(2)); }
  catch { console.error(`INVALID_RECONCILIATION_ARGUMENTS\n${addressReconciliationUsage}`); process.exitCode = 1; return; }
  if (parsed.help) { console.log(addressReconciliationUsage); return; }
  let store: Store | undefined;
  try {
    const config = loadConfig();
    store = new Store(config.databaseUrl, config.dataKey);
    // Migrations belong to the reviewed service release, never this dry-run command.
    const result = await new AddressSelectionReconciliation(store).run(config.ownerId, parsed.input);
    console.log(JSON.stringify(result)); // IDs, evidence digest and scope only; no addresses or credentials.
  } catch (error) {
    console.error(error instanceof DomainError ? error.code : 'ADDRESS_RECONCILIATION_FAILED');
    process.exitCode = 1;
  } finally { await store?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
