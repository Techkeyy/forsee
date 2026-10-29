import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteSecondsRemaining} from '../src/quote-expiry.js';

test('review window counts down and expires exactly at two minutes', () => {
  const quote = {created: 1000};
  assert.equal(quoteSecondsRemaining(quote, 1000), 120);
  assert.equal(quoteSecondsRemaining(quote, 120999), 1);
  assert.equal(quoteSecondsRemaining(quote, 121000), 0);
  assert.equal(quoteSecondsRemaining(quote, 150000), 0);
});
test('invalid timestamps and backwards clocks fail closed', () => {
  assert.equal(quoteSecondsRemaining(null, 1000), 0);
  assert.equal(quoteSecondsRemaining({created: NaN}, 1000), 0);
  assert.equal(quoteSecondsRemaining({created: 1000}, 999), 0);
});
