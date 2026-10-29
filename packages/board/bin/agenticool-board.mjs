#!/usr/bin/env node
import { main } from '@agenticool/board';

process.exitCode = await main(process.argv.slice(2));
