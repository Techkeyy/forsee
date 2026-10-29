import React, { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { reviewStopTerms } from './stop.js';
import { readStopReview, observeStop } from './stop-read.js';
import { performAction } from './stop-write.js';

export default function StopReview({account, rows, sessionSignal}) {
  const eligible=rows.filter(r => r.priceable && r.size !== 0n && ['BTC','ETH'].includes(r.market?.baseSymbol) && r.market?.stopRegistry);
  const [pool,setPool]=useState('');
  const [price,setPrice]=useState('');
  const [review,setReview]=useState(null);
  const [status,setStatus]=useState('');
  const [id,setId]=useState('');
  const [observed,setObserved]=useState(null);
  const [checking,setChecking]=useState(false);
  const [actionBusy,setActionBusy]=useState(false);
  const [actionResult,setActionResult]=useState('');
  async function act(kind, stopId) {
    if(actionBusy || !row)return; setActionBusy(true);setActionResult('');
    try { const result=await performAction({provider:window.ethereum,account,kind,row,input:price,id:stopId,signal:sessionSignal}); setActionResult(result.state==='confirmed' ? `${kind==='stop'?'Stop registration':kind} confirmed${result.id!==null && result.id!==undefined ? `; stop ID ${result.id}` : ''}. Registration alone does not prove the stop is still pending or has filled. Refresh to update status.` : result.state==='rejected' ? 'Wallet request rejected.' : result.state==='reverted' ? 'Transaction reverted.' : `Outcome unknown. ${result.hash ? `Transaction hash: ${result.hash}. Save it and check the saved action.` : 'Check the saved action before trying again.'}`); } catch(error) {setActionResult(error.message || 'Action unavailable.');} finally {setActionBusy(false);}
  }
  const [acceptPermission,setAcceptPermission]=useState(false);
  const observation = useRef(0);
  const reviewGeneration = useRef(0);
  const row=eligible.find(r=>r.pool.toLowerCase()===pool.toLowerCase());
  const registry=row?.market?.stopRegistry || '';
  const terms=row ? reviewStopTerms(row,price) : null;
  useEffect(() => {
    setReview(null); setObserved(null); setStatus('');
    if (!row) return;
    let active=true; const request=++reviewGeneration.current; setStatus('Checking stop details...');
    readStopReview(account,row).then(result=>{if(active && reviewGeneration.current===request){setReview(result);setStatus('');}}).catch(()=>{if(active && reviewGeneration.current===request) setStatus('Stop details are unavailable. Refresh your account and try again.');});
    return () => {active=false; reviewGeneration.current++;};
  },[account,pool,rows]);
  useEffect(() => { observation.current++; setObserved(null); setChecking(false); return () => { observation.current++; }; },[registry,id,account]);
  async function check() {
    const request=++observation.current; setObserved(null); setChecking(true);
    try { const value=await observeStop(account,row,id); if(observation.current===request) setObserved(value); }
    catch { if(observation.current===request) setObserved({state:'unknown',source:'Read failed or reference invalid'}); }
    finally { if(observation.current===request) setChecking(false); }
  }
  return <section className="stop-review"><h2>Review a protective stop</h2><p>This stop waits for this market’s mark price. It does not reduce your position now. Other positions can exhaust shared margin before it triggers. A stop may not fill or prevent liquidation.</p>
    {eligible.length === 0 ? <p>No priceable BTC or ETH position is available to review.</p> : <><label htmlFor="stop-market">Position</label><select id="stop-market" value={pool} onChange={e=>{reviewGeneration.current++;observation.current++;setReview(null);setObserved(null);setId('');setPool(e.target.value);setPrice('');setAcceptPermission(false);}}><option value="">Choose a position</option>{eligible.map(r=><option key={r.pool} value={r.pool}>{r.market.baseSymbol} {r.size > 0n ? 'long' : 'short'}</option>)}</select>
    {row && <><p>Market price tick: {typeof row.market.tickSize === 'string' && /^\d+$/.test(row.market.tickSize) ? formatUnits(BigInt(row.market.tickSize),row.market.quoteDecimals) + ' USDso' : 'unavailable'}. Trigger prices use 18 decimal USDso units; tick alignment for trigger marks has not been verified.</p><p>Current mark: {formatUnits(row.markPrice,row.market.quoteDecimals)} USDso. Enter a trigger {row.size > 0n ? 'below' : 'above'} this mark.</p><label htmlFor="stop-trigger">Trigger mark (USDso)</label><input id="stop-trigger" type="text" inputMode="decimal" maxLength={120} value={price} onChange={e=>{setPrice(e.target.value);setAcceptPermission(false);}} />{price && !terms && <p role="status">Enter a positive price with up to 18 decimal places on the protective side of the current mark.</p>}{terms && <p>If the mark is {row.size > 0n ? 'at or below' : 'at or above'} {price} USDso, the registry will attempt a reduce-only market stop for the full remaining position at trigger time. A fill is not guaranteed.</p>}
    {status && <p role="status">{status}</p>}{review && <><p>Registry: <code>{review.registry}</code></p><p>Registry authorization for this pool: {review.authorized ? 'currently authorized' : 'not authorized'}. If authorization is needed, a separate wallet transaction grants this registry continuing global PLACE_ORDER_FOR authority across registered pools and future orders until revoked. A separate per-pool grant may continue even after global permission is revoked. Review and explicitly accept this permission before proceeding. You can review and revoke this permission below; doing so can prevent existing stops from executing.</p><p>Prepaid trigger amount: {formatUnits(review.payment,18)} STT. Wallet balance: {formatUnits(review.balance,18)} STT. Separate transaction gas is also needed; the balance alone does not prove sufficient funds.</p><p>Read at {new Date(review.readAt).toLocaleTimeString()}; refresh your account to update these details.</p><p>Pending stops from the indexer (up to 100, may lag or be incomplete). Arming is blocked when this list shows a stop for this registry; a delayed list cannot guarantee there are no duplicates: {review.pending.length}</p>{review.pending.filter(o=>o.registry?.toLowerCase()===registry.toLowerCase()).map(o=><p key={o.id}>Registry <code>{o.registry}</code>, stop ID {o.orderIdRaw} <button className="secondary" onClick={()=>{observation.current++;setObserved(null);setId(o.orderIdRaw);}}>Check status</button></p>)}</>}
    <label><input type="checkbox" checked={acceptPermission} onChange={e=>setAcceptPermission(e.target.checked)} /> I understand this registry permission is global and continues until revoked.</label>{!review?.authorized && <button disabled={actionBusy || !terms || !acceptPermission} onClick={()=>act('approval')}>Grant registry permission</button>}{review?.authorized && <button disabled={actionBusy || !terms || !acceptPermission} onClick={()=>act('stop')}>Arm protective stop</button>}{actionResult && <p role="status">{actionResult}</p>}</>}</>}
    <h3>Check an existing stop</h3><p>Select a position above and enter a stop ID for its discovered registry. A triggered or placed order is not proof of a fill.</p><p>Selected registry: {registry ? <code>{registry}</code> : "choose a position"}</p><label htmlFor="stop-id">Stop ID</label><input id="stop-id" inputMode="numeric" maxLength={39} value={id} onChange={e=>{observation.current++;setObserved(null);setId(e.target.value);}} /><button className="secondary" disabled={checking || !row} onClick={check}>{checking ? 'Checking...' : 'Check stop status'}</button>{observed?.state==='pending' && <button disabled={actionBusy} onClick={()=>act('cancel',id)}>Cancel this stop</button>}{observed && <p role="status">{observed.state} ({observed.source}){observed.orderId != null ? `, pool order ID ${observed.orderId}` : ''}{observed.reason ? `, reason: ${observed.reason}` : ''}. Fill not verified.</p>}
  </section>;
}







