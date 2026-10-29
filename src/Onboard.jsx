import React, {useState, useEffect, useRef} from 'react';
import {SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES} from '@somnia-chain/markets-sdk';
import {hidekiTestnet} from '@somnia-chain/markets-sdk/chains';
import {createWalletClient, createPublicClient, custom, parseUnits, formatUnits} from 'viem';
import {readAccount} from './account.js';
import {withAccountLock} from './wallet-lock.js';
import {receiptOrder, assertAttempt, saveVerified, bufferedGas, persistHash, definiteRejection, removeMatching} from './onboard-reconcile.js';

const CLAIM_ENABLED = true;
const ORDER_ENABLED = false;
const GENESIS = '0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25';
const BANK = '0x478769e1177c0773c43a593dccc4ad15f15f1394';
const COLLATERAL = '0xed7993a74dae1e6656b704a424dcd8711aaf4f72';
const DISTRIBUTOR = '0x2acd9efda721450906bfe1bef3ede269636e42c4';
const bookAbi = [{type:'function',name:'getOrderBookParameters',stateMutability:'view',inputs:[],outputs:[{type:'tuple',components:[{name:'tickSize',type:'uint256'},{name:'minQuantity',type:'uint256'},{name:'lotSize',type:'uint256'}]}]}];
const key = account => `forsee-onboard:${account.toLowerCase()}`;

async function identity(provider, account) {
  const [accounts, chain, network, genesis, code] = await Promise.all([
    provider.request({method:'eth_accounts'}), provider.request({method:'eth_chainId'}),
    provider.request({method:'net_version'}), provider.request({method:'eth_getBlockByNumber',params:['0x0',false]}), provider.request({method:'eth_getCode',params:[account,'latest']})
  ]);
  if (accounts[0]?.toLowerCase() !== account.toLowerCase() || chain !== '0xc4cf' || network !== '50000259' || genesis?.hash?.toLowerCase() !== GENESIS) throw Error('Wallet account or network changed. Reconnect before continuing.');
  if (code !== '0x') throw Error('This setup currently supports externally owned accounts only.');
}

export default function Onboard({account, onRefresh, sessionSignal}) {
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('0.001');
  const [message, setMessage] = useState('');
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
  async function setup() {
    const provider = window.ethereum;
    if (!provider) throw Error('Browser wallet unavailable.');
    await identity(provider, account);
    const walletClient = createWalletClient({account,chain:hidekiTestnet,transport:custom(provider)});
    const markets = new SomniaMarkets({chain:hidekiTestnet,indexerUrl:'https://hideki-dev.smk.somnia.host/v1/graphql',addresses:SOMNIA_HIDEKI_TESTNET_ADDRESSES,walletClient});
    const rows = await markets.client.listPerpMarkets();
    const choices = rows.filter(m => m.baseSymbol === 'BTC' && m.marginBank?.toLowerCase() === BANK && m.quoteToken?.toLowerCase() === COLLATERAL);
    if (choices.length !== 1) throw Error('BTC market could not be verified. Try again later.');
    const config = await markets.client.getPerpSystemConfig(choices[0].marginBank);
    if (!config.fullyWired || config.collateralToken?.toLowerCase() !== COLLATERAL) throw Error('Market configuration could not be verified.');
    return {provider, markets, market:choices[0]};
  }
  async function submit(kind) {
    if (!(kind === 'claim' ? CLAIM_ENABLED : ORDER_ENABLED) || running.current || pending || localStorage.getItem(key(account))) return;
    running.current = true; setBusy(true); let signing = false, exchange, intent; const attempt = generation.current;
    try {
      const {provider,markets,market} = await setup();
      exchange = markets;
      let call, orderEvidence;
      if (kind === 'claim') {
        const eligibility = await markets.client.getPerpVoucherEligibility(market.marginBank,account);
        if (!eligibility.eligible) throw Error(eligibility.reason === 'alreadyClaimed' ? 'This wallet has already claimed its paper credit.' : 'This wallet cannot claim paper credit right now. Check its positions, funding and campaign availability.');
        call = await markets.trader.buildClaimPerpVoucher({marginBank:market.marginBank});
      } else {
        const exact = (v, d) => { if (!/^\d+(?:\.\d+)?$/.test(v) || (v.split('.')[1]?.length || 0) > d) throw Error('Enter an exact decimal value within the market precision.'); return parseUnits(v,d); };
        const p = exact(price,market.quoteDecimals), q = exact(quantity,market.baseDecimals);
        if (p <= 0n || q <= 0n || q > parseUnits('0.001',market.baseDecimals)) throw Error('Enter a positive price and a quantity no larger than 0.001 BTC.');
        const rpc = createPublicClient({chain:hidekiTestnet,transport:custom(provider)});
        const {tickSize,minQuantity,lotSize} = await rpc.readContract({address:market.poolAddress,abi:bookAbi,functionName:'getOrderBookParameters'});
        if (!tickSize || !lotSize || p % tickSize || q % lotSize || q < minQuantity) throw Error('Price or quantity does not match this market’s tick, lot, or minimum.');
        const max = await markets.client.getMaxPerpOrderSize({pool:market.poolAddress,marginBank:market.marginBank,account,isBid:true,price:p});
        if (!max.priceable || !max.placeable || q > max.maxQuantity) throw Error(`Order unavailable or too large: ${max.limitedBy || 'market unavailable'}.`);
        const before = await readAccount(account);
        if (!before.complete) throw Error('Cannot verify your existing positions. Refresh and try again.');
        const baseline = before.rows.find(row => row.pool.toLowerCase() === market.poolAddress.toLowerCase())?.size || 0n;
        orderEvidence = {pool:market.poolAddress,baseline:String(baseline),quantity:String(q),price:String(p),baseDecimals:market.baseDecimals};
        call = (await markets.trader.buildPlacePerpOrder({pool:market.poolAddress,isBid:true,price:p,quantity:q,orderType:2})).order;
      }
      await identity(provider,account);
      assertAttempt(generation,attempt);
      // Record intent before the wallet request: a lost response must not be retried blindly.
      if (!call || call.chainId !== 50383 || !call.to || !call.data) throw Error('The transaction could not be prepared safely.');
      if (call.to.toLowerCase() !== (kind === 'claim' ? DISTRIBUTOR : market.poolAddress.toLowerCase()) || (call.value || 0n) !== 0n) throw Error('Transaction target could not be verified.');
      const txRequest = {from:account,to:call.to,data:call.data,value:'0x0'};
      const [estimateHex,priceHex,balanceHex] = await Promise.all([
        provider.request({method:'eth_estimateGas',params:[txRequest]}),
        provider.request({method:'eth_gasPrice'}),
        provider.request({method:'eth_getBalance',params:[account,'latest']})
      ]);
      const gasLimit = bufferedGas(estimateHex,priceHex,balanceHex);
      await identity(provider,account); assertAttempt(generation,attempt);
      intent = {kind,unknown:true,to:call.to,data:call.data,value:String(call.value || 0n),...orderEvidence};
      saveVerified(localStorage,key(account),intent);
      setPending(intent);
      assertAttempt(generation,attempt);
      if(sessionSignal?.aborted){removeMatching(localStorage,key(account),intent);setPending(null);throw Error('Session disconnected before the wallet request.');}
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
    try { await withAccountLock(navigator.locks,account,() => submit(kind)); }
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
      if (receipt.status === '0x0') {
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
      const attribution = receiptOrder(receipt,pending,account);
      if (!attribution) { setMessage('The receipt does not establish a terminal fill for this order. Keep this request locked and check your wallet activity.'); return; }
      const snapshot = await readAccount(account);
      await identity(window.ethereum,account); if (generation.current !== attempt) return;
      if (!snapshot.complete) { setMessage('Order confirmed, but your position could not be verified. Check again.'); return; }
      if (snapshot.analyticsBlock < BigInt(receipt.blockNumber) || snapshot.margin.asOfBlock < BigInt(receipt.blockNumber)) { setMessage('Position data has not caught up with the transaction. Check again.'); return; }
      const row = snapshot.rows.find(r => r.pool.toLowerCase() === pending.pool.toLowerCase());
      const current = row?.size || 0n;
      const delta = current - BigInt(pending.baseline);
      const record = {...pending,receiptStatus:'success',...attribution,positionObserved:String(current),delta:String(delta)};
      const historyKey = `${key(account)}:completed:${pending.hash}`;
      const encoded = JSON.stringify(record); localStorage.setItem(historyKey,encoded);
      if (localStorage.getItem(historyKey) !== encoded) { setMessage('Fill verified, but the recovery record could not be saved. Do not submit again.'); return; }
      removeMatching(localStorage,key(account),saved); sessionStorage.removeItem(`${key(account)}:hash-backup`); setPending(null);
      setMessage(`The order filled ${formatUnits(BigInt(attribution.filled),pending.baseDecimals)} of ${formatUnits(BigInt(attribution.requested),pending.baseDecimals)} BTC. Your account has been refreshed; its current position may include other activity.`);
      onRefresh?.();
    } catch { if (generation.current === attempt) setMessage('Could not check the receipt. The transaction remains unresolved.'); } finally { running.current = false; if (generation.current === attempt) setBusy(false); }
  }
  async function lockedCheck() { try { await withAccountLock(navigator.locks,account,check); } catch(e) { setMessage(e?.message || 'Unable to coordinate this request.'); } }
  async function importHash() {
    try { await withAccountLock(navigator.locks,account,async()=>{
      if (!/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)) throw Error('Enter a valid transaction hash from your wallet activity.');
      const saved=JSON.parse(localStorage.getItem(key(account)) || 'null');
      if (!saved?.unknown || !saved.to || !saved.data) throw Error('No unresolved request is available for this wallet.');
      const record={...saved,unknown:false,hash:recoveryHash};
      persistHash(localStorage,sessionStorage,key(account),record); setPending(record); setMessage('Hash saved. Check the transaction to verify it matches the original request.');
    }); } catch(e) { setMessage(e?.message || 'Unable to save the transaction hash.'); }
  }
  return <section><h2>Claim testnet credit</h2><p>Eligible wallets can claim paper USDso for testnet perps. Your wallet will ask you to approve a transaction, which uses testnet STT for gas.</p><button disabled={!CLAIM_ENABLED || busy || !!pending} onClick={() => lockedSubmit('claim')}>Claim paper USDso</button>{pending && <><button disabled={busy} onClick={lockedCheck}>Check transaction</button>{!pending.hash && <><label>Transaction hash from wallet activity<input value={recoveryHash} onChange={e=>setRecoveryHash(e.target.value)} /></label><button disabled={busy} onClick={importHash}>Use transaction hash</button></>}</>}<p role="status">{message}</p></section>;
}
