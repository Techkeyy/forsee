import test from 'node:test';
import assert from 'node:assert/strict';
import {gridDefault,preferredAmount} from '../src/order-grid.js';

test('current example BTC and ETH grids produce minimum-aligned defaults',()=>{
  assert.deepEqual(gridDefault('BTC',8,13000n,1000n),{min:'0.00013',lot:'0.00001',suggested:'0.00013'});
  assert.deepEqual(gridDefault('ETH',18,4000000000000000n,100000000000000n),{min:'0.004',lot:'0.0001',suggested:'0.004'});
});
test('unaligned minimum rounds up and malformed or unsupported grids fail closed',()=>{
  assert.equal(gridDefault('BTC',8,13001n,1000n).suggested,'0.00014');
  assert.equal(gridDefault('BTC',8,100001n,1000n).suggested,null);
  assert.throws(()=>gridDefault('BTC',8,13000n,0n));
  assert.throws(()=>gridDefault('BTC',8,0n,1000n));
  assert.throws(()=>gridDefault('SOL',9,1000n,100n));
});
test('switching markets preserves explicit edits, including an empty value',()=>{
  const edits={BTC:'0.0002',ETH:''};
  assert.equal(preferredAmount('BTC','0.00013',edits),'0.0002');
  assert.equal(preferredAmount('ETH','0.004',edits),'');
  assert.equal(preferredAmount('BTC','0.00013',{}),'0.00013');
});

