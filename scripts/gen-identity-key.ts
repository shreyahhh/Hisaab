// Prints a fresh identity master key (32 random bytes, base64) for local .env use:
//
//   IDENTITY_MASTER_K1=$(pnpm -s gen:identity-key)
//
// Local development only. Deployed environments get their keys from Secrets Manager
// (`truepath/identity-master/k<N>`), created by whoever owns the account, never from this script.
import { generateIdentityMasterKey } from '../packages/privacy/src/generateKey.ts';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    [
      'Usage: pnpm -s gen:identity-key',
      '',
      'Prints one fresh base64 identity master key (32 random bytes) to stdout, nothing else.',
      'Put it in your local .env as IDENTITY_MASTER_K1, with IDENTITY_KEY_READ=k1 and IDENTITY_KEY_WRITE=k1.',
      'A key is only ever printed; this script writes no files.',
      '',
    ].join('\n'),
  );
} else {
  process.stdout.write(`${generateIdentityMasterKey()}\n`);
}
