import { describe, expect, it } from 'vitest';
import { parseCompilerOutput, parseSizeReport, remapPath } from './compiler';
import { classifyFlashFailure, parseFlashProgress } from './tools';
import { detectRuntimeIssues } from './runtime';

const STAGE = '/tmp/iotos-build/sketch';

const GCC_OUTPUT = `
${STAGE}/src/main.cpp: In function 'void loop()':
${STAGE}/src/main.cpp:12:3: error: 'digitalWrit' was not declared in this scope; did you mean 'digitalWrite'?
   12 |   digitalWrit(LED1_PIN, HIGH);
      |   ^~~~~~~~~~~
${STAGE}/src/main.cpp:4:7: warning: unused variable 'x' [-Wunused-variable]
${STAGE}/src/main.cpp:2:10: fatal error: DHT.h: No such file or directory
    2 | #include <DHT.h>
compilation terminated.
exit status 1
`;

describe('compiler output parser', () => {
  it('extracts file, line, column, severity, code and message with path remapping', () => {
    const diags = parseCompilerOutput(GCC_OUTPUT, { pathMappings: [{ from: STAGE, to: '' }] });
    expect(diags).toEqual([
      expect.objectContaining({ code: 'UNDECLARED_IDENTIFIER', severity: 'error', target: { file: 'src/main.cpp', line: 12, column: 3 } }),
      expect.objectContaining({ code: 'GCC_WUNUSED_VARIABLE', severity: 'warning', message: "unused variable 'x'" }),
      expect.objectContaining({ code: 'MISSING_HEADER', severity: 'error', target: { file: 'src/main.cpp', line: 2, column: 10 } }),
    ]);
  });

  it('parses linker errors', () => {
    const out = `/home/u/.cache/arduino/sketches/ABC/sketch/main.cpp.o: in function \`loop':
${STAGE}/src/main.cpp:20: undefined reference to \`readSensor()'
collect2: error: ld returned 1 exit status`;
    const d = parseCompilerOutput(out, { pathMappings: [{ from: STAGE, to: '' }] });
    expect(d).toEqual([expect.objectContaining({ code: 'LINKER_UNDEFINED_REFERENCE', source: 'linker', target: { file: 'src/main.cpp', line: 20 } })]);
    const overflow = parseCompilerOutput("/opt/avr/bin/ld: region `text' overflowed by 1234 bytes");
    expect(overflow[0]?.code).toBe('LINKER_MEMORY_OVERFLOW');
  });

  it('parses Windows paths and remaps', () => {
    const d = parseCompilerOutput('C:\\Users\\me\\sketch\\main.cpp:3:1: error: expected \';\' before \'}\' token');
    expect(d[0]?.target?.file).toBe('C:/Users/me/sketch/main.cpp');
    expect(d[0]?.code).toBe('SYNTAX_ERROR');
    expect(remapPath('/a/b/c.cpp', [{ from: '/a/b', to: 'src' }])).toBe('src/c.cpp');
  });

  it('parses arduino-cli size report', () => {
    const r = parseSizeReport(
      'Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.\nGlobal variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.',
    );
    expect(r).toEqual({ programBytes: 924, programMax: 32256, dataBytes: 9, dataMax: 2048 });
    expect(parseSizeReport('nothing')).toBeNull();
  });
});

describe('flash tool output', () => {
  it('classifies common failures', () => {
    expect(classifyFlashFailure('A fatal error occurred: Failed to connect to ESP32: No serial data received.').code).toBe('NO_SYNC');
    expect(classifyFlashFailure('avrdude: stk500_recv(): programmer is not responding').code).toBe('NO_SYNC');
    expect(classifyFlashFailure("could not open port '/dev/cu.usbserial': [Errno 16] Resource busy").code).toBe('PORT_BUSY');
    expect(classifyFlashFailure('avrdude: Device signature = 0x1e950f expected signature for ATmega2560').code).toBe('WRONG_CHIP');
    expect(classifyFlashFailure('[Errno 13] Permission denied: /dev/ttyUSB0').code).toBe('PERMISSION_DENIED');
    expect(classifyFlashFailure('weird\nthings').code).toBe('UNKNOWN');
  });

  it('parses progress', () => {
    expect(parseFlashProgress('Writing at 0x00010000... (12 %)')).toBe(12);
    expect(parseFlashProgress('Writing at 0x0002b3c4 [=====>   ]  45.2% 123/456 bytes...')).toBe(45);
    expect(parseFlashProgress('Writing | ################################################## | 100% 0.80s')).toBe(100);
    expect(parseFlashProgress('Hard resetting via RTS pin...')).toBeNull();
  });
});

describe('runtime serial issue detection', () => {
  it('detects ESP32 brownouts, panics and MicroPython tracebacks', () => {
    const d = detectRuntimeIssues([
      'Brownout detector was triggered',
      'rst:0xc (SW_CPU_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)',
      'Brownout detector was triggered',
      "Guru Meditation Error: Core  1 panic'ed (LoadProhibited). Exception was unhandled.",
      'Traceback (most recent call last):',
      '  File "main.py", line 7, in <module>',
      "NameError: name 'led' isn't defined",
    ]);
    expect(d.map((x) => x.code)).toEqual(['ESP_BROWNOUT', 'ESP_PANIC', 'ESP_RESET_REASON', 'PY_TRACEBACK']);
    expect(d[0]!.message).toMatch(/×2/);
    expect(d.find((x) => x.code === 'PY_TRACEBACK')!.target).toEqual({ file: 'main.py', line: 7 });
  });
});
