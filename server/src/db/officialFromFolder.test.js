import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessOrganisation, parseOrganisations, mergeIntoFile } from './officialFromFolder.js';
import { parseTerminology } from '../publishing/config.js';

const ORGS = parseOrganisations(`
# comment
Coast Guard Northern Command => coast guard north, خفر السواحل الشمالي
Coast Guard => coast guard, خفر السواحل
Ministry of Health => ministry of health, وزارة الصحة
`);

test('official folder: organisation guessed from the channel title, most specific first', () => {
  assert.equal(ORGS.length, 3);
  assert.equal(guessOrganisation('خفر السواحل الشمالي', ORGS), 'Coast Guard Northern Command');
  assert.equal(guessOrganisation('خفر السواحل | official', ORGS), 'Coast Guard');
  assert.equal(guessOrganisation('Ministry of Health updates', ORGS), 'Ministry of Health');
  assert.equal(guessOrganisation('Some other channel', ORGS), null);
  assert.equal(guessOrganisation('Ministry of Health', []), null, 'no organisations file');
});

test('official folder: re-running replaces only its own block; hand-written lines are kept', () => {
  const header = '# comments\n@manual_one => Ministry A\n';
  const first = mergeIntoFile(header, 'abc', ['@a => Agency B', '@b => Agency C']);
  const second = mergeIntoFile(first + '@manual_two => Ministry D\n', 'abc', ['@a => Agency B']);
  assert.deepEqual(
    parseTerminology(second).map((r) => r.term),
    ['@manual_one', '@a', '@manual_two']
  );
  assert.equal((second.match(/channels from Telegram folder/g) || []).length, 1);
});
