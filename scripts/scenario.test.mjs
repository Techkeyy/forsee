import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shockPnl, scenarioBuffer, signedDecimal, createGeneration, guardedRequest, completePools, compatibleMarket, isFresh } from '../src/account.js';
const rows = [
  { size: 100000000n, markPrice: 100000000000000000000n, market: { baseDecimals: 8, baseSymbol: 'BTC', quoteDecimals: 18, quoteSymbol: 'USDso' } },
  { size: -2000000000000000000n, markPrice: 50000000000000000000n, market: { baseDecimals: 18, baseSymbol: 'ETH', quoteDecimals: 18, quoteSymbol: 'USDso' } },
];
test('independent BTC and ETH moves preserve position signs and units', () => {
  assert.equal(shockPnl(rows, -10, 10), -20000000000000000000n);
  assert.equal(shockPnl(rows, 0, 0), 0n);
  assert.equal(shockPnl(rows, -101, 0), null);
});

test('buffer crosses zero only in the illustrative arithmetic', () => {
  const pnl = shockPnl(rows, -10, 10);
  assert.deepEqual(scenarioBuffer(30000000000000000000n, 10000000000000000000n, pnl), { current: 20000000000000000000n, illustrative: 0n });
  assert.equal(scenarioBuffer(29000000000000000000n, 10000000000000000000n, pnl).illustrative, -1000000000000000000n);
  assert.equal(scenarioBuffer(31000000000000000000n, 10000000000000000000n, pnl).illustrative, 1000000000000000000n);
  assert.equal(signedDecimal(pnl, 18), '-20');
  assert.equal(signedDecimal(1000000000000000000n, 18), '+1');
});

test('wallet response is discarded after disconnect or account change', async () => {
  const generation = createGeneration(); const token = generation.invalidate();
  let resolve; const wallet = { request: () => new Promise(r => { resolve = r; }) };
  const pending = guardedRequest(wallet, generation, token, { method: 'eth_accounts' });
  generation.invalidate(); resolve(['0x1']);
  await assert.rejects(pending, /superseded/);
});
test('active pool sets must match uniquely and quote units must agree', () => {
  const market = { baseDecimals: 8, quoteDecimals: 18, quoteSymbol: 'USDso' };
  const row = pool => ({ pool, market, priceable:true, size:1n, asOfBlock:10n });
  assert.equal(completePools([], [], 10n), true);
  assert.equal(completePools(['0xA','0xB'], [row('0xa'),row('0xb')],10n), true);
  assert.equal(completePools(['0xA','0xB'], [row('0xa'),row('0xa')],10n), false);
  assert.equal(completePools(['0xA','0xB'], [row('0xa')],10n), false);
  assert.equal(compatibleMarket({...market,quoteDecimals:6}),false);
  assert.equal(shockPnl([{...rows[0],market:{...rows[0].market,quoteDecimals:6}}],1,0),null);
});

test('freshness ages from the source block and monotonic read start', () => {
  const snapshot = { sourceAgeMs: 5000, startedAt: 1000 };
  assert.equal(isFresh(snapshot, 1000), true);
  assert.equal(isFresh(snapshot, 26000), true);
  assert.equal(isFresh(snapshot, 26001), false);
  assert.equal(isFresh(snapshot, 999), false);
});
