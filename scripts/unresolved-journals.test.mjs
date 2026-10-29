import assert from 'node:assert/strict';
import {assertNoUnresolved,onboardingJournalKey,stopActionJournalKey,legacyStopJournalKey} from '../src/unresolved-journals.js';
import {actionKey} from '../src/action-journal.js';
import {walletLockKey,withAccountLock} from '../src/wallet-lock.js';
const a='0x'+'ab'.repeat(20), b='0x'+'cd'.repeat(20),map=new Map(),storage={getItem:k=>map.has(k)?map.get(k):null};
assert.equal(stopActionJournalKey(a),actionKey(a));assert.equal(walletLockKey(a),actionKey(a));assert.doesNotThrow(()=>assertNoUnresolved(storage,a));
for(const key of [onboardingJournalKey(a),stopActionJournalKey(a),legacyStopJournalKey(a)]){
  for(const value of ['{"unknown":true}','{"hash":null}','{broken','null','']){
    map.set(key,value);assert.throws(()=>assertNoUnresolved(storage,a),/unresolved/);assert.doesNotThrow(()=>assertNoUnresolved(storage,b));map.delete(key);
  }
}
assert.throws(()=>assertNoUnresolved({getItem(){throw Error('storage unavailable');}},a),/storage unavailable/);
// A reloaded module sees the same persisted unresolved request; checks do not clear it.
map.set(onboardingJournalKey(a),'{"unknown":true}');const reloaded=await import('../src/unresolved-journals.js?reload');assert.throws(()=>reloaded.assertNoUnresolved(storage,a),/unresolved/);assert.ok(map.has(onboardingJournalKey(a)));
// Claim and stop compete on one account lock even across differently cased addresses.
let holder,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>holder=r),held=new Set();const locks={request:async(name,_o,fn)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};
const claim=withAccountLock(locks,a,async()=>{entered();await gate;});await ready;await assert.rejects(()=>withAccountLock(locks,a.toUpperCase().replace('0X','0x'),()=>{}),/Another tab/);holder();await claim;
console.log('cross-feature unresolved journal and lock checks passed');
