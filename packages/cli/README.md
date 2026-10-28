# @agenticool/cli

Parse command-line arguments for @agenticool commands: exact aliases, `--option=value`, `--`, help, and usage errors. Internal to @agenticool; no stability promise for other callers. Built on `node:util` `parseArgs`, with no runtime dependencies.

## Bins and config keys

None. The package reads no `.agents/policy.json` keys; each calling package defines its own options and help text.

## Exports

- `defineCli(usage, definitions, { passthrough })` returns a CLI description. `definitions` maps each long option name to `{ type: 'string' | 'boolean', alias?, description }`. `--help` / `-h` is always added. It throws when two options share a spelling, including `--help` or `-h`.
- `parseCli(argv, cli)` returns `{ options, positionals, passthrough }`. It throws `CliHelp` (message: the help text) for `--help` or `-h`, and `CliError` (message: the problem, then the help text) for malformed input.
- `cliError(cli, message)` builds a `CliError` with the help text appended, for a caller's own validation.
- `CliError`, `CliHelp`: error classes, so a bin can print help to stdout and exit 0, or print the error to stderr and exit 1.

```js
import { CliError, CliHelp, defineCli, parseCli } from '@agenticool/cli';

const cli = defineCli('Usage: branch-name [options] <issue>', {
  layer: { type: 'string', alias: 'l', description: 'Stack layer' },
  'dry-run': { type: 'boolean', alias: 'n', description: 'Preview only' },
});
const { options, positionals } = parseCli(process.argv.slice(2), cli);
```

## Parsing rules

- Spellings are exact: `--layer` and `-l`. Short options cannot be grouped (`-nl` is an error), and an alias may be longer than one letter (`-env`).
- String options accept `--layer=2` or `--layer 2`. A separate value may begin with a single dash (`-a -sam`), but not with `--` or a known spelling; use `--actor=--x` for those. An empty string value is an error.
- Boolean options take no value (`--dry-run=false` is an error).
- Each option may appear once.
- `--` ends options; every later token is a positional.
- An unknown token starting with `-` (other than `-` itself) is an error; other tokens are positionals.

### Passthrough mode

With `{ passthrough: true }`, a wrapper parses its own options and forwards the rest to another command. Unknown tokens, and `--` with every token after it, go to `passthrough` in their original order instead of being rejected or treated as positionals. Known options still follow every rule above, so a duplicate or missing value is still an error.
