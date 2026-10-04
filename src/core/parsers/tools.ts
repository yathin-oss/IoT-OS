/**
 * Classifiers for flashing tool output (esptool, avrdude, arduino-cli upload,
 * mpremote). They turn raw stderr into a stable error code + actionable hint and
 * extract upload progress.
 */

export type FlashFailureCode =
  | 'PORT_BUSY'
  | 'PORT_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'NO_SYNC'
  | 'WRONG_CHIP'
  | 'TIMEOUT'
  | 'DEVICE_DISCONNECTED'
  | 'FILE_ERROR'
  | 'UNKNOWN';

export interface FlashFailure {
  code: FlashFailureCode;
  message: string;
  hint: string;
}

interface Pattern {
  re: RegExp;
  code: FlashFailureCode;
  hint: string;
}

const PATTERNS: Pattern[] = [
  { re: /resource busy|port is busy|Device or resource busy|Access is denied.*COM|could not open port .*(?:busy|in use)|Errno 16/i, code: 'PORT_BUSY', hint: 'Another program (or the IoT-OS Serial Monitor) holds the port. Close it and retry.' },
  { re: /permission denied|EACCES|Errno 13/i, code: 'PERMISSION_DENIED', hint: 'No permission to open the serial port. On Linux add your user to the dialout group and log in again.' },
  { re: /No such file or directory.*(?:tty|cu\.|COM)|could not open port|ser_open\(\): can't open device|port .* not found|does not exist|FileNotFoundError/i, code: 'PORT_NOT_FOUND', hint: 'The port does not exist. Check the cable and refresh the device list.' },
  { re: /Failed to connect to ESP|No serial data received|Wrong boot mode detected|Timed out waiting for packet header/i, code: 'NO_SYNC', hint: 'The ESP did not enter download mode. Hold BOOT, tap EN/RST, release BOOT, then retry. Check the cable supports data.' },
  { re: /stk500_recv\(\): programmer is not responding|stk500_getsync\(\).*not in sync|butterfly_recv|programmer is not responding/i, code: 'NO_SYNC', hint: 'The bootloader did not respond. Check the selected board/port, try a different cable, or select the "old bootloader" option for Nano clones.' },
  { re: /Device signature = .* expected signature|This chip is .*, not|Unexpected chip id|wrong chip|Chip is .* not .* /i, code: 'WRONG_CHIP', hint: 'The connected board is not the board selected in the project. Change the project board or connect the correct device.' },
  { re: /timed out|timeout/i, code: 'TIMEOUT', hint: 'The device stopped responding. Reconnect it and retry.' },
  { re: /device reports readiness to read but returned no data|disconnected|Input\/output error|Errno 5|Errno 6/i, code: 'DEVICE_DISCONNECTED', hint: 'The device disconnected during the operation. Check the cable and power.' },
  { re: /can't open input file|No such file.*\.(?:bin|hex|uf2|elf)|error opening/i, code: 'FILE_ERROR', hint: 'The firmware file is missing. Rebuild the project.' },
];

export function classifyFlashFailure(output: string): FlashFailure {
  for (const p of PATTERNS) {
    const m = p.re.exec(output);
    if (m) {
      const line = output.split(/\r?\n/).find((l) => p.re.test(l))?.trim() ?? m[0];
      return { code: p.code, message: line, hint: p.hint };
    }
  }
  const last = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return { code: 'UNKNOWN', message: last ?? 'Upload failed with no output', hint: 'See the full tool output in the Build panel.' };
}

/** Extracts a 0-100 progress value from a line of flashing tool output. */
export function parseFlashProgress(line: string): number | null {
  // esptool: "Writing at 0x00010000... (12 %)" or "Writing at 0x00010000 [=====>    ] 45.2% 123/456 bytes"
  const esp = /Writing at 0x[0-9a-f]+.*?\(\s*(\d+)\s*%\s*\)|Writing at 0x[0-9a-f]+.*?\s(\d+(?:\.\d+)?)%/i.exec(line);
  if (esp) return Math.min(100, Math.round(Number(esp[1] ?? esp[2])));
  // avrdude: "Writing | ################################################## | 100% 0.80s"
  const avr = /^(?:Writing|Reading)\s*\|\s*#*\s*\|\s*(\d+)%/.exec(line.trim());
  if (avr) return Number(avr[1]);
  // generic "NN%"
  const generic = /^\s*(\d{1,3})%\s*$/.exec(line);
  if (generic) return Math.min(100, Number(generic[1]));
  return null;
}
