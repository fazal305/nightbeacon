import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCandidate, scoreCandidate, renderCandidates, parseCandidateUsernames, mentionedUsernames } from './discoverSources.js';
import { messagesToStore } from '../ingestion/pollSource.js';

test('discovery: signals from several sources add up; the review file round-trips', () => {
  const c = new Map();
  addCandidate(c, { username: 'GazaNow', title: 'Gaza Now', id: 1, accessHash: 2, subscribers: 250000 }, { recommendedBy: 'a' });
  addCandidate(c, { username: 'gazanow' }, { recommendedBy: 'b' });
  addCandidate(c, { username: 'gazanow' }, { mentionedBy: 's1' });
  addCandidate(c, { username: 'quiet_one', title: 'Quiet' }, { mentionedBy: 's1' });
  const gaza = c.get('gazanow');
  assert.equal(gaza.recommendedBy.size, 2);
  assert.equal(gaza.id, '1', 'id kept when a later sighting has none');
  assert.ok(scoreCandidate(gaza) > scoreCandidate(c.get('quiet_one')));

  const list = [...c.values()].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const text = renderCandidates(list);
  assert.match(text, /@GazaNow \| Gaza Now \| 250\.0k subscribers · similar to 2 source\(s\), mentioned by 1 source\(s\)/);
  assert.deepEqual(parseCandidateUsernames(text), ['GazaNow', 'quiet_one']);
  assert.deepEqual(parseCandidateUsernames('# comment\n@keep_me | x\n  @also_ok\nnot a line\n@ab'), ['keep_me', 'also_ok']);
});

test('discovery: mentions skip links that are not channels', () => {
  const names = mentionedUsernames('via @Some_News and t.me/OtherChannel — join t.me/addlist/abc, t.me/c/123/4, @helper_bot, t.me/+inviteXYZ');
  assert.deepEqual([...names].sort(), ['OtherChannel', 'Some_News']);
});

test('first poll of a new source keeps only the last hour; later polls keep everything', () => {
  const now = 1_800_000_000_000;
  const msgs = [{ id: 1, date: now / 1000 - 30 * 60 }, { id: 2, date: now / 1000 - 5 * 3600 }];
  assert.deepEqual(messagesToStore(msgs, 0, now).map((m) => m.id), [1]);
  assert.equal(messagesToStore(msgs, 10, now).length, 2);
});
