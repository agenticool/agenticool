#!/usr/bin/env node
import { main } from '@agenticool/workflow-lint';

process.exitCode = main(process.argv.slice(2));
