import assert from 'node:assert/strict';
import test from 'node:test';
import { closingIssues } from '../src/closing-issues.mjs';

const REPOSITORY = 'acme-labs/widgets';

test('only closing keyword references supply status targets', () => {
  assert.deepEqual(
    closingIssues(
      `Closes #40. Follow-up to #12, blocked by #30.\nFIXES ${REPOSITORY}#41; resolves https://github.com/${REPOSITORY}/issues/42\nCloses other/repo#9\nParent issue or epic: Closes #8\n<!-- Closes #7 -->\n\`Fixes #6\`\n\`\`\`\nCloses #5\n\`\`\`\n    Closes #4`,
      REPOSITORY,
    ),
    [40, 41, 42],
  );
  assert.deepEqual(closingIssues(null, REPOSITORY), []);
  assert.deepEqual(
    closingIssues(
      'Closes #1, fixes #2, resolved #3; close #4; fix #5; resolve #6',
      REPOSITORY,
    ),
    [1, 2, 3, 4, 5, 6],
  );
});
