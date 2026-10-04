#!/usr/bin/env node
// TEST DOUBLE — NOT the real Arduino CLI.
// Mimics the subset of arduino-cli 1.x commands and JSON output that IoT-OS uses,
// so the build/flash/library pipelines can be integration-tested where the real
// toolchain is unavailable. Behaviour is controlled with FAKE_ARDUINO_* env vars.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const env = process.env;
const log = (line) => env.FAKE_ARDUINO_LOG && appendFileSync(env.FAKE_ARDUINO_LOG, line + '\n');
log(JSON.stringify(args));
const json = (o) => process.stdout.write(JSON.stringify(o));
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cores = (env.FAKE_ARDUINO_CORES ?? 'arduino:avr').split(',').filter(Boolean);
const libs = (env.FAKE_ARDUINO_LIBS ?? '').split(',').filter(Boolean);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const [cmd, sub] = args;
if (cmd === 'version') {
  json({ VersionString: '1.2.2', Commit: 'test-double', Status: 'test' });
} else if (cmd === 'core' && sub === 'list') {
  json({ platforms: cores.map((id) => ({ id, installed_version: '9.9.9', latest_version: '9.9.9' })) });
} else if (cmd === 'core' && (sub === 'update-index' || sub === 'install')) {
  console.log(`[test double] core ${sub} ${args.slice(2).join(' ')}`);
} else if (cmd === 'lib' && sub === 'list') {
  json({ installed_libraries: libs.map((name) => ({ library: { name, version: '1.0.0', install_dir: `/fake/libraries/${name}`, architectures: ['*'] } })) });
} else if (cmd === 'lib' && sub === 'search') {
  json({ libraries: [{ name: 'DHT sensor library', latest: { version: '1.4.6', author: 'Adafruit', sentence: 'Arduino library for DHT11, DHT22 sensors', architectures: ['*'] }, available_versions: ['1.4.4', '1.4.6'] }] });
} else if (cmd === 'lib' && ['install', 'uninstall', 'upgrade'].includes(sub)) {
  console.log(`[test double] lib ${sub} ${args[2]}`);
} else if (cmd === 'outdated') {
  json({ libraries: [] });
} else if (cmd === 'compile') {
  const sketch = args[args.length - 1];
  const buildPath = flag('--build-path');
  let failed = false;
  for (const file of walk(join(sketch, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (l.includes('IOTOS_TEST_COMPILE_ERROR')) {
        process.stderr.write(`${file}:${i + 1}:3: error: 'digitalWrit' was not declared in this scope; did you mean 'digitalWrite'?\n`);
        failed = true;
      }
      const m = /#include <(DHT)\.h>/.exec(l);
      if (m && !libs.includes('DHT sensor library')) {
        process.stderr.write(`${file}:${i + 1}:10: fatal error: DHT.h: No such file or directory\ncompilation terminated.\n`);
        failed = true;
      }
    });
  }
  if (failed) {
    process.stderr.write('Error during build: exit status 1\n');
    process.exit(1);
  }
  mkdirSync(buildPath, { recursive: true });
  if (env.FAKE_ARDUINO_HEX && existsSync(env.FAKE_ARDUINO_HEX)) copyFileSync(env.FAKE_ARDUINO_HEX, join(buildPath, 'sketch.ino.hex'));
  else writeFileSync(join(buildPath, 'sketch.ino.hex'), ':00000001FF\n');
  writeFileSync(join(buildPath, 'sketch.ino.elf'), 'ELF');
  console.log('Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.');
  console.log('Global variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.');
} else if (cmd === 'upload') {
  if (env.FAKE_UPLOAD_FAIL) {
    process.stderr.write('avrdude: stk500_recv(): programmer is not responding\navrdude: stk500_getsync() attempt 10 of 10: not in sync: resp=0x00\nFailed uploading: uploading error: exit status 1\n');
    process.exit(1);
  }
  console.log('Writing | ################################################## | 100% 0.80s');
  console.log('avrdude done.  Thank you.');
} else {
  process.stderr.write(`[test double] unsupported command: ${args.join(' ')}\n`);
  process.exit(2);
}
