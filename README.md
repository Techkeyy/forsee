# Forsee

Forsee helps dreamDEX testnet traders inspect their account and explore how separate hypothetical BTC and ETH price moves would change mark PnL.

This is an experimental Somnia testnet build. Native stop registration, cancellation and permission review are implemented, but have not yet been proven with a real Rabby transaction and triggered fill. Connect a browser wallet on Somnia Hideki2 to load its current margin account and active positions. Refresh to fetch a new snapshot. Other active markets are held at their current marks in the hypothetical calculation. The calculation is not future account health or a liquidation prediction; funding, fees, changing positions and maintenance requirements can change outcomes.

## Run locally

Requires Node.js and network access to the public Somnia testnet RPC and dreamDEX indexer.

```sh
npm ci
npm run doctor
npm run dev
```

Open the local URL printed by Vite. `npm run build` creates the production bundle. The doctor is read-only and verifies network identity, market discovery and bank configuration. Its dated evidence is in [scripts/doctor-results.md](scripts/doctor-results.md).

## What is available

- Wallet address connection and network identity checks using chain ID, network ID and genesis block hash.
- Native protective-stop review, registration and cancellation controls, transaction recovery, and operator-permission review. These write paths require browser-wallet approval and still need live end-to-end verification; a registration receipt does not prove a fill.
- On-chain account health and active-position analytics, with separate snapshot block numbers and an explicit refresh.
- An illustrative BTC/ETH mark PnL change and buffer, holding maintenance and funding fixed. The estimate is withheld if any active position cannot be priced or identified, if snapshots differ by more than 100 blocks, or when source-block age plus elapsed read time exceeds 30 seconds. This cutoff is a freshness heuristic, not a guarantee.

## Limits and open gates

The app can submit native stop and cancel transactions, but live wallet and outcome tests are pending. It cannot settle a market order itself. A native immediate reduce-only order has not been verified. A successful receipt and actual fill must be demonstrated before reporting a reduction. Scenario results do not adjust maintenance, funding, fees or other positions. Account and position reads are independently pinned and can sample different blocks. Browser-wallet end-to-end testing, deployment, real order/fill evidence and final user acceptance remain outstanding. The testnet developer guide is [here](https://app.testnet.dreamdex.io/docs/developers/perps-testnet).



