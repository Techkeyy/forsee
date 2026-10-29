// Durable, account-scoped recovery state. This module does not send transactions.
const PHASES=new Set(['approval_requested','approval_known','stop_requested','hash_known','id_known','pending_verified']);
const address=/^0x[0-9a-fA-F]{40}$/;
const hash=/^0x[0-9a-fA-F]{64}$/;
const uint=/^(0|[1-9][0-9]*)$/;
export const attemptKey=account=>`forsee:hideki2:50383:${account.toLowerCase()}`;
export function validateAttempt(r, account) {
  return !!r && r.network==='hideki2:50383:50000259' && PHASES.has(r.phase) && address.test(r.account||'') && r.account.toLowerCase()===account.toLowerCase() && address.test(r.pool||'') && address.test(r.registry||'') && ['BTC','ETH'].includes(r.market) && ['long','short'].includes(r.side) && typeof r.trigger==='string' && r.trigger.length<=78 && uint.test(r.trigger) && BigInt(r.trigger)>0n && BigInt(r.trigger)<(1n<<256n) && typeof r.createdAt==='number' && Number.isFinite(r.createdAt) && Array.isArray(r.preExistingIds) && r.preExistingIds.every(x=>typeof x==='string' && uint.test(x) && x.length<=39 && BigInt(x)<(1n<<128n)) && (r.approvalHash===null || hash.test(r.approvalHash)) && (r.stopHash===null || hash.test(r.stopHash)) && (r.id===null || (typeof r.id==='string' && uint.test(r.id) && r.id.length<=39 && BigInt(r.id)<(1n<<128n)));
}
export function saveAttempt(storage, record) {
  if (!validateAttempt(record,record.account)) throw new Error('Invalid recovery record');
  const key=attemptKey(record.account); const text=JSON.stringify(record);
  storage.setItem(key,text); if(storage.getItem(key)!==text) throw new Error('Recovery record could not be saved');
}
export function loadAttempt(storage,account) {
  const raw=storage.getItem(attemptKey(account)); if(raw===null) return null;
  let record; try { record=JSON.parse(raw); } catch { throw new Error('Recovery record is unreadable; do not submit again'); }
  if(!validateAttempt(record,account)) throw new Error('Recovery record is invalid; do not submit again');
  return record;
}
export function updateAttempt(record,event) {
  switch(event.type) {
    case 'approval_requested': return {...record,phase:'approval_requested'};
    case 'approval_known': return {...record,phase:'approval_known',approvalHash:event.hash};
    case 'stop_requested': return {...record,phase:'stop_requested',stopHash:null,id:null};
    case 'hash_known': return {...record,phase:'hash_known',stopHash:event.hash};
    case 'id_known': return {...record,phase:'id_known',stopHash:event.hash,id:event.id};
    case 'pending_verified': return {...record,phase:'pending_verified',stopHash:event.hash,id:event.id};
    default: throw new Error('Unknown recovery transition');
  }
}
// Only a directly evidenced wallet rejection can establish that a request was not broadcast.
export function classifyWalletError(error) {
  const seen=new Set(); let current=error, rejected=false, broadcast=false;
  while(current && typeof current==='object' && !seen.has(current)) {
    if(current.code===4001) rejected=true;
    if(typeof current.hash==='string' || current.name==='TransactionOutcomeUnknownError') broadcast=true;
    seen.add(current); current=current.cause;
  }
  return rejected && !broadcast ? 'rejected' : 'unknown';
}




// A matching successful receipt plus exactly one creation event identifies registration;
// it does not establish a fill. Unknown/mismatched fields always fail closed.
export function receiptStopId(record, tx, receipt, events, decodedCall) {
  const eq=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
  if (!tx || !receipt || !Array.isArray(events) || !eq(tx.from,record.account) || !eq(tx.to,record.registry) || tx.chainId!==50383 || !eq(tx.hash,record.stopHash) || !eq(receipt.transactionHash,record.stopHash) || receipt.status!=='success') return null;
  if(!matchesStopCall(record,decodedCall)) return null;
  const valid=events.filter(e=>eq(e.registry,record.registry) && eq(e.owner,record.account) && e.isBid===(record.side==='short') && e.quantity===0n && e.triggerPrice===BigInt(record.trigger) && e.triggerOperator===(record.side==='long'?1:0) && e.orderType===1 && eq(e.builder,'0x0000000000000000000000000000000000000000') && e.builderFeeBpsTimes1k===0n && typeof e.orderId==='bigint' && e.orderId>=0n && e.orderId<(1n<<128n));
  return valid.length===1 ? String(valid[0].orderId) : null;
}


export function createWalletGuard(provider) {
  if(typeof provider?.on!=='function' || typeof provider?.removeListener!=='function') throw new Error('Wallet event monitoring unavailable');
  let changed=false; const invalidate=()=>{changed=true;};
  provider.on('accountsChanged',invalidate);provider.on('chainChanged',invalidate);
  return {check(){if(changed) throw new Error('Wallet changed during attempt');},close(){provider.removeListener('accountsChanged',invalidate);provider.removeListener('chainChanged',invalidate);}};
}

export function shouldShowRecovery(account,networkVerified) { return !!account && networkVerified === true; }


// SDK PerpStopOrderOnChain has owner, isBid, quantity, triggerPrice,
// triggerOperator, orderType, intent, builder and builderFeeBpsTimes1k.
// Registry/pool identity comes from separately verified market discovery.
export function assessKnownStop(record, chainOrder, context, receiptId) {
  const eq=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
  if(!record || record.id===null || !chainOrder || !context?.registryVerified || !eq(context.pool,record.pool) || !eq(context.registry,record.registry)) return 'unknown';
  if(record.stopHash && (receiptId===null || receiptId!==record.id)) return 'unknown';
  if(!eq(chainOrder.owner,record.account) || chainOrder.isBid!==(record.side==='short') || chainOrder.quantity!==0n || chainOrder.triggerPrice!==BigInt(record.trigger) || chainOrder.triggerOperator!==(record.side==='long'?1:0) || chainOrder.orderType!==1 || chainOrder.intent!=='reduceOnly' || !eq(chainOrder.builder,'0x0000000000000000000000000000000000000000') || chainOrder.builderFeeBpsTimes1k!==0n) return 'unknown';
  return 'matching pending';
}
export async function settleSources(sources) {
  const keys=Object.keys(sources);
  const results=await Promise.allSettled(keys.map(k=>Promise.resolve().then(sources[k])));
  return Object.fromEntries(keys.map((key,i)=>[key,results[i].status==='fulfilled'?{status:'available',value:results[i].value}:{status:'unavailable',value:null}]));
}

// Only the SDK 0.32.1 single-leg createPendingOrder route is accepted.
// The creation event alone omits intent; this call is documented reduce-only.
export function matchesStopCall(record,decoded) {
  const eq=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
  if(decoded?.functionName!=='createPendingOrder' || !Array.isArray(decoded.args) || decoded.args.length!==1) return false;
  const leg=decoded.args[0], order=leg?.order;
  return !!order && eq(order.owner,record.account) && order.isBid===(record.side==='short') && order.userData===0n && order.quantity===0n && leg.orderType===1 && leg.triggerPrice===BigInt(record.trigger) && leg.triggerOperator===(record.side==='long'?1:0) && leg.limitPrice===0n && eq(leg.builder,'0x0000000000000000000000000000000000000000') && leg.builderFeeBpsTimes1k===0n;
}
