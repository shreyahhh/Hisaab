// UUID v7 (RFC 9562): 48-bit Unix-ms timestamp, version 7, variant 10, the rest random. The visitor id
// is a v7 (collector.md §2.2 requires it) so ids sort by creation time. Random bytes are injected so
// the function is deterministic under test; the browser implementation feeds it `crypto.getRandomValues`.

const HEX = '0123456789abcdef';

export function uuidV7(nowMs: number, random: Uint8Array): string {
  const bytes = new Uint8Array(16);
  bytes.set(random.subarray(0, 16));

  const ms = Math.max(0, Math.floor(nowMs));
  // `>>>` would truncate to 32 bits, so the high bytes come from division.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10

  let out = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i] ?? 0;
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
