#!/usr/bin/env node
// `selfhost-kit docker-assets <dir>`: see src/cli/index.ts.
import { runCli } from '../dist/cli/index.js';

process.exitCode = await runCli(process.argv.slice(2));
