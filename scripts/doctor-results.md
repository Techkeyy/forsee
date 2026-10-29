# Read-only integration check

Run `npm ci` and `npm run doctor`. The script requires network access to the official public Hideki2 RPC and dreamDEX indexer. It never signs or sends transactions.

Observed 2026-10-27 16:38 UTC using markets SDK 0.32.1: RPC chain ID 50383, network ID 50000259 and genesis hash 0x555de6145260a388241bea0f9328d57335d330d5a0fbb329de1a4fd1c7f2eb25. SDK listPerpMarkets returned 21 markets, including BTC and ETH, all with bank 0x478769E1177C0773c43A593DCCc4Ad15F15F1394. getPerpSystemConfig returned fullyWired=true and collateral, factory, liquidation engine and insurance addresses matching the official developer guide. This is a dated snapshot; rerun the doctor for current results.

The check does not establish wallet compatibility, account positions, account health reconciliation, stress-model accuracy, order safety, fills, or a complete product journey.

Source: https://app.testnet.dreamdex.io/docs/developers/perps-testnet
