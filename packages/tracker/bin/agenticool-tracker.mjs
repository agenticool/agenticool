#!/usr/bin/env node
import { main } from '@agenticool/tracker';

process.exitCode = await main(process.argv.slice(2));
