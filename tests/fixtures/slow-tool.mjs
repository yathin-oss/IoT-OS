#!/usr/bin/env node
// TEST DOUBLE: prints its arguments, then sleeps (to exercise timeouts/cancellation).
console.log(JSON.stringify(process.argv.slice(2)));
if (process.argv.includes('--print-env')) console.log(`KEY=${process.env.ANTHROPIC_API_KEY ?? 'unset'}`);
if (process.argv.includes('--fail')) process.exit(3);
if (process.argv.includes('--sleep')) setTimeout(() => {}, 60_000);
