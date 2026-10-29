import React, {useState, useEffect, useRef} from 'react';
import {SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES} from '@somnia-chain/markets-sdk';
import {hidekiTestnet} from '@somnia-chain/markets-sdk/chains';
import {createWalletClient, createPublicClient, custom, erc20Abi, formatUnits, encodeFunctionData} from 'viem';
import {readAccount, isFresh} from './account.js';
import {receiptOrder, assertAttempt, saveVerified, withWalletLock, bufferedGas, persistHash, definiteRejection, removeMatching, actionLockKey, exactUnits, boundedLong, beforeWalletRequest, revertedOrderReceipt, validApprovalIntent, validateFunding} from './onboard-reconcile.js';
import {assertNoUnresolved} from './unresolved-journals.js';
import {gridDefault, preferredAmount} from './order-grid.js';
import {quoteSecondsRemaining} from './quote-expiry.js';

const CLAIM_ENABLED = false;
const ORDER_ENABLED = true;
const GENESIS = '0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25';
const BANK = '0x478769e1177c0773c43a593dccc4ad15f15f1394';
const COLLATERAL = '0xed7993a74dae1e6656b704a424dcd8711aaf4f72';
const DISTRIBUTOR = '0x2acd9efda721450906bfe1bef3ede269636e42c4';
const FACTORY = '0xe631faee547baee07353e290f0562ea67d856560';
const ENGINE = '0xa66d3c24ad4a389d863846905d8173e1017e9f4d';
const FUND = '0x50826894d47c6d4f3bea38bfdc7dc5c5be171b80';
const ALLOWANCE_CAP = 20n*10n**18n;
const bookAbi = [{type:'function',name:'getOrderBookParameters',stateMutability:'view',inputs:[],outputs:[{type:'tuple',components:[{name:'tickSize',type:'uint256'},{name:'minQuantity',type:'uint256'},{name:'lotSize',type:'uint256'}]}]}];
const key = account => `forsee-onboard:${account.toLowerCase()}`;

async function identity(provider, account) {
  if (typeof provider?.on !== 'function' || typeof provider?.removeListener !== 'function') throw Error('Wallet change monitoring is unavailable.');
  const [accounts, chain, network, genesis, code] = await Promise.all([
    provider.request({method:'eth_accounts'}), provider.request({method:'eth_chainId'}),
    provider.request({method:'net_version'}), provider.request({method:'eth_getBlockByNumber',params:['0x0',false]}), provider.request({method:'eth_getCode',params:[account,'latest']})
  ]);
  if (accounts[0]?.toLowerCase() !== account.toLowerCase() || chain !== '0xc4cf' || network !== '50000259' || genesis?.hash?.toLowerCase() !== GENESIS) throw Error('Wallet account or network changed. Reconnect before continuing.');
  if (code !== '0x') throw Error('This setup currently supports externally owned accounts only.');
}

export default function Onboard({account, onRefresh, sessionSignal, canOpen, positionKnown}) {
  const [quantity, setQuantity] = useState('');
  const [symbol, setSymbol] = useState('BTC');
  const edits = useRef({});
  const gridGeneration = useRef(0);
  const [grid,setGrid] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoteNow, setQuoteNow] = useState(Date.now());
  useEffect(() => {
    if (!quote) return;
    setQuoteNow(Date.now());
    const timer = setInterval(() => setQuoteNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [quote]);
  const [message, setMessage] = useState('');
  const [funds, setFunds] = useState(null);
  const [fundsRevision, setFundsRevision] = useState(0);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const provider = window.ethereum;
    const invalidate = () => { generation.current++; };
    provider?.on?.('accountsChanged',invalidate); provider?.on?.('chainChanged',invalidate);
    return () => { invalidate(); provider?.removeListener?.('accountsChanged',invalidate); provider?.removeListener?.('chainChanged',invalidate); };
  }, []);
  const [pending, setPending] = useState(() => { try {
    const primary=JSON.parse(localStorage.getItem(key(account)) || 'null');
    const backup=JSON.parse(sessionStorage.getItem(`${key(account)}:hash-backup`) || 'null');
    return primary?.unknown && backup?.hash && backup.to === primary.to && backup.data === primary.data ? backup : primary;
  } catch { return {unknown:true}; } });
  useEffect(() => {
    let active=true; const attempt=generation.current; setFunds(null);
    (async()=>{
      const provider=window.ethereum; await identity(provider,account);
      const rpc=createPublicClient({chain:hidekiTestnet,transport:custom(provider)});
      const [balance,allowance,decimals]=await Promise.all([
        rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'balanceOf',args:[account]}),
        rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'allowance',args:[account,BANK]}),
        rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'decimals'})
      ]);
      await identity(provider,account); assertAttempt(generation,attempt);
      if (!sessionSignal || sessionSignal.aborted || decimals!==18) throw Error('Wallet session unavailable');
      if(active) setFunds({balance,allowance});
    })().catch(()=>{if(active && generation.current===attempt) setFunds({error:true});});
    return ()=>{active=false;};
  },[account,sessionSignal,fundsRevision]);
  async function setup(requestedSymbol='BTC', verifyMarket=false) {
    const provider = window.ethereum;
    if (!provider) throw Error('Browser wallet unavailable.');
    await identity(provider, account);
    const walletClient = createWalletClient({account,chain:hidekiTestnet,transport:custom(provider)});
    const markets = new SomniaMarkets({chain:hidekiTestnet,indexerUrl:'https://hideki-dev.smk.somnia.host/v1/graphql',addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES,walletClient});
    const rows = await markets.client.listPerpMarkets();
    const choices = rows.filter(m => m.baseSymbol === requestedSymbol && m.marginBank?.toLowerCase() === BANK && m.quoteToken?.toLowerCase() === COLLATERAL);
    if (choices.length !== 1) throw Error('The selected market could not be verified. Try again later.');
    const config = await markets.client.getPerpSystemConfig(choices[0].marginBank);
    if (!config.fullyWired || config.marginBank?.toLowerCase() !== BANK || config.collateralToken?.toLowerCase() !== COLLATERAL || config.perpPoolFactory?.toLowerCase() !== FACTORY || config.liquidationEngine?.toLowerCase() !== ENGINE || config.insuranceFund?.toLowerCase() !== FUND) throw Error('Market configuration could not be verified.');
    if (!verifyMarket) return {provider, markets, market:choices[0]};
    const status = (await markets.client.listPerpPoolStatuses({factory:FACTORY})).filter(s => s.pool.toLowerCase() === choices[0].poolAddress.toLowerCase());
    if (status.length!==1 || status[0].tradeable!==true || status[0].marginBank.toLowerCase()!==BANK) throw Error('The market is not verified as tradeable.');
    const rpc=createPublicClient({chain:hidekiTestnet,transport:custom(provider)});
    const decimals=await rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'decimals'});
    if (decimals!==18) throw Error('Collateral precision could not be verified.');
    const onchain = await markets.client.readPerpMarketFromChain({status:status[0],collateralToken:COLLATERAL,collateralDecimals:18,collateralSymbol:'USDso',factory:FACTORY});
    if (onchain.baseSymbol !== requestedSymbol || onchain.baseDecimals !== choices[0].baseDecimals || onchain.quoteDecimals !== 18 || onchain.poolAddress.toLowerCase() !== choices[0].poolAddress.toLowerCase()) throw Error('Market metadata disagrees with the chain.');
    return {provider,markets,market:onchain};
  }
  useEffect(()=>{
    if (!canOpen) { setGrid(null); setQuote(null); return; }
    let active=true,exchange; const attempt=generation.current, gridAttempt=++gridGeneration.current; setGrid(null);
    (async()=>{
      const {provider,markets,market}=await setup(symbol,true); exchange=markets;
      const rpc=createPublicClient({chain:hidekiTestnet,transport:custom(provider)});
      const {minQuantity,lotSize}=await rpc.readContract({address:market.poolAddress,abi:bookAbi,functionName:'getOrderBookParameters'});
      const rules=gridDefault(symbol,market.baseDecimals,minQuantity,lotSize);
      await identity(provider,account); assertAttempt(generation,attempt);
      if (!sessionSignal || sessionSignal.aborted) throw Error('Wallet session ended.');
      if(active && gridGeneration.current===gridAttempt) { setGrid({...rules,symbol}); setQuantity(preferredAmount(symbol,rules.suggested,edits.current)); }
    })().catch(()=>{if(active && generation.current===attempt && gridGeneration.current===gridAttempt) setGrid({symbol,error:true});}).finally(async()=>{try{await exchange?.close();}catch{}});
    return ()=>{active=false;};
  },[symbol,account,sessionSignal,canOpen]);
  async function orderInputs(provider,markets,market,amount,approvedPrice,approvedAllowance) {
    assertNoUnresolved(localStorage,account);
    const voucher = await markets.client.getPerpVoucher(market.marginBank,account);
    if (voucher?.floor > 0n && voucher.expiresAt <= BigInt(Math.floor(Date.now()/1000))+60n) throw Error('Paper credit is near expiry. Refresh your funding before opening a position.');
    const snapshot=await readAccount(account);
    if (!snapshot.complete || !isFresh(snapshot,performance.now()) || snapshot.gap>100n || snapshot.rows.length || snapshot.margin.lockedCollateral !== 0n) throw Error('A fresh account without positions or locked order collateral is required. Refresh and try again.');
    const rpc=createPublicClient({chain:hidekiTestnet,transport:custom(provider)});
    const [{tickSize,minQuantity,lotSize},book] = await Promise.all([
      rpc.readContract({address:market.poolAddress,abi:bookAbi,functionName:'getOrderBookParameters'}),
      markets.client.getSpotOrderBook(market.poolAddress,{depth:1})
    ]);
    if (typeof book.blockNumber !== 'bigint' || !book.asks?.length) throw Error('No current ask is available.');
    const [head,bookBlock] = await Promise.all([rpc.getBlock(),rpc.getBlock({blockNumber:book.blockNumber})]);
    const now = BigInt(Math.floor(Date.now()/1000));
    if (bookBlock.timestamp>head.timestamp || now+5n<head.timestamp || now>bookBlock.timestamp+30n || head.number<book.blockNumber || head.number-book.blockNumber>100n) throw Error('Market data is stale. Refresh the quote.');
    const q=exactUnits(amount,market.baseDecimals), ask=book.asks[0].price;
    const limit=boundedLong({ask,tick:tickSize,quantity:q,lot:lotSize,min:minQuantity,baseDecimals:market.baseDecimals,quoteDecimals:market.quoteDecimals,symbol:market.baseSymbol});
    const p=approvedPrice === undefined ? limit : approvedPrice;
    if (p<ask || p>limit || p%tickSize) throw Error('The market moved beyond the reviewed price. Refresh the quote.');
    const max=await markets.client.getMaxPerpOrderSize({pool:market.poolAddress,marginBank:market.marginBank,account,isBid:true,price:p,autoPull:true});
    if (!max.priceable || !max.placeable || q>max.maxQuantity) throw Error('This order is unavailable or exceeds your allowed size.');
    const margin=await markets.client.previewPerpOrderMargin({pool:market.poolAddress,marginBank:market.marginBank,account,isBid:true,price:p,quantity:q,autoPull:true});
    validateFunding(margin,approvedAllowance);
    return {price:p,quantity:q,blockNumber:book.blockNumber,ownWalletPull:margin.ownWalletPull,allowance:margin.wallet.allowance,lockAmount:margin.lockAmount};
  }
  async function previewOrder() {
    if (!ORDER_ENABLED || running.current || pending) return;
    running.current=true; setBusy(true); setQuote(null); let exchange; const attempt=generation.current;
    try {
      const {provider,markets,market}=await setup(symbol,true); exchange=markets;
      const inputs=await orderInputs(provider,markets,market,quantity);
      await identity(provider,account); assertAttempt(generation,attempt);
      setQuote({symbol,amount:quantity,pool:market.poolAddress,baseDecimals:market.baseDecimals,quoteDecimals:market.quoteDecimals,price:String(inputs.price),ownWalletPull:String(inputs.ownWalletPull),allowance:String(inputs.allowance),lockAmount:String(inputs.lockAmount),created:Date.now()});
      setMessage('Review the maximum price and amount before opening your wallet.');
    } catch(e) { if (generation.current===attempt) setMessage(e?.message || 'Could not prepare a quote.'); }
    finally { try { await exchange?.close(); } catch {} running.current=false; if (generation.current===attempt) setBusy(false); }
  }
  async function submit(kind) {
    if (!(kind === 'claim' ? CLAIM_ENABLED : ORDER_ENABLED) || running.current || pending || localStorage.getItem(key(account))) return;
    running.current = true; setBusy(true); let signing = false, exchange, intent; const attempt = generation.current;
    try {
      assertNoUnresolved(localStorage,account);
      let provider,markets,market;
      if (kind === 'approval' || kind === 'revoke') { provider=window.ethereum; await identity(provider,account); }
      else ({provider,markets,market}=await setup(kind === 'order' ? symbol : 'BTC',kind === 'order'));
      exchange = markets;
      let call, orderEvidence;
      if (kind === 'claim') {
        const eligibility = await markets.client.getPerpVoucherEligibility(market.marginBank,account);
        if (!eligibility.eligible) throw Error(eligibility.reason === 'alreadyClaimed' ? 'This wallet has already claimed its paper credit.' : 'This wallet cannot claim paper credit right now. Check its positions, funding and campaign availability.');
        call = await markets.trader.buildClaimPerpVoucher({marginBank:market.marginBank});
      } else if (kind === 'approval' || kind === 'revoke') {
        const rpc=createPublicClient({chain:hidekiTestnet,transport:custom(provider)});
        const [allowance,balance,decimals]=await Promise.all([
          rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'allowance',args:[account,BANK]}),
          rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'balanceOf',args:[account]}),
          rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'decimals'})
        ]);
        if (decimals!==18) throw Error('Collateral precision could not be verified.');
        if (kind==='approval' && balance<ALLOWANCE_CAP) throw Error('At least 20 USDso in this wallet is required to set this permission.');
        if (kind==='approval' && allowance!==0n) throw Error('The wallet already has a MarginBank permission. Review it before changing the amount.');
        if (kind==='revoke' && allowance===0n) throw Error('This wallet has no MarginBank permission to revoke.');
        const amount=kind==='revoke'?0n:ALLOWANCE_CAP;
        call={chainId:50383,to:COLLATERAL,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[BANK,amount]}),value:0n};
        orderEvidence={spender:BANK,approvalAmount:String(amount),previousAllowance:String(allowance)};
      } else {
        if (!quote || quote.symbol!==symbol || quote.amount!==quantity || quote.pool.toLowerCase()!==market.poolAddress.toLowerCase() || quote.baseDecimals!==market.baseDecimals || quote.quoteDecimals!==market.quoteDecimals || quoteSecondsRemaining(quote,Date.now())===0) throw Error('Review a fresh quote before sending.');
        const p=BigInt(quote.price), q=exactUnits(quote.amount,market.baseDecimals);
        orderEvidence = {pool:market.poolAddress,baseline:'0',quantity:String(q),price:String(p),baseDecimals:market.baseDecimals,symbol};
        call = (await markets.trader.buildPlacePerpOrder({pool:market.poolAddress,isBid:true,price:p,quantity:q,orderType:2})).order;
      }
      await identity(provider,account);
      assertAttempt(generation,attempt);
      // Record intent before the wallet request: a lost response must not be retried blindly.
      if (!call || call.chainId !== 50383 || !call.to || !call.data) throw Error('The transaction could not be prepared safely.');
      if (call.to.toLowerCase() !== (kind === 'claim' ? DISTRIBUTOR : (kind === 'approval' || kind === 'revoke') ? COLLATERAL : market.poolAddress.toLowerCase()) || (call.value || 0n) !== 0n) throw Error('Transaction target could not be verified.');
      const txRequest = {from:account,to:call.to,data:call.data,value:'0x0'};
      const [estimateHex,priceHex,balanceHex] = await Promise.all([
        provider.request({method:'eth_estimateGas',params:[txRequest]}),
        provider.request({method:'eth_gasPrice'}),
        provider.request({method:'eth_getBalance',params:[account,'latest']})
      ]);
      const gasLimit = bufferedGas(estimateHex,priceHex,balanceHex);
      if (kind === 'approval' || kind === 'revoke') {
        const rpc=createPublicClient({chain:hidekiTestnet,transport:custom(provider)});
        if (await rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'allowance',args:[account,BANK]}) !== BigInt(orderEvidence.previousAllowance)) throw Error('Wallet permission changed. Review it before continuing.');
      }
      if (kind === 'order') {
        if (!quote || quoteSecondsRemaining(quote,Date.now())===0) throw Error('Quote expired. Refresh it before sending.');
        const checked=await orderInputs(provider,markets,market,quantity,BigInt(quote.price),BigInt(quote.allowance));
        if (checked.price!==BigInt(orderEvidence.price) || checked.quantity!==BigInt(orderEvidence.quantity)) throw Error('Order no longer matches the reviewed quote. Refresh it before sending.');
        if (quoteSecondsRemaining(quote,Date.now())===0) throw Error('Quote expired. Refresh it before sending.');
      }
      await identity(provider,account); assertAttempt(generation,attempt);
      if (kind === 'order' && quoteSecondsRemaining(quote,Date.now())===0) throw Error('Quote expired. Refresh it before sending.');
      intent = {kind,unknown:true,to:call.to,data:call.data,value:String(call.value || 0n),...orderEvidence};
      saveVerified(localStorage,key(account),intent);
      setPending(intent);
      try { beforeWalletRequest(sessionSignal,generation,attempt,localStorage,key(account),intent); }
      catch(e) { try { if (localStorage.getItem(key(account))===null) setPending(null); } catch {} throw e; }
      signing = true; setMessage('Approve in your wallet. The result will be checked before another attempt.');
      const hash = await provider.request({method:'eth_sendTransaction',params:[{...txRequest,gas:`0x${gasLimit.toString(16)}`}]});
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error('Wallet did not return a valid transaction hash.');
      const record = {...intent,unknown:false,hash};
      try { persistHash(localStorage,sessionStorage,key(account),record); } catch { if (generation.current === attempt) { setPending(record); setMessage(`Transaction ${hash} was submitted, but recovery storage failed. Save the hash and check your wallet before retrying.`); } return; }
      if (generation.current !== attempt) return;
      setPending(record);
      setMessage('Submitted. Check the receipt before taking another action.');
    } catch(e) {
      if (signing && intent && definiteRejection(e) && generation.current === attempt) {
        try { removeMatching(localStorage,key(account),intent); setPending(null); setMessage('Wallet request was rejected. Nothing was submitted.'); return; } catch {}
      }
      if (generation.current === attempt) setMessage(signing ? 'The outcome is unknown. Check your wallet activity before retrying.' : (e?.message || 'Unable to prepare the request.'));
    } finally { try { await exchange?.close(); } catch {} running.current = false; if (generation.current === attempt) setBusy(false); }
  }
  async function lockedSubmit(kind) {
    try { await withWalletLock(navigator.locks,actionLockKey(account),() => submit(kind)); }
    catch(e) { setMessage(e?.message || 'Unable to coordinate this request.'); }
  }
  async function check() {
    if (!pending?.hash) { setMessage('The wallet did not return a transaction hash. Check its activity and do not submit again until resolved.'); return; }
    if (running.current) return; running.current = true; setBusy(true); const attempt = generation.current;
    try {
      const savedRaw=localStorage.getItem(key(account));
      const saved=JSON.parse(savedRaw || 'null');
      if (!saved || saved.to !== pending.to || saved.data !== pending.data || (saved.hash && saved.hash.toLowerCase() !== pending.hash.toLowerCase())) throw Error('Saved request changed');
      await identity(window.ethereum,account);
      const receipt = await window.ethereum.request({method:'eth_getTransactionReceipt',params:[pending.hash]});
      if (!receipt) { setMessage('Transaction is still pending or its outcome is unknown.'); return; }
      const tx = await window.ethereum.request({method:'eth_getTransactionByHash',params:[pending.hash]});
      if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx.blockHash || '') || tx.from?.toLowerCase() !== account.toLowerCase() || tx.to?.toLowerCase() !== pending.to?.toLowerCase() || tx.input?.toLowerCase() !== pending.data?.toLowerCase() || BigInt(tx.value) !== BigInt(pending.value) || receipt.transactionHash?.toLowerCase() !== pending.hash.toLowerCase() || receipt.from?.toLowerCase() !== account.toLowerCase() || receipt.to?.toLowerCase() !== pending.to?.toLowerCase() || tx.blockHash?.toLowerCase() !== receipt.blockHash?.toLowerCase() || (tx.chainId && BigInt(tx.chainId) !== 50383n)) { setMessage('Transaction details could not be verified. Do not submit again.'); return; }
      await identity(window.ethereum,account); if (generation.current !== attempt) return;
      if ((pending.kind==='approval' || pending.kind==='revoke') && (!validApprovalIntent(pending,COLLATERAL,BANK,pending.kind==='revoke'?0n:ALLOWANCE_CAP) || tx.hash?.toLowerCase()!==pending.hash.toLowerCase() || !tx.chainId || BigInt(tx.chainId)!==50383n)) { setMessage('The permission request could not be verified. Keep it locked.'); return; }
      if (receipt.status === '0x0') {
        if (pending.kind === 'order' && !revertedOrderReceipt(tx,receipt,pending,account)) { setMessage('The failed order receipt could not be matched. Keep this request locked.'); return; }
        saveVerified(localStorage,`${key(account)}:completed:${pending.hash}`,{...pending,receiptStatus:'reverted'});
        setMessage('Transaction failed on chain. No success is assumed.');
        removeMatching(localStorage,key(account),saved); sessionStorage.removeItem(`${key(account)}:hash-backup`); setPending(null); return;
      }
      if (receipt.status !== '0x1') { setMessage('Receipt status is unknown. Do not submit again.'); return; }
      if (pending.kind === 'claim') {
        const {markets,market} = await setup();
        let voucher; try { voucher = await markets.client.getPerpVoucher(market.marginBank,account); } finally { await markets.close(); }
        await identity(window.ethereum,account); if (generation.current !== attempt) return;
        if (!voucher?.claimed) { setMessage('Claim receipt confirmed, but credit state has not been verified. Check again.'); return; }
        saveVerified(localStorage,`${key(account)}:completed:${pending.hash}`,{...pending,receiptStatus:'success',creditFloor:String(voucher.floor),expiresAt:String(voucher.expiresAt)});
        removeMatching(localStorage,key(account),saved); sessionStorage.removeItem(`${key(account)}:hash-backup`); setPending(null);
        setMessage(`Credit claim confirmed for this account. Current paper credit floor: ${formatUnits(voucher.floor,18)} USDso.`); onRefresh?.(); return;
      }
      if (pending.kind === 'approval' || pending.kind === 'revoke') {
        const expected=pending.kind==='revoke'?0n:ALLOWANCE_CAP;
        if (!validApprovalIntent(pending,COLLATERAL,BANK,expected)) { setMessage('The permission request could not be verified. Keep it locked.'); return; }
        const rpc=createPublicClient({chain:hidekiTestnet,transport:custom(window.ethereum)});
        const head=await rpc.getBlockNumber();
        if (head<BigInt(receipt.blockNumber)) { setMessage('Permission state has not caught up yet. Check again.'); return; }
        const allowance=await rpc.readContract({address:COLLATERAL,abi:erc20Abi,functionName:'allowance',args:[account,BANK]});
        await identity(window.ethereum,account); if (generation.current!==attempt) return;
        if (allowance!==expected) { setMessage('The confirmed permission does not match the request. Keep it locked and review your wallet.'); return; }
        saveVerified(localStorage,`${key(account)}:completed:${pending.hash}`,{...pending,receiptStatus:'success',allowance:String(allowance)});
        removeMatching(localStorage,key(account),saved); sessionStorage.removeItem(`${key(account)}:hash-backup`); setPending(null);
        setMessage(expected===0n ? 'MarginBank wallet permission revoked.' : 'Permission confirmed: MarginBank may draw up to 20 USDso from this wallet.'); setFundsRevision(n=>n+1); onRefresh?.(); return;
      }
      const attribution = receiptOrder(receipt,pending,account);
      if (!attribution) { setMessage('The receipt does not establish a terminal fill for this order. Keep this request locked and check your wallet activity.'); return; }
      const snapshot = await readAccount(account);
      await identity(window.ethereum,account); if (generation.current !== attempt) return;
      if (!snapshot.complete || !isFresh(snapshot,performance.now()) || snapshot.gap>100n) { setMessage('Order confirmed, but your current position could not be verified. Check again.'); return; }
      if (snapshot.analyticsBlock < BigInt(receipt.blockNumber) || snapshot.margin.asOfBlock < BigInt(receipt.blockNumber)) { setMessage('Position data has not caught up with the transaction. Check again.'); return; }
      const row = snapshot.rows.find(r => r.pool.toLowerCase() === pending.pool.toLowerCase());
      const current = row?.size || 0n;
      const delta = current - BigInt(pending.baseline);
      if (current <= 0n || delta !== BigInt(attribution.filled)) { setMessage('A fill was confirmed, but the current position does not match it. Review your account before retrying.'); return; }
      const record = {...pending,receiptStatus:'success',...attribution,positionObserved:String(current),delta:String(delta)};
      const historyKey = `${key(account)}:completed:${pending.hash}`;
      const encoded = JSON.stringify(record); localStorage.setItem(historyKey,encoded);
      if (localStorage.getItem(historyKey) !== encoded) { setMessage('Fill verified, but the recovery record could not be saved. Do not submit again.'); return; }
      removeMatching(localStorage,key(account),saved); sessionStorage.removeItem(`${key(account)}:hash-backup`); setPending(null);
      setMessage(`The order filled ${formatUnits(BigInt(attribution.filled),pending.baseDecimals)} of ${formatUnits(BigInt(attribution.requested),pending.baseDecimals)} ${pending.symbol}. Your account has been refreshed.`);
      setFundsRevision(n=>n+1); onRefresh?.();
    } catch { if (generation.current === attempt) setMessage('Could not check the receipt. The transaction remains unresolved.'); } finally { running.current = false; if (generation.current === attempt) setBusy(false); }
  }
  async function lockedCheck() { try { await withWalletLock(navigator.locks,actionLockKey(account),check); } catch(e) { setMessage(e?.message || 'Unable to coordinate this request.'); } }
  async function importHash() {
    try { await withWalletLock(navigator.locks,actionLockKey(account),async()=>{
      if (!/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)) throw Error('Enter a valid transaction hash from your wallet activity.');
      const saved=JSON.parse(localStorage.getItem(key(account)) || 'null');
      if (!saved?.unknown || !saved.to || !saved.data) throw Error('No unresolved request is available for this wallet.');
      const record={...saved,unknown:false,hash:recoveryHash};
      persistHash(localStorage,sessionStorage,key(account),record); setPending(record); setMessage('Hash saved. Check the transaction to verify it matches the original request.');
    }); } catch(e) { setMessage(e?.message || 'Unable to save the transaction hash.'); }
  }
  return <section>
    <h2>Wallet funds and permissions</h2>
    {funds ? funds.error ? <p role="status">Wallet USDso balance is unavailable. Reconnect and try again.</p> : <p>Wallet balance: <strong>{formatUnits(funds.balance,18)} USDso</strong> | MarginBank permission: <strong>{formatUnits(funds.allowance,18)} USDso</strong> <button className="secondary" onClick={()=>setFundsRevision(n=>n+1)}>Refresh balance</button></p> : <p role="status">Checking wallet balance...</p>}
    {pending && <><button disabled={busy} onClick={lockedCheck}>Check transaction</button>{!pending.hash && <><label>Transaction hash from wallet activity<input value={recoveryHash} onChange={e=>setRecoveryHash(e.target.value)} /></label><button disabled={busy} onClick={importHash}>Use transaction hash</button></>}</>}
    <h3>Set a wallet spending limit</h3><p>Allow MarginBank to draw up to 20 USDso from this wallet for testnet positions. The permission persists until spent, changed or revoked. It does not open a position. Approval and revocation each require a wallet transaction.</p>
    <button disabled={!ORDER_ENABLED || busy || !!pending || !funds || !!funds.error || funds.allowance!==0n || funds.balance<ALLOWANCE_CAP} onClick={()=>lockedSubmit('approval')}>Approve up to 20 USDso</button>
    <button className="secondary" disabled={!ORDER_ENABLED || busy || !!pending || !funds || !!funds.error || funds.allowance===0n} onClick={()=>lockedSubmit('revoke')}>Revoke wallet permission</button>
    {canOpen ? <><h3>Open a small test position</h3><p>Review a live price, then confirm the order in Rabby. A successful wallet transaction may still have no fill; Forsee will verify the resulting position.</p><p>A long position can lose value. The order executes immediately up to the reviewed maximum price and may fill only partly. The maximum order value is 100 USDso. The pool may draw approved USDso from your wallet if account collateral is insufficient.</p>
    <label>Market<select disabled={!ORDER_ENABLED || busy || !!pending} value={symbol} onChange={e=>{const next=e.target.value;gridGeneration.current++;setSymbol(next);setQuantity(preferredAmount(next,null,edits.current));setGrid(null);setQuote(null);}}><option>BTC</option><option>ETH</option></select></label>
    <label>Amount ({symbol})<input disabled={!ORDER_ENABLED || busy || !!pending} value={quantity} onChange={e=>{edits.current[symbol]=e.target.value;setQuantity(e.target.value);setQuote(null);}} inputMode="decimal" /></label>
    {!grid ? <p role="status">Checking the market minimum and size step...</p> : grid.error ? <p role="status">Market size rules are unavailable. Reconnect and try again.</p> : <p>Market minimum: {grid.min} {symbol}; size step: {grid.lot} {symbol}.{grid.suggested===null && ' The minimum is above this tool’s size limit.'}</p>}
    <button disabled={!ORDER_ENABLED || busy || !!pending || !grid || grid.error || grid.suggested===null} onClick={previewOrder}>Review price</button>
    {quote && <><p>Buy up to {quote.amount} {quote.symbol}, at no more than {formatUnits(BigInt(quote.price),quote.quoteDecimals)} USDso per {quote.symbol}. Quote {quoteSecondsRemaining(quote,quoteNow) > 0 ? `expires in ${quoteSecondsRemaining(quote,quoteNow)} seconds` : 'expired; refresh the price before continuing'}. Estimated wallet draw: {formatUnits(BigInt(quote.ownWalletPull),18)} USDso. Your current MarginBank allowance is {formatUnits(BigInt(quote.allowance),18)} USDso; the actual draw may change before execution, up to that allowance.</p><button disabled={!ORDER_ENABLED || busy || !!pending || quoteSecondsRemaining(quote,quoteNow)===0} onClick={()=>lockedSubmit('order')}>Open {quote.symbol} long</button></>}
    </> : <p role="status">{positionKnown ? 'You already have an open position. Explore its risk and review a protective stop above; opening another position is unavailable here.' : 'Opening a position is paused until a fresh, complete account check confirms there are no open positions.'}</p>}
    <details><summary>About paper test credit</summary><p>The current dreamDEX distributor rejects direct claims even when its SDK reports eligibility. No claim transaction is available here right now.</p></details>
    <p role="status">{message}</p>
  </section>;
}

