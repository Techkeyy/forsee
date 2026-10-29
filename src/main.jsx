import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import StopReview from './StopReview.jsx';
import StopRecovery from './StopRecovery.jsx';
import PermissionReview from './PermissionReview.jsx';
import Onboard from './Onboard.jsx';
import {shouldShowRecovery} from './stop-attempt.js';
import { readAccount, decimal, shockPnl, scenarioBuffer, signedDecimal, createGeneration, guardedRequest, isFresh, compatibleMarket } from './account.js';

function App() {
  const generation = useRef(createGeneration()).current;
  const session = useRef(new AbortController());
  const [account, setAccount] = useState('');
  const [chain, setChain] = useState('');
  const [networkVerified, setNetworkVerified] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [btcShock, setBtcShock] = useState('-10');
  const [ethShock, setEthShock] = useState('-10');
  const [now, setNow] = useState(performance.now());
  useEffect(() => { const timer = setInterval(() => setNow(performance.now()), 1000); return () => clearInterval(timer); }, []);
  const wallet = window.ethereum;
  useEffect(() => {
    if (!wallet?.on) return;
    const accounts = () => { session.current.abort(); generation.invalidate(); setBusy(false); setSnapshot(null); setLoading(false); setAccount(''); setNetworkVerified(false); setMessage('Wallet changed. Reconnect to check the selected account.'); };
    const network = c => { session.current.abort(); generation.invalidate(); setBusy(false); setSnapshot(null); setLoading(false); setChain(c); setAccount(''); setNetworkVerified(false); setMessage('Network changed. Reconnect to check the selected account.'); };
    wallet.on('accountsChanged', accounts); wallet.on('chainChanged', network);
    return () => { wallet.removeListener?.('accountsChanged', accounts); wallet.removeListener?.('chainChanged', network); };
  }, [wallet]);
  useEffect(() => {
    if (!account || !networkVerified) { setSnapshot(null); setReadError(false); return; }
    let active = true; const readToken = generation.invalidate(); setLoading(true);
    readAccount(account).then(value => { if(active && generation.current(readToken)) { setSnapshot(value); setReadError(false); setNow(performance.now()); setMessage(previous => previous === 'Wallet network verified. Loading your account.' || previous === 'Account data could not be loaded. Retry the account before opening another position.' ? 'Account updated.' : previous); } }).catch(() => { if(active && generation.current(readToken)) { setReadError(true); setMessage('Account data could not be loaded. Retry the account before opening another position.'); } }).finally(() => { if(active && generation.current(readToken)) setLoading(false); });
    return () => { active = false; };
  }, [account, networkVerified, refresh]);
  async function connect() {
    if (!wallet) { setMessage('No browser wallet was found. Install or open a compatible wallet, then try again.'); return; }
    session.current.abort(); session.current = new AbortController();
    const token = generation.invalidate();
    setBusy(true); setMessage('Waiting for your wallet to connect.');
    try {
      const addresses = await guardedRequest(wallet, generation, token, { method: 'eth_requestAccounts' });
      const id = await guardedRequest(wallet, generation, token, { method: 'eth_chainId' });
      setAccount(addresses[0] || ''); setChain(id);
      if (!addresses.length) { setMessage('No account was selected.'); return; }
      if (id !== '0xc4cf') { setNetworkVerified(false); setMessage('Switch your wallet to Somnia Hideki testnet, then reconnect.'); return; }
      try {
        const networkId = await guardedRequest(wallet, generation, token, { method: 'net_version' });
        const genesis = await guardedRequest(wallet, generation, token, { method: 'eth_getBlockByNumber', params: ['0x0', false] });
        const latestAccounts = await guardedRequest(wallet, generation, token, { method: 'eth_accounts' });
        const latestChain = await guardedRequest(wallet, generation, token, { method: 'eth_chainId' });
        const verified = latestAccounts[0]?.toLowerCase() === addresses[0]?.toLowerCase() && latestChain === id && networkId === '50000259' && genesis?.hash?.toLowerCase() === '0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25';
        setNetworkVerified(verified);
        setMessage(verified ? 'Wallet network verified. Loading your account.' : 'This wallet network does not match the current Somnia testnet. Check your wallet network settings.');
      } catch { if (!generation.current(token)) return; setNetworkVerified(false); setMessage('Could not verify your wallet network. Check your wallet connection and reconnect.'); }
    } catch (e) { if (!generation.current(token)) return; setMessage(e?.code === 4001 ? 'Connection was cancelled. Nothing changed.' : 'Could not connect your wallet. Please try again.'); }
    finally { if (generation.current(token)) setBusy(false); }
  }
  async function switchNetwork() {
    if (!wallet) { setMessage('No browser wallet was found. Install or open a compatible wallet, then try again.'); return; }
    // Invalidate the active session before opening a wallet prompt. A pending write
    // must not proceed while the user changes networks.
    session.current.abort();
    const token = generation.invalidate();
    setAccount(''); setNetworkVerified(false); setSnapshot(null); setLoading(false);
    setBusy(true); setMessage('Check your wallet to switch networks.');
    try {
      const current = await guardedRequest(wallet, generation, token, {method:'eth_chainId'});
      if (current === '0xc4cf') {
        setMessage('Your wallet already uses this chain ID, but its network identity could not be verified. Edit or remove the conflicting network in your wallet, then reconnect.');
        return;
      }
      try { await guardedRequest(wallet, generation, token, {method:'wallet_switchEthereumChain',params:[{chainId:'0xc4cf'}]}); }
      catch (error) {
        if (!generation.current(token)) return;
        if (error?.code !== 4902) throw error;
        await guardedRequest(wallet, generation, token, {method:'wallet_addEthereumChain',params:[{chainId:'0xc4cf',chainName:'Somnia Hideki2 Testnet',nativeCurrency:{name:'Somnia Test Token',symbol:'STT',decimals:18},rpcUrls:['https://api.hideki2.infra.testnet.somnia.network']}]});
        await guardedRequest(wallet, generation, token, {method:'wallet_switchEthereumChain',params:[{chainId:'0xc4cf'}]});
      }
      if (generation.current(token)) setMessage('Network switch requested. Reconnect to verify its identity before using Forsee.');
    } catch (error) { if (generation.current(token)) setMessage(error?.code === 4001 ? 'Network switch cancelled. Nothing changed.' : 'Could not switch networks. Check your wallet settings and try again.'); }
    finally { if (generation.current(token)) setBusy(false); }
  }
  function disconnect() { session.current.abort(); generation.invalidate(); setBusy(false); setLoading(false); setSnapshot(null); setAccount(''); setChain(''); setNetworkVerified(false); setMessage('Disconnected from Forsee.'); }
  const fresh = !readError && !loading && isFresh(snapshot, now);
  const pnl = fresh && snapshot.complete && snapshot.gap <= 100n && snapshot.rows.length > 0 && btcShock !== '' && ethShock !== '' ? shockPnl(snapshot.rows, Number(btcShock), Number(ethShock)) : null;
  const buffer = snapshot && pnl !== null ? scenarioBuffer(snapshot.margin.equity, snapshot.margin.mmReq, pnl) : null;
  return <main><header><a className="brand" href="/">forsee<span>.</span></a><span className="network">SOMNIA TESTNET</span></header><section className="intro"><p className="eyebrow">DREAMDEX PERPS / TESTNET</p><h1>Know your exposure.<br />Plan your next move.</h1><p className="lede">See how a shared market move could affect your account, then review a protective stop for an existing position.</p><div className="notice"><strong>Built for testnet</strong><p>Scenario results are estimates. A stop is conditional and may not fill or prevent liquidation.</p></div></section><section className="workspace"><div className="heading"><div><p className="eyebrow">YOUR ACCOUNT</p><h2>{account ? 'Your account' : 'Start with your wallet'}</h2></div><span className="status">{account ? 'Connected' : 'Not connected'}</span></div><p>Connect the wallet you use for dreamDEX. Connecting shares your address and does not request a transaction.</p>{account && <div className="account"><span>Wallet</span><code>{account}</code><span>Network</span><strong>{networkVerified ? 'Somnia Hideki testnet verified' : chain === '0xc4cf' ? 'Network identity not verified' : 'Switch to Somnia Hideki testnet'}</strong></div>}<div className="actions">{account ? <button className="secondary" onClick={disconnect}>Disconnect</button> : <button onClick={connect} disabled={busy}>{busy ? 'Waiting for wallet...' : 'Connect wallet'}</button>}{account && !networkVerified && <button onClick={switchNetwork} disabled={busy}>{busy ? 'Waiting for wallet...' : 'Switch network'}</button>}</div><p className="feedback" role="status" aria-live="polite">{message}</p>{shouldShowRecovery(account,networkVerified) && <StopRecovery key={account} account={account} />}{loading && <p role="status">Loading your account and positions...</p>}{account && networkVerified && !loading && !snapshot && <div className="account-recovery" role="status"><p>Position status is unavailable. Opening another position is paused until your account can be checked.</p><button className="secondary" onClick={() => setRefresh(n => n + 1)}>Retry account</button></div>}{snapshot && <div className="results"><h2>Current account</h2><button className="secondary" onClick={() => setRefresh(n => n + 1)}>Refresh account</button>{!fresh ? <div role="status"><p>Account data is not current. The positions below are last known; refresh to see current health and positions.</p><div className="positions">{snapshot.rows.map(row => <div key={row.pool}><strong>{row.market?.baseSymbol || 'Unknown market'} {row.size > 0n ? 'long' : row.size < 0n ? 'short' : ''}</strong><span>{row.priceable && compatibleMarket(row.market) ? decimal(row.size, row.market.baseDecimals, 6) : 'Size unavailable'}</span><span>Last known</span></div>)}</div></div> : <><p>Equity: <strong>{decimal(snapshot.margin.equity, 18)} USDso</strong> | Maintenance: <strong>{decimal(snapshot.margin.mmReq, 18)} USDso</strong> | {snapshot.margin.marginStatus}</p><div className="buffer"><span>Current margin buffer</span><strong>{signedDecimal(snapshot.margin.equity - snapshot.margin.mmReq, 18)} USDso</strong><small>Equity minus maintenance, at the account snapshot below.</small></div><p>Account block {String(snapshot.margin.asOfBlock)}. Position block {String(snapshot.analyticsBlock)}. Account block time {new Date(Number(snapshot.marginTimestamp) * 1000).toLocaleTimeString()}.</p>{!snapshot.complete && <p role="status">Positions may be incomplete or use unsupported units. The estimate is unavailable.</p>}{snapshot.rows.length ? <div className="positions">{snapshot.rows.map(row => <div key={row.pool}><strong>{row.market?.baseSymbol || 'Unknown market'} {row.size > 0n ? 'long' : row.size < 0n ? 'short' : ''}</strong><span>{row.priceable && compatibleMarket(row.market) ? decimal(row.size, row.market.baseDecimals, 6) : 'Price unavailable'}</span><span>{row.priceable && compatibleMarket(row.market) ? decimal(row.markPrice, row.market.quoteDecimals, 4) + ' USDso mark' : 'Unavailable'}</span></div>)}</div> : snapshot.complete ? <p>No open positions were returned for this wallet. Wallet USDso is separate from perps margin. If you have testnet USDso, set the spending limit above, review a small order, and confirm it in your wallet. Then refresh to explore a price move or review a stop.</p> : <p>Positions are unavailable or incomplete. Refresh and try again.</p>}{snapshot.rows.length > 0 && <><h2>Explore a shared price move</h2><p>Choose separate hypothetical BTC and ETH price moves. All other positions are held at their current marks. The result estimates the change in mark PnL, not future account health or a liquidation prediction. Actual results can differ as prices, funding, fees, and positions change.</p><label htmlFor="btcShock">BTC move (%)</label><input id="btcShock" type="number" min="-100" max="1000" step="0.01" value={btcShock} onChange={e => setBtcShock(e.target.value)} /><label htmlFor="ethShock">ETH move (%)</label><input id="ethShock" type="number" min="-100" max="1000" step="0.01" value={ethShock} onChange={e => setEthShock(e.target.value)} />{buffer ? <div className="scenario-result" aria-live="polite"><p>Estimated BTC and ETH mark PnL change: <strong>{signedDecimal(pnl, 18)} USDso</strong></p><p>Illustrative buffer after this move: <strong>{signedDecimal(buffer.illustrative, 18)} USDso</strong></p><p>{buffer.illustrative <= 0n ? 'This illustrative buffer is at or below zero. Your account could be at risk under this scenario.' : 'This illustrative buffer remains above zero. It does not guarantee your account will remain safe.'}</p><p>Maintenance, funding and other market marks are held fixed for this illustration.</p></div> : <p role="status">Estimate unavailable. Refresh the account if the data is older than 30 seconds, a position is unavailable, the snapshots are too far apart, or an input is invalid.</p>}<p>Account and position data were read at different blocks. The estimate is withheld if the gap exceeds 100 blocks, a freshness heuristic rather than a guarantee. Changes between reads can affect this estimate. This view is not live-updating. Refresh to update it; the estimate expires after 30 seconds.</p></>}</>}{snapshot.complete && snapshot.rows.some(r => r.priceable && r.size !== 0n && ['BTC','ETH'].includes(r.market?.baseSymbol) && r.market?.stopRegistry) && <StopReview key={account} account={account} rows={snapshot.rows} sessionSignal={session.current.signal} />}</div>}{account && networkVerified && <Onboard key={account} account={account} sessionSignal={session.current.signal} canOpen={fresh && snapshot?.complete && snapshot.rows.length === 0} positionKnown={fresh && snapshot?.complete && snapshot.rows.length > 0} onRefresh={() => setRefresh(n => n + 1)} />}{shouldShowRecovery(account,networkVerified) && <details className="advanced"><summary>Advanced: registry permission and recovery</summary><p>Review or revoke registry permission even after a position closes. Revoking it can prevent existing stops from executing.</p><PermissionReview key={account} account={account} sessionSignal={session.current.signal} /></details>}</section><footer>Forsee is an experimental testnet project. Confirm each transaction in your wallet and check its result on chain.</footer></main>;
}

createRoot(document.getElementById('root')).render(<App />);


















