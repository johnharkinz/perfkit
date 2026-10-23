#!/usr/bin/env node
import { start } from './start.js';

const started = await start({
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  fetch: globalThis.fetch,
});
if (started.exitCode !== undefined) process.exit(started.exitCode);
