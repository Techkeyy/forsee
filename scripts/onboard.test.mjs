import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeEventTopics, encodeAbiParameters, parseAbiParameters, createWalletClient, custom} from 'viem';
import {eventAbi, receiptOrder, assertAttempt, saveVerified, withWalletLock, bufferedGas, persistHash, definiteRejection, removeMatching} from '../src/onboard-reconcile.js';
import {SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES} from '@somnia-chain/markets-sdk';
import {hidekiTestnet} from '@somnia-chain/markets-sdk/chains';

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
test('pinned SDK builders produce unsigned calls without sending',async()=>{
  const walletClient=createWalletClient({account,chain:hidekiTestnet,transport:custom({request(){throw Error('Unexpected wallet request');}})});
  const markets=new SomniaMarkets({chain:hidekiTestnet,addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES,walletClient});
  try {
    const order=await markets.trader.buildPlacePerpOrder({pool,isBid:true,price:200n,quantity:100n,orderType:2});
    assert.equal(order.order.to.toLowerCase(),pool); assert.match(order.order.data,/^0x[0-9a-f]+$/); assert.equal(order.order.value,0n); assert.equal(order.order.chainId,50383);
    const claim=await markets.trader.buildClaimPerpVoucher({marginBank:pool,distributor:account});
    assert.equal(claim.to.toLowerCase(),account); assert.match(claim.data,/^0x[0-9a-f]+$/); assert.equal(claim.value,0n); assert.equal(claim.chainId,50383);
  } finally { await markets.close(); }
});

