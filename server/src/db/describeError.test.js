import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, connectionHint } from './describeError.js';

test('AggregateError with an empty message (Windows localhost -> ::1 + 127.0.0.1) is spelled out', () => {
  const mk = (address) => Object.assign(new Error(`connect ECONNREFUSED ${address}:5432`), { code: 'ECONNREFUSED' });
  const err = Object.assign(new AggregateError([mk('::1'), mk('127.0.0.1')]), { code: 'ECONNREFUSED' });
  assert.equal(err.message, '');
  assert.equal(describeError(err), 'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
  assert.match(connectionHint(err), /PostgreSQL running/);
});

test('ordinary errors keep their message', () => {
  assert.equal(describeError(new Error('password authentication failed for user "x"')), 'password authentication failed for user "x"');
  assert.equal(connectionHint(new Error('nope')), null);
});
