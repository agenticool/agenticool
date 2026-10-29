import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CliError,
  CliHelp,
  cliError,
  defineCli,
  parseCli,
} from '../src/index.mjs';

/** @type {Record<string, import('../src/index.mjs').OptionDefinition>} */
const definitions = {
  actor: { type: 'string', alias: 'a', description: 'Branch owner' },
  layer: { type: 'string', alias: 'l', description: 'Stack layer' },
  issue: { type: 'string', alias: 'i', description: 'Positive issue number' },
  'dry-run': {
    type: 'boolean',
    alias: 'n',
    description: 'Preview without writing',
  },
  apply: { type: 'boolean', description: 'Apply tracker changes' },
};
const cli = defineCli('Usage: example [options]', definitions);

test('exact aliases, equals forms, and values preserve their meaning', () => {
  for (const args of [
    ['--actor', 'sam', '--layer', '2', '--issue', '7'],
    ['-a', 'sam', '-l', '2', '-i', '7'],
    ['--actor=sam', '--layer=2', '--issue=7'],
    ['-a=sam', '-l=2', '-i=7'],
  ])
    assert.deepEqual(parseCli(args, cli).options, {
      actor: 'sam',
      layer: '2',
      issue: '7',
    });
  assert.deepEqual(parseCli(['-n'], cli).options, { 'dry-run': true });
  assert.deepEqual(parseCli(['-a=--layer=x', '--', '-l', '2', '--help'], cli), {
    options: { actor: '--layer=x' },
    positionals: ['-l', '2', '--help'],
    passthrough: [],
  });
  assert.equal(parseCli(['-a', '-sam'], cli).options.actor, '-sam');
  assert.equal(
    parseCli(['-a', 'space = value'], cli).options.actor,
    'space = value',
  );
  assert.throws(() => parseCli(['-a='], cli), /requires a value/);
});

test('positionals mix with options in any order', () => {
  assert.deepEqual(parseCli(['-a=sam', '-l=2', '--', '285'], cli), {
    options: { actor: 'sam', layer: '2' },
    positionals: ['285'],
    passthrough: [],
  });
  assert.deepEqual(parseCli(['285', '-l', '3', '-'], cli), {
    options: { layer: '3' },
    positionals: ['285', '-'],
    passthrough: [],
  });
  assert.deepEqual(parseCli(['--apply', '-i', '42'], cli).options, {
    apply: true,
    issue: '42',
  });
});

test('known spellings reject duplicates, missing values, grouped flags, and unknowns', () => {
  for (const args of [
    ['-a', 'sam', '--actor=other'],
    ['--layer', '2', '-l=2'],
    ['-n', '--dry-run'],
    ['-i=42', '--issue=43'],
    ['--issue'],
    ['-i'],
    ['-a', '-l', '2'],
    ['-a', '--'],
    ['-a', '--unknown'],
    ['-actor=sam'],
    ['-asam'],
    ['-nl'],
    ['--unknown'],
    ['--dry-run=false'],
    ['-l='],
  ])
    assert.throws(
      () => parseCli(args, cli),
      (error) =>
        error instanceof CliError && /Usage: example/.test(error.message),
      args.join(' '),
    );
  assert.throws(
    () => parseCli(['-a', 'sam', '--actor=other'], cli),
    /--actor is given more than once/,
  );
  assert.throws(
    () => parseCli(['--unknown=1'], cli),
    /Unknown option --unknown/,
  );
  for (const flag of ['-h', '--help'])
    assert.throws(() => parseCli([flag], cli), CliHelp);
});

test('caller definitions reject colliding spellings', () => {
  assert.throws(
    () =>
      defineCli('Usage: collision', {
        actor: { type: 'string', alias: 'a', description: 'Actor' },
        application: { type: 'string', alias: 'a', description: 'App' },
      }),
    /Duplicate CLI spelling -a/,
  );
  assert.throws(
    () =>
      defineCli('Usage: collision', {
        host: { type: 'string', alias: 'h', description: 'Host' },
      }),
    /Duplicate CLI spelling -h/,
  );
  assert.throws(
    () =>
      defineCli('Usage: collision', {
        help: { type: 'boolean', description: 'Other help' },
      }),
    /Duplicate CLI spelling --help/,
  );
});

test('help lists the caller options and the parsing rules', () => {
  assert.equal(
    defineCli('Usage: example [options]', {
      actor: definitions.actor,
      apply: definitions.apply,
    }).help,
    [
      'Usage: example [options]',
      '',
      'Options:',
      '  --help, -h  Show help',
      '  --actor, -a <value>  Branch owner',
      '  --apply  Apply tracker changes',
      '',
      'String options accept OPTION=value or OPTION value. Use = for values beginning with a dash.',
      'Use -- to end wrapper options. Short options are exact; they cannot be grouped.',
    ].join('\n'),
  );
  const bare = defineCli('Usage: bare');
  assert.deepEqual(parseCli(['x'], bare), {
    options: {},
    positionals: ['x'],
    passthrough: [],
  });
  assert.throws(
    () => parseCli(['-h'], bare),
    (error) => {
      assert.ok(error instanceof CliHelp);
      assert.equal(error.message, bare.help);
      return true;
    },
  );
  const error = cliError(cli, 'Use --dry-run or --apply');
  assert.ok(error instanceof CliError);
  assert.equal(error.message, `Use --dry-run or --apply\n\n${cli.help}`);
});

test('passthrough mode forwards unknown tokens and everything from -- in order', () => {
  const wrapper = defineCli(
    'Usage: wrapper [options] [-- tool options]',
    {
      environment: {
        type: 'string',
        alias: 'env',
        description: 'Target environment',
      },
      yes: { type: 'boolean', alias: 'y', description: 'Confirm' },
    },
    { passthrough: true },
  );
  assert.equal(wrapper.passthrough, true);
  assert.equal(cli.passthrough, false);
  assert.deepEqual(
    parseCli(
      [
        '--verbose',
        '-env',
        'dev',
        '--output=some path',
        'app',
        '-y',
        '--require-approval',
        'never',
        '--',
        '-env=prod',
        '-y',
      ],
      wrapper,
    ),
    {
      options: { environment: 'dev', yes: true },
      positionals: [],
      passthrough: [
        '--verbose',
        '--output=some path',
        'app',
        '--require-approval',
        'never',
        '--',
        '-env=prod',
        '-y',
      ],
    },
  );
  for (const args of [
    ['-env', 'dev', '--environment=prod'],
    ['-env'],
    ['-env', '--'],
  ])
    assert.throws(() => parseCli(args, wrapper), CliError, args.join(' '));
  assert.deepEqual(parseCli(['-yenv'], wrapper).passthrough, ['-yenv']);
  assert.throws(() => parseCli(['--verbose', '-h'], wrapper), CliHelp);
});
