import { IotosError } from '../errors';

/**
 * Intel HEX parser (record types 00 data, 01 EOF, 02 extended segment address,
 * 04 extended linear address). Writes into `target` and returns the highest
 * address written + 1.
 */
export function loadIntelHex(text: string, target: Uint8Array): number {
  let base = 0;
  let maxAddr = 0;
  let sawEof = false;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (!line) continue;
    if (line[0] !== ':' || line.length < 11 || line.length % 2 === 0) {
      throw new IotosError('INVALID_ARGUMENT', `Invalid Intel HEX record on line ${n + 1}`);
    }
    const bytes = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(line.substr(1 + i * 2, 2), 16);
    const count = bytes[0]!;
    if (bytes.length !== count + 5) throw new IotosError('INVALID_ARGUMENT', `Intel HEX length mismatch on line ${n + 1}`);
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) throw new IotosError('INVALID_ARGUMENT', `Intel HEX checksum error on line ${n + 1}`);
    const addr = (bytes[1]! << 8) | bytes[2]!;
    const type = bytes[3]!;
    if (type === 0) {
      const start = base + addr;
      if (start + count > target.length) throw new IotosError('INVALID_ARGUMENT', `Firmware does not fit in program memory (address 0x${start.toString(16)})`);
      target.set(bytes.subarray(4, 4 + count), start);
      maxAddr = Math.max(maxAddr, start + count);
    } else if (type === 1) {
      sawEof = true;
      break;
    } else if (type === 2) {
      base = ((bytes[4]! << 8) | bytes[5]!) << 4;
    } else if (type === 4) {
      base = ((bytes[4]! << 8) | bytes[5]!) << 16;
    }
  }
  if (!sawEof) throw new IotosError('INVALID_ARGUMENT', 'Intel HEX file has no end-of-file record');
  return maxAddr;
}

/** Encodes bytes as Intel HEX (used by tests and tooling). */
export function toIntelHex(data: Uint8Array, recordSize = 16): string {
  const lines: string[] = [];
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  for (let addr = 0; addr < data.length; addr += recordSize) {
    const chunk = data.subarray(addr, Math.min(addr + recordSize, data.length));
    const rec = [chunk.length, (addr >> 8) & 0xff, addr & 0xff, 0, ...chunk];
    const sum = (0x100 - (rec.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    lines.push(':' + rec.map(hex).join('') + hex(sum));
  }
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}
