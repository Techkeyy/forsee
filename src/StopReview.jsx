import React, { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { reviewStopTerms } from './stop.js';
import { readStopReview, observeStop } from './stop-read.js';
import { performAction } from './stop-write.js';

export default function StopReview({account, rows, accountFresh, sessionSignal}) {
  const eligible=rows.filter(r => r.priceable && r.size !== 0n && ['BTC','ETH'].includes(r.market?.baseSymbol) && r.market?.stopRegistry);
  const [pool,setPool]=useState('');
  const [price,setPrice]=useState('');
  const [review,setReview]=useState(null);
  const [reviewRows,setReviewRows]=useState(null);
  const [status,setStatus]=useState('');
  const [id,setId]=useState('');
  const [observed,setObserved]=useState(null);
  const [lookupOpen,setLookupOpen]=useState(false);
  const [checking,setChecking]=useState(false);
  const [actionBusy,setActionBusy]=useState(false);
  const [actionResult,setActionResult]=useState('');
  const [refreshVersion,setRefreshVersion]=useState(0);
  const [approvalConfirmed,setApprovalConfirmed]=useState(false);
  const [stopConfirmed,setStopConfirmed]=useState(false);
  async function act(kind, stopId) {
    if(actionBusy || !row || ((kind==='approval' || kind==='stop') && (!accountFresh || !review || reviewRows!==rows)))return; setActionBusy(true);setActionResult('');
    try { const result=await performAction({provider:window.ethereum,account,kind,row,input:price,id:stopId,signal:sessionSignal}); if(result.state==='confirmed' && kind==='approval') setApprovalConfirmed(true); if(result.state==='confirmed' && kind==='stop') setStopConfirmed(true); if(result.state==='confirmed' && kind==='stop' && result.id!==null && result.id!==undefined){observation.current++;setObserved(null);setId(String(result.id));setLookupOpen(true);} setActionResult(result.state==='confirmed' ? kind==='approval' ? 'Permission transaction confirmed. Refresh stop details to check the current permission before arming.' : kind==='stop' ? `Stop registration confirmed${result.id!==null && result.id!==undefined ? `; stop ID ${result.id}` : ''}. Check its status below. Registration does not prove the stop is still pending or has filled.` : 'Cancellation confirmed. Check stop status to refresh the result.' : result.state==='rejected' ? 'Wallet request rejected.' : result.state==='reverted' ? 'Transaction reverted.' : `Outcome unknown. ${result.hash ? `Transaction hash: ${result.hash}. Save it and check the saved action.` : 'Check the saved action before trying again.'}`); } catch(error) {setActionResult(error.message || 'Action unavailable.');} finally {setActionBusy(false);}
  }
  const [acceptPermission,setAcceptPermission]=useState(false);
  const observation = useRef(0);
  const reviewGeneration = useRef(0);
  const row=eligible.find(r=>r.pool.toLowerCase()===pool.toLowerCase());
  const registry=row?.market?.stopRegistry || '';
  const terms=row ? reviewStopTerms(row,price) : null;
  useEffect(() => {
    setReview(null); setObserved(null); setStatus('');
    if (!row || !accountFresh) return;
    let active=true; const request=++reviewGeneration.current; setStatus('Checking stop details...');
    readStopReview(account,row).then(result=>{if(active && reviewGeneration.current===request){setReview(result);setReviewRows(rows);setStatus('');if(result.authorized) setApprovalConfirmed(false);}}).catch(()=>{if(active && reviewGeneration.current===request) setStatus('Stop details are unavailable. Refresh your account and try again.');});
    return () => {active=false; reviewGeneration.current++;};
  },[account,pool,rows,refreshVersion,accountFresh]);
  useEffect(() => { observation.current++; setObserved(null); setChecking(false); return () => { observation.current++; }; },[registry,id,account]);
  async function check() {
    const request=++observation.current; setObserved(null); setChecking(true);
    try { const value=await observeStop(account,row,id); if(observation.current===request) setObserved(value); }
    catch { if(observation.current===request) setObserved({state:'unknown',source:'Read failed or reference invalid'}); }
    finally { if(observation.current===request) setChecking(false); }
  }
  return <section className="stop-review stop-ticket">
    <div className="stop-ticket-heading"><div><p className="stop-kicker">PROTECTION TICKET</p><h2>Protect a position</h2></div></div>
    <p>Set a mark price that will attempt to reduce your position if the market moves against you.</p>
    <p className="stop-warning">A stop may not fill or prevent liquidation. Other positions can exhaust shared margin before it triggers.</p>
    {eligible.length === 0 ? <p role="status">No eligible BTC or ETH position is available. Open or refresh a priceable position to review a stop.</p> : <>
      <div className="stop-step"><h3><span>1</span> Choose position</h3><label htmlFor="stop-market">Position</label><select id="stop-market" value={pool} onChange={e=>{reviewGeneration.current++;observation.current++;setReview(null);setObserved(null);setId('');setPool(e.target.value);setPrice('');setAcceptPermission(false);setActionResult('');setApprovalConfirmed(false);}}><option value="">Choose a position</option>{eligible.map(r=><option key={r.pool} value={r.pool}>{r.market.baseSymbol} {r.size > 0n ? 'long' : 'short'}</option>)}</select></div>
      {row && <>
        <div className="stop-step"><h3><span>2</span> Set trigger</h3><div className="stop-quote"><span>{accountFresh ? 'Current mark' : 'Last known mark'}</span><strong>{formatUnits(row.markPrice,row.market.quoteDecimals)} USDso</strong></div><label htmlFor="stop-trigger">Trigger mark (USDso)</label><input id="stop-trigger" type="text" inputMode="decimal" maxLength={120} value={price} onChange={e=>{setPrice(e.target.value);setAcceptPermission(false);setActionResult('');}} aria-describedby="stop-trigger-help" /><p id="stop-trigger-help">Enter a price {row.size > 0n ? 'below' : 'above'} the current mark.</p>{price && !terms && <p role="status" className="stop-warning">Enter a positive price with up to 18 decimal places on the protective side of the current mark.</p>}</div>
        <div className="stop-step"><h3><span>3</span> Review and arm</h3>{terms ? <p className="stop-outcome">If the mark is {row.size > 0n ? 'at or below' : 'at or above'} <strong>{price} USDso</strong>, the registry will attempt a reduce-only market stop for the full remaining position at trigger time. A fill is not guaranteed.</p> : <p>Enter a valid trigger to review what the stop will do.</p>}
        {!accountFresh && <p role="status" className="stop-warning">Account data is stale. Refresh the account to recheck this position and its stop details before granting permission or arming.</p>}{status && <p role="status">{status}</p>}{review && <><div className="stop-quote"><span>Prepaid trigger amount</span><strong>{formatUnits(review.payment,18)} STT</strong></div><div className="stop-quote"><span>Wallet balance</span><strong>{formatUnits(review.balance,18)} STT</strong></div><p>Separate transaction gas is also needed. The balance alone does not prove sufficient funds.</p><p>Registry permission: <strong>{review.authorized ? 'currently authorized' : 'not authorized'}</strong>.</p><p>Permission grants this registry continuing global PLACE_ORDER_FOR authority across registered pools and future orders until revoked. A separate per-pool grant may continue after global permission is revoked. Revoking permission can prevent existing stops from executing.</p><p>Pending stops found: <strong>{review.pending.length}</strong>. This list may lag or be incomplete. Arming is blocked when it shows a stop for this registry, but it cannot guarantee there are no duplicates.</p>{review.pending.filter(o=>o.registry?.toLowerCase()===registry.toLowerCase()).map(o=><p key={o.id}>Stop ID {o.orderIdRaw} <button className="secondary" onClick={()=>{observation.current++;setObserved(null);setId(o.orderIdRaw);setLookupOpen(true);}}>Check status</button></p>)}<details className="stop-details"><summary>Registry and price details</summary><p>Registry: <code>{review.registry}</code></p><p>Market price tick: {typeof row.market.tickSize === 'string' && /^\d+$/.test(row.market.tickSize) ? formatUnits(BigInt(row.market.tickSize),row.market.quoteDecimals) + ' USDso' : 'unavailable'}. Trigger prices use 18 decimal USDso units; tick alignment for trigger marks has not been verified.</p><p>Details read at {new Date(review.readAt).toLocaleTimeString()}. Refresh your account to update them. Pending stops are from the indexer, up to 100.</p></details></>}
        <label className="stop-consent"><input type="checkbox" checked={acceptPermission} onChange={e=>setAcceptPermission(e.target.checked)} /> I understand this registry permission is global and continues until revoked.</label>{approvalConfirmed && <p role="status">Permission is not yet observed. Refresh stop details before continuing.</p>}{approvalConfirmed && <button className="secondary" disabled={actionBusy || status==='Checking stop details...'} onClick={()=>setRefreshVersion(v=>v+1)}>Refresh stop details</button>}{!approvalConfirmed && !review?.authorized && <button disabled={actionBusy || !accountFresh || !review || reviewRows!==rows || !terms || !acceptPermission} onClick={()=>act('approval')}>{actionBusy ? 'Waiting for wallet or confirmation...' : 'Grant registry permission'}</button>}{review?.authorized && <button disabled={actionBusy || stopConfirmed || !accountFresh || !review || reviewRows!==rows || !terms || !acceptPermission} onClick={()=>act('stop')}>{actionBusy ? 'Waiting for wallet or confirmation...' : stopConfirmed ? 'Stop registration confirmed' : 'Arm protective stop'}</button>}{stopConfirmed && <p>Check the registered stop below before taking another action. Registration does not confirm a fill.</p>}{actionResult && <p role="status" className="stop-action-result">{actionResult}</p>}</div>
      </>}
    </>}
    <details className="advanced stop-lookup" open={lookupOpen} onToggle={e=>setLookupOpen(e.currentTarget.open)}><summary>Check or cancel an existing stop</summary><p>Select a position above and enter a stop ID for its discovered registry. A triggered or placed order is not proof of a fill.</p><p>Selected registry: {registry ? <code>{registry}</code> : "choose a position"}</p><label htmlFor="stop-id">Stop ID</label><input id="stop-id" inputMode="numeric" maxLength={39} value={id} onChange={e=>{observation.current++;setObserved(null);setId(e.target.value);}} /><button className="secondary" disabled={checking || !row} onClick={check}>{checking ? 'Checking...' : 'Check stop status'}</button>{observed?.state==='pending' && <button disabled={actionBusy} onClick={()=>act('cancel',id)}>{actionBusy ? 'Waiting for wallet or confirmation...' : 'Cancel this stop'}</button>}{observed && <p role="status">{observed.state} ({observed.source}){observed.orderId != null ? `, pool order ID ${observed.orderId}` : ''}{observed.reason ? `, reason: ${observed.reason}` : ''}. Fill not verified.</p>}</details>
  </section>;
}
