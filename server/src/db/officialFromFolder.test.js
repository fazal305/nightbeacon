import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessOrganisation, mergeIntoFile } from './officialFromFolder.js';
import { parseTerminology } from '../publishing/config.js';

test('official folder: organisation guessed from the channel title, most specific first', () => {
  assert.equal(guessOrganisation('الإعلام الحربي - المقاومة الإسلامية'), 'Hezbollah');
  assert.equal(guessOrganisation('كتائب حزب الله'), "Kata'ib Hezbollah");
  assert.equal(guessOrganisation('كتائب القسام'), 'Al-Qassam Brigades');
  assert.equal(guessOrganisation('Saraya Al-Quds official'), 'Saraya al-Quds');
  assert.equal(guessOrganisation('Yemeni Armed Forces'), 'Yemeni Armed Forces');
  assert.equal(guessOrganisation('Some other channel'), null);
});

test('official folder: re-running replaces only its own block; hand-written lines are kept', () => {
  const header = '# comments\n@manual_one => Hamas\n';
  const first = mergeIntoFile(header, 'abc', ['@a => Hezbollah', '@b => IRGC']);
  const second = mergeIntoFile(first + '@manual_two => PFLP\n', 'abc', ['@a => Hezbollah']);
  assert.deepEqual(
    parseTerminology(second).map((r) => r.term),
    ['@manual_one', '@a', '@manual_two']
  );
  assert.equal((second.match(/channels from Telegram folder/g) || []).length, 1);
});
