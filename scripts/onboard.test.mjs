import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {encodeEventTopics, encodeAbiParameters, parseAbiParameters, parseAbi, decodeFunctionData, encodeFunctionData, erc20Abi, createWalletClient, custom} from 'viem';
import {eventAbi, receiptOrder, assertAttempt, saveVerified, withWalletLock, bufferedGas, persistHash, definiteRejection, removeMatching, actionLockKey, exactUnits, boundedLong, beforeWalletRequest, revertedOrderReceipt, validApprovalIntent, validateFunding} from '../src/onboard-reconcile.js';
import {SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES} from '@somnia-chain/markets-sdk';
import {hidekiTestnet} from '@somnia-chain/markets-sdk/chains';
import {assertNoUnresolved, onboardingJournalKey, stopActionJournalKey, legacyStopJournalKey} from '../src/unresolved-journals.js';

const account='0x1111111111111111111111111111111111111111', pool='0x2222222222222222222222222222222222222222';
const intent={pool,quantity:'100',price:'200'};
function log(name,args,data) { return {address:pool,topics:encodeEventTopics({abi:eventAbi,eventName:name,args}),data}; }
function placed(owner=account) { return log('OrderPlaced',{orderId:3n},encodeAbiParameters(parseAbiParameters('(uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs)'),[{orderId:3n,isBid:true,owner,userData:0n,price:200n,fullQuantity:100n,quantityRemaining:0n,expireTimestampNs:9n}])); }
function filled() { return log('OrderFilled',{takerOrderId:3n,makerOrderId:4n},encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[40n,60n,0n,199n])); }
test('attributes a partial fill to the owner and retains the order id',()=>assert.deepEqual(receiptOrder({logs:[placed(),filled()]},intent,account),{orderId:'3',filled:'40',requested:'100'}));
test('refuses unowned, missing, or resting evidence',()=>{
  assert.equal(receiptOrder({logs:[placed(pool),filled()]},intent,account),null);
  assert.equal(receiptOrder({logs:[placed()]},intent,account),null);
  assert.equal(receiptOrder({logs:[placed(),filled(),log('OrderRested',{orderId:3n},'0x')]},intent,account),null);
});
test('a wallet or network event permanently invalidates the captured attempt',()=>{
  const generation={current:0}; const attempt=generation.current;
  assert.doesNotThrow(()=>assertAttempt(generation,attempt));
  generation.current++; // accountsChanged or chainChanged, even if it changes back later
  assert.throws(()=>assertAttempt(generation,attempt),/changed/);
  generation.current++;
  assert.throws(()=>assertAttempt(generation,attempt),/changed/);
});
test('intent must survive storage readback before sending',()=>{
  assert.throws(()=>saveVerified({setItem(){throw Error('quota');},getItem(){return null;}},'key',{}),/quota/);
  assert.throws(()=>saveVerified({setItem(){},getItem(){return null;}},'key',{}),/recovery/);
  let saved; const storage={setItem(k,v){saved=v;},getItem(){return saved;}};
  assert.equal(saveVerified(storage,'key',{unknown:true}),'{"unknown":true}');
});
test('cross-tab lock fails closed when unsupported or held',async()=>{
  let calls=0;
  await assert.rejects(withWalletLock(undefined,'wallet',()=>calls++),/coordinate/);
  await assert.rejects(withWalletLock({request:async (key,options,cb)=>{assert.equal(options.ifAvailable,true);return cb(null);}},'wallet',()=>calls++),/Another tab/);
  assert.equal(calls,0);
  await withWalletLock({request:async (key,options,cb)=>cb({})},'wallet',()=>calls++);
  assert.equal(calls,1);
});
test('claim gas is buffered and rejects missing estimates or inadequate funds',()=>{
  assert.equal(bufferedGas('0x65','0x2','0x200'),152n);
  assert.throws(()=>bufferedGas('0x0','0x2','0x200'),/estimated/);
  assert.throws(()=>bufferedGas('0x65','0x2','0x12f'),/enough STT/);
  assert.throws(()=>bufferedGas(null,'0x2','0x200'));
});
test('a hash falls back to independent session storage when primary fails',()=>{
  const data=new Map(); const fallback={setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k)};
  const failed={setItem(){throw Error('quota');},getItem(){return null;}};
  const record={hash:'0x123'};
  assert.equal(persistHash(failed,fallback,'wallet',record),'fallback');
  assert.deepEqual(JSON.parse(data.get('wallet:hash-backup')),record);
  assert.throws(()=>persistHash(failed,failed,'wallet',record));
});
test('only a plain 4001 with no broadcast evidence is definitive',()=>{
  assert.equal(definiteRejection({code:4001,message:'Rejected'}),true);
  for (const error of [{code:4001,data:{}},{code:4001,originalError:{}},{code:4001,hash:'0x1'},{code:4001,message:'0x'+'1'.repeat(64)},{code:-1}]) assert.equal(definiteRejection(error),false);
});
test('cleanup refuses a changed saved record',()=>{
  const data=new Map([['wallet',JSON.stringify({hash:'old'})]]);
  const storage={getItem:k=>data.get(k),removeItem:k=>data.delete(k)};
  assert.throws(()=>removeMatching(storage,'wallet',{hash:'new'}),/changed/);
  assert.equal(data.has('wallet'),true); removeMatching(storage,'wallet',{hash:'old'}); assert.equal(data.has('wallet'),false);
});
test('shared action lock is account scoped and normalizes case',()=>assert.equal(actionLockKey(account),'forsee:action:50383:'+account.toLowerCase()));
test('every unresolved journal blocks a fresh wallet action',()=>{
  const data=new Map(); const storage={getItem:k=>data.has(k)?data.get(k):null};
  assert.doesNotThrow(()=>assertNoUnresolved(storage,account));
  for (const key of [onboardingJournalKey(account),stopActionJournalKey(account),legacyStopJournalKey(account)]) {
    data.set(key,'malformed'); assert.throws(()=>assertNoUnresolved(storage,account),/unresolved/); data.delete(key);
  }
});
test('disconnect during async preflight prevents request and clears only its own pre-request intent',async()=>{
  const data=new Map(); const storage={getItem:k=>data.get(k)??null,removeItem:k=>data.delete(k)};
  const record={kind:'order',unknown:true}, ctrl=new AbortController(), generation={current:0};
  data.set('journal',JSON.stringify(record)); await Promise.resolve(); ctrl.abort(); let sent=0;
  assert.throws(()=>{beforeWalletRequest(ctrl.signal,generation,0,storage,'journal',record);sent++;},/disconnected/);
  assert.equal(sent,0);assert.equal(data.has('journal'),false);
  data.set('journal',JSON.stringify({kind:'other'}));
  assert.throws(()=>beforeWalletRequest(ctrl.signal,generation,0,storage,'journal',record),/changed/);
  assert.equal(data.has('journal'),true);
});
test('staged app passes the session signal and checks it immediately before wallet send',async()=>{
  const [component,main]=await Promise.all([readFile(new URL('../src/Onboard.jsx',import.meta.url),'utf8'),readFile(new URL('../src/main.jsx',import.meta.url),'utf8')]);
  assert.match(main,/<Onboard[^>]*sessionSignal=\{session\.current\.signal\}/);
  const guard=component.indexOf('beforeWalletRequest(sessionSignal,generation,attempt,localStorage,key(account),intent)');
  const send=component.indexOf('const hash = await provider.request',guard);
  assert.ok(guard>=0 && send>guard);
  assert.doesNotMatch(component.slice(guard,send),/\bawait\b/);
});
test('only an exact bound reverted IOC order can be archived as failed',()=>{
  const abi=parseAbi(['function placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)']);
  const data=encodeFunctionData({abi,functionName:'placeOrder',args:[true,0n,200n,100n,1n,2,0,'0x0000000000000000000000000000000000000000',0n]});
  const hash='0x'+'12'.repeat(32),blockHash='0x'+'34'.repeat(32);
  const record={kind:'order',pool,price:'200',quantity:'100',data,hash};
  const tx={hash,from:account,to:pool,input:data,blockHash,chainId:'0xc4cf',value:'0x0'};
  const receipt={transactionHash:hash,from:account,to:pool,blockHash,status:'0x0'};
  assert.equal(revertedOrderReceipt(tx,receipt,record,account),true);
  assert.equal(revertedOrderReceipt({...tx,from:pool},receipt,record,account),false);
  assert.equal(revertedOrderReceipt(tx,{...receipt,status:'0x1'},record,account),false);
  assert.equal(revertedOrderReceipt(tx,receipt,{...record,price:'201'},account),false);
  assert.equal(revertedOrderReceipt({...tx,chainId:'0x1'},receipt,record,account),false);
});
test('approval and revoke intents bind exact token, spender, amount, and calldata',()=>{
  const amount=20n*10n**18n;
  for(const [kind,n] of [['approval',amount],['revoke',0n]]) {
    const record={kind,to:pool,spender:account,approvalAmount:String(n),value:'0',data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[account,n]})};
    assert.equal(validApprovalIntent(record,pool,account,n),true);
    assert.equal(validApprovalIntent({...record,to:account},pool,account,n),false);
    assert.equal(validApprovalIntent({...record,spender:pool},pool,account,n),false);
    assert.equal(validApprovalIntent({...record,approvalAmount:'1'},pool,account,n),false);
    assert.equal(validApprovalIntent({...record,data:'0x'},pool,account,n),false);
  }
});
test('funding permits bank-funded and bounded owner pull but rejects linked or changed permissions',()=>{
  const margin={priceable:true,sufficient:true,wallet:{allowance:20n*10n**18n},fundingPayer:null,mainWalletPull:0n,mainFundingBlocked:false};
  assert.doesNotThrow(()=>validateFunding(margin));
  assert.throws(()=>validateFunding({...margin,fundingPayer:account}),/Linked/);
  assert.throws(()=>validateFunding({...margin,sufficient:false}),/Funding/);
  assert.throws(()=>validateFunding({...margin,wallet:{allowance:21n*10n**18n}}),/20 USDso/);
  assert.throws(()=>validateFunding(margin,1n),/changed/);
});
test('unit conversion never rounds and price is bounded to the tick and 1% ask',()=>{
  assert.equal(exactUnits('0.0001',8),10000n); assert.equal(exactUnits('0.01',18),10000000000000000n);
  assert.throws(()=>exactUnits('0.000000001',8)); assert.throws(()=>exactUnits('1e-5',8));
  const args={ask:100000n*10n**18n,tick:10n**18n,quantity:10000n,lot:100n,min:100n,baseDecimals:8,quoteDecimals:18,symbol:'BTC'};
  assert.equal(boundedLong(args),101000n*10n**18n);
  assert.throws(()=>boundedLong({...args,quantity:100000n}),/100 USDso/);
  assert.throws(()=>boundedLong({...args,quantity:10001n}),/lot size/);
  assert.throws(()=>boundedLong({...args,ask:0n}),/unavailable/);
  assert.throws(()=>boundedLong({...args,tick:200000n*10n**18n}),/acceptable price/);
  assert.equal(boundedLong({...args,symbol:'ETH',baseDecimals:18,quantity:10n**16n,ask:3000n*10n**18n}),3030n*10n**18n);
});
test('receipt rejects price outside limit and inconsistent fill remainder',()=>{
  const badPrice=log('OrderFilled',{takerOrderId:3n,makerOrderId:4n},encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[40n,60n,0n,201n]));
  const badRemaining=log('OrderFilled',{takerOrderId:3n,makerOrderId:4n},encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'),[40n,0n,0n,199n]));
  assert.equal(receiptOrder({logs:[placed(),badPrice]},intent,account),null);
  assert.equal(receiptOrder({logs:[placed(),badRemaining]},intent,account),null);
});
test('pinned SDK builders produce unsigned calls without sending',async()=>{
  const walletClient=createWalletClient({account,chain:hidekiTestnet,transport:custom({request(){throw Error('Unexpected wallet request');}})});
  const markets=new SomniaMarkets({chain:hidekiTestnet,addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES,walletClient});
  try {
    const order=await markets.trader.buildPlacePerpOrder({pool,isBid:true,price:200n,quantity:100n,orderType:2});
    assert.equal(order.order.to.toLowerCase(),pool); assert.match(order.order.data,/^0x[0-9a-f]+$/); assert.equal(order.order.value,0n); assert.equal(order.order.chainId,50383);
    const decoded=decodeFunctionData({abi:parseAbi(['function placeOrder(bool isBid,uint64 userData,uint256 price,uint256 quantity,uint64 expireTimestampNs,uint8 orderType,uint8 selfMatchingOption,address builder,uint96 builderFeeBpsTimes1k)']),data:order.order.data});
    assert.equal(decoded.functionName,'placeOrder'); assert.equal(decoded.args[0],true); assert.equal(decoded.args[2],200n); assert.equal(decoded.args[3],100n); assert.equal(decoded.args[5],2); assert.equal(decoded.args[6],0); assert.equal(decoded.args[7],'0x0000000000000000000000000000000000000000'); assert.equal(decoded.args[8],0n);
    const claim=await markets.trader.buildClaimPerpVoucher({marginBank:pool,distributor:account});
    assert.equal(claim.to.toLowerCase(),account); assert.match(claim.data,/^0x[0-9a-f]+$/); assert.equal(claim.value,0n); assert.equal(claim.chainId,50383);
  } finally { await markets.close(); }
});

