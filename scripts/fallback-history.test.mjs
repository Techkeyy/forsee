import assert from 'node:assert/strict';
import {sendTracked} from '../src/tracked-send.js';
import {saveStopHistory,readStopHistory} from '../src/stop-history.js';
const account='0x'+'12'.repeat(20),hash='0x'+'ab'.repeat(32),call={to:account,data:'0xab',value:1n},record={account,hash:null};
let primary, backup;const save=(_s,v)=>{if(v.hash)throw Error('quota');primary=v;},saveBackup=async(_a,h)=>{backup=h;return true;};
let result=await sendTracked({provider:{request:async()=>hash},account,call,record,storage:{},save,clear:()=>{},classify:()=> 'unknown',backup:saveBackup});assert.equal(result.hash,hash);assert.equal(result.backedUp,true);assert.equal(primary.hash,null);assert.equal(backup,hash);
result=await sendTracked({provider:{request:async()=>{throw {cause:{hash}};}},account,call,record,storage:{},save,clear:()=>{},classify:()=> 'unknown',backup:saveBackup});assert.equal(result.hash,hash);assert.equal(backup,hash);
const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};const stop={account,hash,market:'BTC',pool:account,registry:account};saveStopHistory(storage,stop,'7');saveStopHistory(storage,stop,'7');assert.equal(readStopHistory(storage,account).length,1);assert.equal(readStopHistory(storage,account)[0].id,'7');
console.log('fallback hash and stop history checks passed');
