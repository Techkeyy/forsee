import { test } from 'node:test';
import assert from 'node:assert/strict';
import {attemptKey,validateAttempt,saveAttempt,loadAttempt,updateAttempt,classifyWalletError,receiptStopId,createWalletGuard,shouldShowRecovery,assessKnownStop,settleSources} from '../src/stop-attempt.js';
const account='0x1111111111111111111111111111111111111111', pool='0x2222222222222222222222222222222222222222', registry='0x3333333333333333333333333333333333333333', hash='0x'+'a'.repeat(64);
const initial={network:'hideki2:50383:50000259',phase:'approval_requested',account,pool,registry,market:'BTC',side:'long',trigger:'100',createdAt:1,preExistingIds:['1'],approvalHash:null,stopHash:null,id:null};
const store=()=>{const map=new Map();return {setItem:(k,v)=>map.set(k,v),getItem:k=>map.get(k)??null};};
test('approval-only and stop phases persist across reload and are scoped to account',()=>{
  const s=store();saveAttempt(s,initial);assert.deepEqual(loadAttempt(s,account),initial);
  const approved=updateAttempt(initial,{type:'approval_known',hash});saveAttempt(s,approved);assert.equal(loadAttempt(s,account).phase,'approval_known');
  const requested=updateAttempt(approved,{type:'stop_requested'});assert.equal(requested.stopHash,null);
  const submitted=updateAttempt(requested,{type:'hash_known',hash});assert.equal(submitted.phase,'hash_known');
  const found=updateAttempt(submitted,{type:'id_known',hash,id:'2'});assert.equal(found.id,'2');
  assert.equal(updateAttempt(found,{type:'pending_verified',hash,id:'2'}).phase,'pending_verified');
  assert.notEqual(attemptKey(account),attemptKey(registry));assert.equal(loadAttempt(s,registry),null);
  assert.equal(validateAttempt({...initial,account:registry},account),false);
});
test('only explicit rejection without a known hash is rejection; missing hash remains unknown',()=>{
  assert.equal(classifyWalletError({code:4001}),'rejected');assert.equal(classifyWalletError({cause:{code:4001}}),'rejected');
  assert.equal(classifyWalletError({hash,cause:{code:4001}}),'unknown');assert.equal(classifyWalletError(new Error('timeout')),'unknown');assert.equal(classifyWalletError({name:'TransactionOutcomeUnknownError',cause:{code:4001}}),'unknown');

});


test('a stop receipt must bind sender, target, network and exact event terms',()=>{
  const record={...initial,phase:'hash_known',stopHash:hash};
  const tx={from:account,to:registry,chainId:50383,hash};
  const receipt={transactionHash:hash,status:'success'};
  const event={registry,owner:account,isBid:false,quantity:0n,triggerPrice:100n,triggerOperator:1,orderType:1,builder:'0x0000000000000000000000000000000000000000',builderFeeBpsTimes1k:0n,orderId:3n};
  const call={functionName:'createPendingOrder',args:[{order:{owner:account,isBid:false,userData:0n,quantity:0n},orderType:1,triggerPrice:100n,triggerOperator:1,limitPrice:0n,builder:'0x0000000000000000000000000000000000000000',builderFeeBpsTimes1k:0n}]};
  assert.equal(receiptStopId(record,tx,receipt,[event],call),'3');
  assert.equal(receiptStopId(record,{...tx,from:pool},receipt,[event],call),null);
  assert.equal(receiptStopId(record,{...tx,chainId:50312},receipt,[event],call),null);
  assert.equal(receiptStopId(record,tx,receipt,[{...event,triggerPrice:101n}],call),null);
  assert.equal(receiptStopId(record,tx,receipt,[event,event],call),null);
  assert.equal(receiptStopId(record,tx,receipt,[event],null),null);
  assert.equal(receiptStopId(record,tx,receipt,[event],{...call,functionName:'createTriggerOrder'}),null);
  assert.equal(receiptStopId(record,tx,receipt,[event],{...call,args:[{...call.args[0],triggerPrice:101n}]}),null);
});


test('wallet account or network events invalidate pending signing work',()=>{
  const callbacks=new Map(); const provider={on:(name,cb)=>callbacks.set(name,cb),removeListener:name=>callbacks.delete(name)};
  const guard=createWalletGuard(provider); guard.check(); callbacks.get('accountsChanged')(); assert.throws(()=>guard.check(),/changed/); guard.close();
  const another=createWalletGuard(provider); callbacks.get('chainChanged')(); assert.throws(()=>another.check(),/changed/); another.close();
  assert.throws(()=>createWalletGuard({}),/unavailable/);
});

test('recovery visibility depends on verified wallet, not snapshot success or age',()=>{
  for(const snapshot of [null,{complete:false},{stale:true}]) assert.equal(shouldShowRecovery(account,true,snapshot),true);
  assert.equal(shouldShowRecovery(account,false),false);assert.equal(shouldShowRecovery('',true),false);
});

test('known stop must match saved terms, verified market and receipt binding',()=>{
  const r={...initial,phase:'id_known',id:'3',stopHash:hash};
  const context={registryVerified:true,pool,registry};
  const stop={owner:account,isBid:false,quantity:0n,triggerPrice:100n,triggerOperator:1,orderType:1,intent:'reduceOnly',builder:'0x0000000000000000000000000000000000000000',builderFeeBpsTimes1k:0n};
  assert.equal(assessKnownStop(r,stop,context,'3'),'matching pending');
  for(const mutation of [{owner:pool},{isBid:true},{quantity:1n},{triggerPrice:101n},{triggerOperator:0},{orderType:0},{intent:null},{builder:pool},{builderFeeBpsTimes1k:1n}]) assert.equal(assessKnownStop(r,{...stop,...mutation},context,'3'),'unknown');
  assert.equal(assessKnownStop(r,stop,{...context,registry:pool},'3'),'unknown');
  assert.equal(assessKnownStop(r,stop,{...context,registryVerified:false},'3'),'unknown');
  assert.equal(assessKnownStop(r,stop,context,null),'unknown');
  assert.equal(assessKnownStop(r,stop,context,'4'),'unknown');
});
test('indexer failure does not discard independent registry or receipt evidence',async()=>{
  const result=await settleSources({indexer:()=>Promise.reject(new Error('down')),registry:()=>Promise.resolve({owner:account}),receipt:()=>Promise.resolve({status:'success'})});
  assert.equal(result.indexer.status,'unavailable');assert.equal(result.registry.value.owner,account);assert.equal(result.receipt.value.status,'success');
});

