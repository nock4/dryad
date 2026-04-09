# Dryad: Arbitrum Migration Plan

Status: Draft
Last updated: 2026-04-08

## Why Arbitrum

- Full Green Goods compatibility (their platform runs on Arbitrum)
- Deeper DeFi liquidity for treasury management
- Morpho USDC vaults pulling 4-12% APY via curators like Steakhouse, Gauntlet, RE7
- Same EAS protocol, just different contract addresses
- Account abstraction via Pimlico for gasless contractor onboarding
- Hats Protocol for role-based access control (same address on every chain)


## Contract Addresses (Arbitrum One)

| Contract | Address |
|----------|---------|
| EAS | `0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458` |
| Schema Registry | `0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB` |
| Hats Protocol | `0x3bc1A0Ad72417f2d411118085256fC53CBdDd137` |
| Pimlico EntryPoint | ERC-4337 v0.7 (standard address) |


## Migration Phases

### Phase 1: Chain Swap (Small, Mostly Config)

What changes in `src/services/easAttestation.ts`:

1. Swap `base` / `baseSepolia` chain imports for `arbitrum` / `arbitrumSepolia` from viem
2. Update EAS contract addresses:
   - EAS: `0x4200...0021` -> `0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458`
   - Schema Registry: `0x4200...0020` -> `0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB`
3. Update `CHAIN` config in `src/config/constants.ts` to point at Arbitrum RPC
4. Update `.env` with Arbitrum RPC URL (Alchemy, QuickNode, or public)
5. Re-register both schemas on Arbitrum (they'll get new UIDs)
6. Update `CHAIN_USE_TESTNET` to use Arbitrum Sepolia instead of Base Sepolia
7. Update easscan URLs: `base.easscan.org` -> `arbitrum.easscan.org`
8. Update `SubmissionsPanel.tsx` easscan URL validation regex

Existing Base attestations stay on Base as historical records. They're permanent and still verifiable.

Estimated effort: 1-2 hours


### Phase 2: Hats Protocol Integration (Roles)

Replace the current model where the agent's wallet signs everything with role-gated attestations.

Roles to create in the Hats tree:
- **Top Hat**: Dryad DAO / multisig (admin)
- **Operator Hat**: Dryad agent wallet (can approve work, trigger attestations)
- **Evaluator Hat**: Future human reviewers (can override agent decisions)
- **Gardener Hat**: Contractors (can submit work, but not self-attest)

What to build:
1. Deploy a Hats tree on Arbitrum via `Hats.mintTopHat()`
2. Create child hats for each role
3. Write a resolver contract that checks the attester wears the Operator or Evaluator hat before allowing attestation
4. Register new schemas on Arbitrum pointing at this resolver (instead of zero-address)
5. Update `easAttestation.ts` to interact with the new resolver-backed schemas
6. Add a service to manage hat assignments (grant Gardener hat to new contractors)

Estimated effort: 1-2 weeks (includes Solidity, testing, deployment)


### Phase 3: Account Abstraction via Pimlico (Gasless UX)

Let contractors interact with the system without owning crypto.

Stack:
- **permissionless.js** (Pimlico's TypeScript SDK, built on viem)
- **Smart Accounts**: Each contractor gets a smart account created on first login
- **Paymaster**: Dryad sponsors all gas via Pimlico's verifying paymaster
- **Bundler**: Pimlico's bundler relays UserOperations on Arbitrum

What to build:
1. Sign up for Pimlico, get API key for Arbitrum bundler + paymaster
2. Integrate passkey or email-based auth (contractor signs in, smart account is created)
3. Wire up the paymaster so Dryad's treasury covers gas for contractor submissions
4. Assign Hats Gardener role to the contractor's smart account address
5. Update the submit portal to use UserOperations instead of direct transactions
6. Fund the paymaster contract from treasury

Contractor flow after this:
  Sign in with email/passkey -> smart account created -> Gardener hat assigned -> submit work -> photos verified by AI -> agent attests -> all gas paid by Dryad

Estimated effort: 2-3 weeks


### Phase 4: CIDS Schema Alignment (Green Goods Compatibility)

Restructure attestation data to follow the Common Impact Data Standard.

Current Dryad schemas are flat (all fields at one level). CIDS organizes data into four stages:

| Stage | What it captures | Dryad equivalent |
|-------|-----------------|------------------|
| Activity | What was done | workType, description |
| Output | Direct product | photoHash, visionScore |
| Outcome | Change produced | Not currently tracked |
| Impact | Long-term effect | Not currently tracked |

What to build:
1. Define new EAS schemas that map to CIDS stages
2. Add Outcome tracking (before/after comparison scores, area measurements)
3. Add Impact tracking (carbon estimates, biodiversity indices over time)
4. Update `decisionLoop.ts` to populate the new schema fields
5. Migrate the dashboard to display CIDS-structured data
6. Register schemas with Green Goods' preferred resolver contracts

Estimated effort: 2-4 weeks


### Phase 5: Treasury Yield (DeFi Integration)

Park idle treasury funds in Morpho USDC vaults on Arbitrum for yield.

Options:
- **Steakhouse Financial vaults**: Largest curator on Morpho, $1.5B+ managed across 6 chains including Arbitrum, battle-tested through $108M liquidation day
- **Gauntlet vaults**: Strong risk management track record
- **RE7 vaults**: Higher APY, slightly more aggressive strategies

What to build:
1. Set up a multisig (Safe) on Arbitrum for treasury management
2. Deposit USDC into a Morpho vault (Steakhouse for safety, RE7 for higher yield)
3. Build a simple monitoring service or use the agent to track vault performance
4. Establish withdrawal rules (e.g., always keep 2 months of gas costs liquid)
5. Use yield to fund the Pimlico paymaster for contractor gas sponsorship

Estimated effort: 1 week for setup, ongoing management


## Total Timeline

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| 1. Chain swap | 1-2 hours | None |
| 2. Hats Protocol | 1-2 weeks | Phase 1 |
| 3. Account abstraction | 2-3 weeks | Phase 2 |
| 4. CIDS alignment | 2-4 weeks | Phase 1 (can parallel with 2-3) |
| 5. Treasury yield | 1 week | Phase 1 |

Phases 2-4 can overlap. Realistic total: 4-8 weeks from start to full Green Goods compatibility.

Phase 1 and 5 can be done in a weekend.


## Risks and Open Questions

- **Existing Base attestations**: They stay on Base forever. Do we want to re-attest them on Arbitrum for continuity, or just start fresh?
- **Green Goods partnership**: Should we coordinate with the Green Goods team before building? They might have a standard onboarding path for new projects.
- **Gas costs on Arbitrum vs Base**: Both are cheap L2s, but worth benchmarking attestation gas on Arbitrum to make sure it's comparable.
- **Pimlico pricing**: Free on testnets, need to check production pricing for the bundler and paymaster at our expected volume.
- **Schema versioning**: If we adopt CIDS and later Green Goods updates the standard, we need a plan for schema evolution.


## References

- EAS docs: https://docs.attest.org
- Hats Protocol docs: https://docs.hatsprotocol.xyz
- Pimlico docs: https://docs.pimlico.io
- Green Goods docs: https://docs.greengoods.app
- Morpho: https://morpho.org
- Arbitrum EAS on Arbiscan: https://arbiscan.io/address/0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458
- DeFi Llama yields: https://defillama.com/yields/stablecoins
