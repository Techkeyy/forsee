# Forsee

[Landing page](https://forsee-dreamdex-testnet.onrender.com/) · [Open risk terminal](https://forsee-dreamdex-testnet.onrender.com/app.html) · [Source repository](https://github.com/Techkeyy/forsee)

Forsee helps dreamDEX testnet traders inspect their account and explore how simultaneous hypothetical BTC and ETH price moves could change mark PnL and the margin buffer.

> “What might happen to my account if both markets move against me?”

Forsee is an experimental Somnia Hideki2 testnet build. Its scenario is illustrative, not a liquidation forecast. Funding, fees, maintenance requirements, other positions and market movements can change the outcome.

## What you can inspect

1. **Connect** an injected browser wallet and verify the network using chain ID, network ID and genesis block hash.
2. **Read** the connected account's margin health and active positions. Refresh obtains new snapshots; their block numbers can differ.
3. **Explore** independent hypothetical BTC and ETH price moves. Other active markets remain at their current marks; maintenance and funding are held fixed. The estimate is withheld when the inputs are incomplete or stale.
4. **Prepare a small trade** with a bounded USDso allowance and live BTC/ETH market size rules. The order UI is enabled for controlled testnet use; a real fill was observed through the local Forsee browser UI, while the deployed browser-wallet path remains unverified.
5. **Review** native protective stop terms and permissions for an existing position. The stop is conditional: registration alone is neither a fill nor proof of reduced exposure.

## Current status and limits

A disposable Rabby wallet was connected and network-verified on Hideki2. It held 100 USDso in the wallet, 50 STT, and zero perps margin before trading. Forsee submitted and verified a 20 USDso MarginBank approval; the independent on-chain receipt is [0x9ad81b...ff99fa1](https://explorer.testnet.somnia.network/tokyo/tx/0x9ad81b938164a796327e049aca8b3c56a1d3584ae5e5478d2578f3e47ff99fa1). The current local suite passes 51 tests and a production build. The Render static site serves the landing page at `/` and the risk terminal at `/app.html` from commit `ffe30c3`; a deployed browser-wallet trade and fill are not yet proven.

The in-app paper-credit claim is disabled: the distributor reverted in a direct call even though the SDK reported eligibility. A bounded collateral approval was verified in the browser and on chain. Using a disposable Rabby wallet (EOA `0xCc67779F8eDb2C80DC665775C5597657C512FE1A`), the user clicked Open BTC long and Check transaction in the local Forsee browser UI on Hideki2 (chain ID 50383). The app reported a full fill of a 0.00013 BTC IOC long against pool `0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0`. Transaction `0x712f73202da5b05791da27a3825349707e6918ac4b08fbd165636613783757ea` had a successful receipt in block 36227336. Protocol completed-order history reported `Filled`, with `fullQuantity` 13000, `filledQuantity` 13000 and `quantityRemaining` 0; the account position reported size 13000 with 8 base decimals. The receipt, completed-order history and position were independently verified; the deployed app connected-wallet trade flow remains unverified. Native stop registration, cancellation and permission controls are implemented, but live wallet registration, trigger, fill, cancellation and revocation have not been verified. The [public risk terminal](https://forsee-dreamdex-testnet.onrender.com/app.html) is deployed; connected-wallet UAT on that URL and the demo video remain pending. Do not treat a transaction receipt or a pending stop as a filled order.

The account and position snapshots may be from different blocks. Forsee withholds the illustrative estimate for incomplete or unpriceable positions, snapshots more than 100 blocks apart, or data older than its 30-second freshness heuristic. The heuristic does not guarantee freshness. The calculation is not an exact future account-health or liquidation prediction.

## Run locally

Requires Node.js, an injected browser wallet, and network access to the public Hideki2 RPC and dreamDEX indexer. A connected account with positions is needed to explore position-dependent results. Testnet STT pays transaction gas; a stop also requires prepaid trigger gas. Never put a private key or recovery phrase in the app.

```sh
git clone https://github.com/Techkeyy/forsee.git
cd forsee
npm ci
npm run doctor
npm run dev
```

Open the local URL printed by Vite for the landing page, or its `/app.html` route for the risk terminal; connect the wallet and switch to Somnia Hideki2 if needed. The doctor is read-only; it checks network identity, market discovery and bank configuration. Run `npm test` for the local tests and `npm run build` for the production bundle. Network and market data can change; a passing doctor is not proof of order execution.

## How it is built

| Module | Job |
| --- | --- |
| `src/account.js` | Reads positions, account health and scenario inputs. |
| `src/Onboard.jsx` | Reads wallet USDso and allowance, prepares bounded approval/revocation and a small opening order; direct voucher claiming is disabled. |
| `src/StopReview.jsx` | Presents protective-stop review and controls. |
| `src/stop-read.js` | Reads stop registry and status information. |
| `src/stop-write.js` | Prepares native stop transaction operations. |
| `src/PermissionReview.jsx` | Presents operator-permission review and controls. |
| `scripts/doctor.mjs` | Checks the configured network and market integration. |

The app uses React, Vite, viem and `@somnia-chain/markets-sdk` 0.32.1. See the [dreamDEX testnet developer guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet) for the protocol and network details.

## X posts

The required 2 or 3 posts tagging @DreamDEXSomnia have not yet been published. Their real links will be added here after publication.



