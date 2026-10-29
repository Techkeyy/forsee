import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, PLACE_ORDER_FOR_SELECTOR } from '@somnia-chain/markets-sdk';
import { hidekiTestnet } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, isAddress, parseAbiItem, parseAbi, decodeEventLog, decodeFunctionData } from 'viem';
import { mapStopState, validStopReference, matchesDiscoveredMarket } from './stop.js';
import { validateAttempt, receiptStopId, assessKnownStop, settleSources } from './stop-attempt.js';
const stopCallAbi=parseAbi(['function createPendingOrder(((bool isBid, address owner, uint64 userData, uint256 quantity) order, uint8 orderType, uint256 triggerPrice, uint8 triggerOperator, uint256 limitPrice, address builder, uint96 builderFeeBpsTimes1k) orderWithTrigger) payable returns (uint128 pendingOrderId)']);
const creationEvent=parseAbiItem('event PendingOrderCreated(uint128 indexed orderId, address indexed owner, bool isBid, uint256 quantity, uint256 triggerPrice, uint8 triggerOperator, uint8 orderType, address builder, uint96 builderFeeBpsTimes1k)');

const indexerUrl = 'https://hideki-dev.smk.somnia.host/v1/graphql';
const authAbi = [{type:'function',name:'isOperatorAuthorized',stateMutability:'view',inputs:[{name:'owner',type:'address'},{name:'operator',type:'address'},{name:'selector',type:'bytes4'}],outputs:[{type:'bool'}]}];
const exchange = () => new SomniaMarkets({chain:hidekiTestnet,indexerUrl,addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES});
const rpc = () => createPublicClient({chain:hidekiTestnet,transport:http()});

export async function readStopReview(account, row) {
  if (!isAddress(account) || !isAddress(row?.pool || '') || !isAddress(row?.market?.stopRegistry || '')) throw new Error('Stop registry unavailable');
  const ex=exchange(); const client=rpc();
  try {
    const markets=await ex.client.listPerpMarkets();
    if (!matchesDiscoveredMarket(row,markets)) throw new Error('Registry does not match discovered market');
    const registry=row.market.stopRegistry;
    const [payment, authorized, balance, pending] = await Promise.all([
      ex.client.getPerpStopOrderSomiPayment(registry),
      client.readContract({address:row.pool,abi:authAbi,functionName:'isOperatorAuthorized',args:[account,registry,PLACE_ORDER_FOR_SELECTOR]}),
      client.getBalance({address:account}),
      ex.client.listPerpStopOrders({account,pool:row.pool,status:['PENDING'],limit:100})
    ]);
    return {registry,payment,authorized,balance,pending,readAt:Date.now()};
  } finally { await ex.close(); }
}

export async function observeStop(account, row, orderId) {
  const registry=row?.market?.stopRegistry;
  if (!isAddress(account) || !validStopReference(registry,orderId)) throw new Error('Invalid stop reference');
  const ex=exchange();
  try {
    const markets=await ex.client.listPerpMarkets();
    if (!matchesDiscoveredMarket(row,markets)) return {state:'unknown',source:'registry not verified for selected market'};
    const [chainOrder, history] = await Promise.all([
      ex.client.getPerpStopOrder({registry,orderId}),
      ex.client.listPerpStopOrders({account,pool:row.pool,status:['PENDING','TRIGGERED','TRIGGER_FAILED','CANCELLED'],limit:100})
    ]);
    const indexed=history.find(o=>o.registry.toLowerCase()===registry.toLowerCase() && o.orderIdRaw===orderId);
    return mapStopState(chainOrder,indexed,account);
  } finally { await ex.close(); }
}


// Read-only evidence gathering: absence from indexed history is not proof of absence.
export async function reconcileStopAttempt(provider, account, record) {
  if (!validateAttempt(record,account)) throw new Error('Attempt does not match this account');
  const row={pool:record.pool,market:{baseSymbol:record.market,stopRegistry:record.registry}};
  const accounts=await provider.request({method:'eth_accounts'});
  const chain=await provider.request({method:'eth_chainId'});
  const network=await provider.request({method:'net_version'});
  const genesis=await provider.request({method:'eth_getBlockByNumber',params:['0x0',false]});
  if(accounts[0]?.toLowerCase()!==account.toLowerCase() || chain!=='0xc4cf' || network!=='50000259' || genesis?.hash?.toLowerCase()!=='0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25') throw new Error('Wallet or network changed');
  const ex=exchange(), client=rpc();
  try {
    const source = await settleSources({
      markets:()=>ex.client.listPerpMarkets(),
      authorization:()=>client.readContract({address:record.pool,abi:authAbi,functionName:'isOperatorAuthorized',args:[account,record.registry,PLACE_ORDER_FOR_SELECTOR]}),
      indexer:()=>ex.client.listPerpStopOrders({account,pool:record.pool,status:['PENDING'],limit:100}),
      receipt:()=>record.stopHash ? client.getTransactionReceipt({hash:record.stopHash}) : Promise.resolve(null),
      transaction:()=>record.stopHash ? client.getTransaction({hash:record.stopHash}) : Promise.resolve(null),
      registry:()=>record.id!==null ? ex.client.getPerpStopOrder({registry:record.registry,orderId:record.id}) : Promise.resolve(null),
    });
    const markets=source.markets.value;
    const registryVerified=source.markets.status==='available' && matchesDiscoveredMarket(row,markets);
    const market=registryVerified ? markets.find(m=>m.poolAddress.toLowerCase()===record.pool.toLowerCase()) : null;
    const positionResult=market ? await settleSources({position:()=>ex.client.getPerpPosition({marginBank:market.marginBank,account,pool:record.pool})}) : {position:{status:'unavailable',value:null}};
    source.position=positionResult.position;
    const pending=source.indexer.value;
    const candidates=pending ? pending.filter(o=>o.registry?.toLowerCase()===record.registry.toLowerCase() && !record.preExistingIds.includes(o.orderIdRaw)) : [];
    const receipt=source.receipt.value, tx=source.transaction.value, chainOrder=source.registry.value;
    const events=[];
    if(record.stopHash && receipt) for(const log of receipt.logs) { try {const decoded=decodeEventLog({abi:[creationEvent],data:log.data,topics:log.topics}); if(decoded.eventName==='PendingOrderCreated') events.push({registry:log.address,...decoded.args});} catch {} }
    let decodedCall=null; if(tx?.input) { try {decodedCall=decodeFunctionData({abi:stopCallAbi,data:tx.input});} catch {} }
    const receiptId=record.stopHash && registryVerified ? receiptStopId(record,tx,receipt,events,decodedCall) : null;
    const verifiedStopId=receiptId!==null && (record.id===null || record.id===receiptId) ? receiptId : null;
    const knownStopState=assessKnownStop(record,chainOrder,{registryVerified,pool:record.pool,registry:record.registry},verifiedStopId);    const currentAccounts=await provider.request({method:'eth_accounts'});
    const currentChain=await provider.request({method:'eth_chainId'});
    const currentNetwork=await provider.request({method:'net_version'});
    const currentGenesis=await provider.request({method:'eth_getBlockByNumber',params:['0x0',false]});
    if(currentAccounts[0]?.toLowerCase()!==account.toLowerCase() || currentChain!=='0xc4cf' || currentNetwork!=='50000259' || currentGenesis?.hash?.toLowerCase()!=='0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25') throw new Error('Wallet or network changed');
    return {authorized:registryVerified ? source.authorization.value : null,pending,candidates,receipt,chainOrder,position:source.position.value,verifiedStopId,knownStopState,sourceStatus:Object.fromEntries(Object.entries(source).map(([k,v])=>[k,v.status])),registryVerified,limitations:'Each source can be unavailable. Indexer results may lag or omit entries beyond the first 100; candidates do not prove creation by this attempt.'};
  } finally {await ex.close();}
}





