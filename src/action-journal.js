const address=/^0x[0-9a-fA-F]{40}$/;
const hex=/^0x(?:[0-9a-fA-F]{2})*$/;
const hash=/^0x[0-9a-fA-F]{64}$/;
export const actionKey = account => `forsee:action:50383:${account.toLowerCase()}`;
export function readAction(storage,account) {
  const raw=storage.getItem(actionKey(account)); if(raw===null)return null;
  let r; try{r=JSON.parse(raw);}catch{throw new Error('Saved action is unreadable; do not repeat it.');}
  if(!r || !address.test(account) || r.account?.toLowerCase()!==account.toLowerCase() || !['approval','stop','cancel','revoke'].includes(r.kind) || !address.test(r.to||'') || !hex.test(r.data||'') || !/^(0|[1-9][0-9]*)$/.test(r.value||'') || !(r.hash===null||hash.test(r.hash)) || !address.test(r.pool||'') || !address.test(r.registry||'') || !['BTC','ETH'].includes(r.market) || !(r.id===null || /^(0|[1-9][0-9]*)$/.test(r.id))) throw new Error('Saved action is invalid; do not repeat it.');
  return r;
}
export function saveAction(storage,r) { const key=actionKey(r.account), value=JSON.stringify(r); storage.setItem(key,value);if(storage.getItem(key)!==value)throw new Error('Could not save recovery information');readAction(storage,r.account); if(typeof window!=='undefined')window.dispatchEvent(new Event('forsee-action')); }
export function clearAction(storage,account) {storage.removeItem(actionKey(account));if(storage.getItem(actionKey(account))!==null)throw new Error('Could not clear resolved action');if(typeof window!=='undefined')window.dispatchEvent(new Event('forsee-action'));}
export function matchesTransaction(r,tx,receipt) { const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();return !!tx&&!!receipt&&eq(tx.hash,r.hash)&&eq(receipt.transactionHash,r.hash)&&eq(tx.from,r.account)&&eq(tx.to,r.to)&&eq(tx.input,r.data)&&tx.value===BigInt(r.value)&&tx.chainId===50383; }
