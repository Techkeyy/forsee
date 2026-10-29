import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, PLACE_ORDER_FOR_SELECTOR } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, createWalletClient, custom, http, parseAbi, parseAbiItem, encodeFunctionData, decodeEventLog, decodeFunctionData } from 'viem';
import { readAccount, isFresh } from './account.js';
import { reviewStopTerms, matchesDiscoveredMarket } from './stop.js';
import { createWalletGuard, classifyWalletError, receiptStopId } from './stop-attempt.js';
import { readAction, saveAction, clearAction, matchesTransaction } from './action-journal.js';
import {sendTracked} from './tracked-send.js';
import {withAccountLock} from './wallet-lock.js';
import {assertNoUnresolved} from './unresolved-journals.js';
import {backupHash,readBackupHash,clearBackupHash} from './hash-backup.js';
import {saveStopHistory,hasLiveSavedStop} from './stop-history.js';
const genesis='0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25';
const indexerUrl='https://hideki-dev.smk.somnia.host/v1/graphql';
const globalAbi=parseAbi(['function setOperatorApprovalGlobal(address operator, bytes4[] selectors, bool approved)','function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)']);
const authAbi=parseAbi(['function isOperatorAuthorized(address owner,address operator,bytes4 selector) view returns (bool)']);
const stopAbi=parseAbi(['function createPendingOrder(((bool isBid,address owner,uint64 userData,uint256 quantity) order,uint8 orderType,uint256 triggerPrice,uint8 triggerOperator,uint256 limitPrice,address builder,uint96 builderFeeBpsTimes1k) orderWithTrigger) payable returns (uint128 pendingOrderId)']);
const cancelled=parseAbiItem('event PendingOrderCancelled(uint128 indexed orderId)');
const created=parseAbiItem('event PendingOrderCreated(uint128 indexed orderId, address indexed owner, bool isBid, uint256 quantity, uint256 triggerPrice, uint8 triggerOperator, uint8 orderType, address builder, uint96 builderFeeBpsTimes1k)');
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const client=()=>createPublicClient({chain:hidekiTestnet,transport:http()});
function exchange(provider,account){const ex=new SomniaMarkets({chain:hidekiTestnet,indexerUrl,addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES});ex.setSigner({walletClient:createWalletClient({account,chain:hidekiTestnet,transport:custom(provider)}),account});return ex;}
async function wallet(provider,account){const accounts=await provider.request({method:'eth_accounts'}),chain=await provider.request({method:'eth_chainId'}),net=await provider.request({method:'net_version'}),block=await provider.request({method:'eth_getBlockByNumber',params:['0x0',false]});if(!eq(accounts[0],account)||chain!=='0xc4cf'||net!=='50000259'||!eq(block?.hash,genesis))throw new Error('Wallet account or network changed');}
async function locked(account,fn){return withAccountLock(navigator.locks,account,fn);}
async function market(ex,row){const markets=await ex.client.listPerpMarkets();if(!matchesDiscoveredMarket(row,markets))throw new Error('Market registry could not be verified');return markets.find(m=>eq(m.poolAddress,row.pool));}
async function noPending(ex,account,pool,registry){if(await hasLiveSavedStop(localStorage,account,pool,registry,id=>ex.client.getPerpStopOrder({registry,orderId:id})))throw new Error('A previously registered stop is still pending. Cancel it before arming another.');const orders=await ex.client.listPerpStopOrders({account,pool,status:['PENDING'],limit:100});if(orders.length>=100 || orders.some(o=>eq(o.registry,registry)))throw new Error('A pending stop may already exist for this market. Check and cancel it before arming another. The list can be delayed.');}
async function position(ex,account,row,input){const snapshot=await readAccount(account);if(!isFresh(snapshot,performance.now())||!snapshot.complete||snapshot.gap>100n)throw new Error('Account snapshot is unavailable or stale');const fresh=snapshot.rows.find(r=>eq(r.pool,row.pool));if(!fresh||(fresh.size>0n)!==(row.size>0n))throw new Error('Position changed');await market(ex,fresh);const terms=reviewStopTerms(fresh,input);if(!terms)throw new Error('Trigger or position changed');return {fresh,terms};}
async function authorized(publicClient,account,pool,registry){return publicClient.readContract({address:pool,abi:authAbi,functionName:'isOperatorAuthorized',args:[account,registry,PLACE_ORDER_FOR_SELECTOR]});}
async function send(provider,account,ex,publicClient,watch,r,call,revalidate,signal){
  if(call.chainId!==50383||!eq(call.to,r.to)||!eq(call.data,r.data)||String(call.value)!==r.value)throw new Error('Unexpected transaction');
  const gas=await publicClient.estimateGas({account,to:call.to,data:call.data,value:call.value});const price=await publicClient.getGasPrice();if(await publicClient.getBalance({address:account})<call.value+gas*price*2n)throw new Error('Insufficient balance for estimated transaction costs');
  await revalidate();await wallet(provider,account);watch.check();
  const sent=await sendTracked({provider,account,call,record:r,storage:localStorage,save:saveAction,clear:clearAction,classify:classifyWalletError,beforeRequest:()=>{watch.check();if(signal?.aborted)throw new Error('Session disconnected before wallet request');},backup:backupHash});
  if(sent.state!=='hash')return sent;
  const hash=sent.hash;r={...r,hash};
  try{await publicClient.waitForTransactionReceipt({hash,timeout:60000});}catch{return {state:'unknown',hash};}
  return reconcileActionInternal(provider,account,r,ex,publicClient,watch);
}
export async function performAction({provider,account,kind,row,input,id,signal}){return locked(account,async()=>{
  assertNoUnresolved(localStorage,account);
  const ex=exchange(provider,account),pub=client(),watch=createWalletGuard(provider);
  try{await wallet(provider,account);if((await pub.getCode({address:account}))?.replace(/^0x/,'') )throw new Error('Only externally owned wallets are supported');const m=await market(ex,row);const registry=m.stopRegistry;let call,terms=null;
    const binding=kind==='cancel'?null:await ex.client.getOperatorPermissionsRegistry(row.pool);if(kind!=='cancel'&&!binding)throw new Error('Permission registry unavailable');
    if(kind==='approval'||kind==='stop'){
      const current=await position(ex,account,row,input);terms=current.terms;const auth=await authorized(pub,account,row.pool,registry);
      if(kind==='approval'&&auth)throw new Error('Registry already authorized; refresh');if(kind==='stop'&&!auth)throw new Error('Registry permission is not confirmed');if(kind==='stop')await noPending(ex,account,row.pool,registry);
      const payment=await ex.client.getPerpStopOrderSomiPayment(registry);
      const built=await ex.trader.buildPlacePerpStopOrder({...terms,operatorRegistry:binding,somiPayment:payment,skipOperatorApproval:kind==='stop'});call=kind==='approval'?built.operatorApproval:built.stopOrder;
      if(!call)throw new Error('Transaction unavailable');
      if(kind==='approval'&&!eq(call.to,binding))throw new Error('Permission registry changed');
    }else if(kind==='cancel'){
      if(typeof id!=='string'||!/^(0|[1-9][0-9]*)$/.test(id)||BigInt(id)>=(1n<<128n))throw new Error('Invalid stop ID');
      const order=await ex.client.getPerpStopOrder({registry,orderId:id});if(!order||!eq(order.owner,account))throw new Error('Pending stop ownership could not be verified');
      call=ex.trader.buildCancelPerpStopOrder({registry,orderId:id});
    }else if(kind==='revoke'){
      const global=await pub.readContract({address:binding,abi:globalAbi,functionName:'isGloballyApproved',args:[account,registry,PLACE_ORDER_FOR_SELECTOR]});if(!global)throw new Error('Global permission is not present');
      call={chainId:50383,to:binding,data:encodeFunctionData({abi:globalAbi,functionName:'setOperatorApprovalGlobal',args:[registry,[PLACE_ORDER_FOR_SELECTOR],false]}),value:0n};
    }else throw new Error('Unsupported action');
    await wallet(provider,account);watch.check();
    const r={kind,account,pool:row.pool,registry,market:m.baseSymbol,to:call.to,data:call.data,value:String(call.value),hash:null,id:kind==='cancel'?id:null,side:terms?(row.size>0n?'long':'short'):null,trigger:terms?String(terms.triggerPrice):null};
    const revalidate=async()=>{
      if((await pub.getCode({address:account}))?.replace(/^0x/,'') )throw new Error('Only externally owned wallets are supported');
      const again=await market(ex,row);if(!eq(again.stopRegistry,registry)||(kind!=='cancel'&&!eq(await ex.client.getOperatorPermissionsRegistry(row.pool),binding)))throw new Error('Market or permission registry changed');
      if(kind==='approval'||kind==='stop'){const fresh=await position(ex,account,row,input);const auth=await authorized(pub,account,row.pool,registry);if((kind==='approval'&&auth)||(kind==='stop'&&!auth))throw new Error('Permission changed');if(kind==='stop')await noPending(ex,account,row.pool,registry);const payment=await ex.client.getPerpStopOrderSomiPayment(registry);const built=await ex.trader.buildPlacePerpStopOrder({...fresh.terms,operatorRegistry:binding,somiPayment:payment,skipOperatorApproval:kind==='stop'});const candidate=kind==='approval'?built.operatorApproval:built.stopOrder;if(!candidate||!eq(candidate.to,call.to)||!eq(candidate.data,call.data)||candidate.value!==call.value)throw new Error('Stop terms or prepaid amount changed');}
      if(kind==='cancel'){const order=await ex.client.getPerpStopOrder({registry,orderId:id});if(!order||!eq(order.owner,account))throw new Error('Stop is no longer confirmed pending');}
      if(kind==='revoke'&&!(await pub.readContract({address:binding,abi:globalAbi,functionName:'isGloballyApproved',args:[account,registry,PLACE_ORDER_FOR_SELECTOR]})))throw new Error('Permission changed');
    };
    return await send(provider,account,ex,pub,watch,r,call,revalidate,signal);
  }finally{watch.close();ex.setSigner({});await ex.close();}
});}
export async function reconcileAction(provider,account,suppliedHash){return locked(account,async()=>{const r=readAction(localStorage,account);if(!r)return {state:'none'};const backup=!r.hash ? await readBackupHash(account) : null;if(suppliedHash && backup && !eq(suppliedHash,backup))throw new Error('Hash differs from the recovered hash');const candidate=suppliedHash||backup;if(candidate){if(!/^0x[0-9a-fA-F]{64}$/.test(candidate))throw new Error('Invalid transaction hash');if(r.hash && !eq(r.hash,candidate))throw new Error('Hash does not match saved action');r.hash=candidate;try{saveAction(localStorage,r);}catch{await backupHash(account,candidate);}}return reconcileActionInternal(provider,account,r);});}
async function reconcileActionInternal(provider,account,record,providedEx,providedClient,watch){
  const r=record||readAction(localStorage,account);if(!r)return {state:'none'};await wallet(provider,account);if(watch)watch.check();if(!r.hash)return {state:'unknown'};
  const ex=providedEx||exchange(provider,account),pub=providedClient||client();
  try{const [tx,receipt]=await Promise.all([pub.getTransaction({hash:r.hash}),pub.getTransactionReceipt({hash:r.hash})]);if(!matchesTransaction(r,tx,receipt))return {state:'unknown'};
    await market(ex,{pool:r.pool,market:{baseSymbol:r.market,stopRegistry:r.registry}});
    if(receipt.status==='reverted'){await wallet(provider,account);if(watch)watch.check();clearAction(localStorage,account);await clearBackupHash(account);return {state:'reverted',hash:r.hash};}
    if(receipt.status!=='success')return {state:'unknown'};let established=false, id=null;
    if(r.kind==='approval')established=await authorized(pub,account,r.pool,r.registry);
    if(r.kind==='revoke'){const binding=await ex.client.getOperatorPermissionsRegistry(r.pool);if(eq(binding,r.to))established=!(await pub.readContract({address:binding,abi:globalAbi,functionName:'isGloballyApproved',args:[account,r.registry,PLACE_ORDER_FOR_SELECTOR]}));}
    if(r.kind==='cancel'){const matched=[];for(const log of receipt.logs){try{const e=decodeEventLog({abi:[cancelled],data:log.data,topics:log.topics});if(eq(log.address,r.registry)&&e.eventName==='PendingOrderCancelled'&&String(e.args.orderId)===r.id)matched.push(e);}catch{}}const order=await ex.client.getPerpStopOrder({registry:r.registry,orderId:r.id});established=matched.length===1&&!order;}
    if(r.kind==='stop'){
      const events=[];for(const log of receipt.logs){try{const e=decodeEventLog({abi:[created],data:log.data,topics:log.topics});if(e.eventName==='PendingOrderCreated')events.push({registry:log.address,...e.args});}catch{}}
      let decoded=null;try{decoded=decodeFunctionData({abi:stopAbi,data:tx.input});}catch{}
      id=receiptStopId({...r,stopHash:r.hash},tx,receipt,events,decoded);
      if(id!==null){saveStopHistory(localStorage,r,id);established=true;}
    }
    await wallet(provider,account);if(watch)watch.check();if(!established)return {state:'unknown',hash:r.hash,id};clearAction(localStorage,account);await clearBackupHash(account);return {state:'confirmed',kind:r.kind,hash:r.hash,id};
  }catch{return {state:'unknown',hash:r.hash};}finally{if(!providedEx){ex.setSigner({});await ex.close();}}
}
