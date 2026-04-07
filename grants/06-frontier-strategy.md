# Solana Frontier Hackathon — Dryad Submission Strategy

*Updated: March 28, 2026*
*Hackathon: April 6 – May 11, 2026 | Colosseum*
*Prize: $250K investment from Colosseum venture fund + accelerator*

---

## Approach: Solana-Native Fork

Fork Dryad and rebuild natively on Solana. No cross-chain, no deBridge. Colosseum judges reward Solana-native projects — 99% of the 150 recent winners use Solana as primary chain, 39% use Rust, 22% use Anchor. A Solana-native agent speaks their language.

The Base version stays as the production system. The Solana fork is purpose-built for Frontier.

---

## Positioning

**"The Forest That Owns Itself"** — An autonomous AI agent that owns and manages real Detroit land on Solana, funding urban conservation through native DeFi yield.

---

## Why We Win

### 1. Real-World Agent, Not a Wrapper

Past Colosseum Grand Champions solve real gaps with technical depth: Ore (novel PoW), TapeDrive (decentralized storage), Unruggable (hardware wallet). Dryad manages 9 actual Detroit lots (4475–4523 25th St), coordinates real contractors, files real property taxes, and monitors invasive species via iNaturalist. The USFWS partnership is not a hackathon fabrication. Dryad is live on a VPS today.

### 2. Green Field: No Environmental RWA Agent Exists on Solana

From the Copilot API: 204 projects in the "Solana Real Estate Tokenization" cluster, 12 winners. Every single one does fractional ownership or property-backed lending (BricksFi, defi REIT, ReFi Hub, Vezora, Zamindar). None of them use an autonomous agent. None manage land for environmental outcomes. The top problem tags are "illiquid physical assets" and "high real estate entry costs" — Dryad solves a completely different problem: autonomous land stewardship.

The closest RWA winners:
- **Autonom** (1st RWA, $25K) — RWA oracle for equities. Infrastructure play.
- **BORE.FI** (2nd RWA, $20K) — Tokenized SME private equity. Finance play.
- **attn.markets** (1st Undefined, $25K) — Revenue tokenization. Creator economy.
- **AquaSave** (Climate Award, $5K) — IoT water monitoring. Closest to our environmental angle but DePIN, not RWA.

Nobody combines RWA + autonomous agent + environmental impact.

### 3. Solana-Native Technical Stack

Building natively with Anchor/Rust programs for on-chain treasury management, `@elizaos/plugin-solana-v2` for agent operations, and Solana-native DeFi protocols (Marinade, Kamino, Drift, Meteora). ElizaOS powers 77% of agent transaction volume on Solana — ecosystem alignment is strong.

### 4. Agent Identity on Solana

Solana Agent Registry + SATI (Solana Agent Trust Infrastructure) for native agent identity. Functional parity with ERC-8004 but built for Solana. Register Dryad as a verifiable autonomous agent with on-chain reputation.

---

## Competitive Landscape (from Copilot API data)

### What Wins — Tag Analysis (150 winners, Cypherpunk + Breakout)

Top winning primitives: stablecoins (17%), oracle (14%), lending (11%), rwa (11%), amm (10%), payments (9%), tokenization (9%), depin (9%). **RWA is in the top 4 winning primitives.** AI-agent is a primitive in 156 projects across all hackathons but still underrepresented among winners — opportunity for a strong entry.

### Direct Competitor Risk: Low

| Category | Top Competitor | Our Differentiation |
|---|---|---|
| AI Treasury Agents | Agent Arc (3rd AI, $15K) — trading terminal | We manage real assets, not speculative trades |
| DeFi Automation | Lomen AI (HM DeFi) — multi-step DeFi | We have conservation constraints, real-world trigger |
| Agent Infrastructure | Mercantill (4th Stablecoins, $10K) — banking for agents | We ARE the agent, not infra for agents |
| RWA | Autonom (1st RWA, $25K) — equity oracle | We do land, not equities. Different asset class entirely |
| Environmental | AquaSave (Climate, $5K) — water IoT | We do land + DeFi. They're DePIN + sensors |

No past winner combines: autonomous agent + RWA + DeFi yield + environmental conservation. We're genuinely novel.

---

## Track Strategy

### Primary: RWAs Track
- 11% of recent winners have RWA primitives — judges actively reward this category
- Past RWA winners focus on finance infrastructure (oracles, lending, tokenization)
- We bring something they haven't seen: **autonomous land management**
- Strong narrative: "the agent that owns land and funds its own conservation"

### Secondary: DeFi Track
- Yield optimization on native Solana protocols (Marinade, Kamino, Drift)
- Autonomous treasury rebalancing with risk controls
- Strongest technical depth story

### Tertiary: AI Track (if offered)
- "Most Agentic" category likely returning
- Genuine autonomous execution, not a chatbot
- Decision loop: detect invasive species → allocate funds → hire contractors → verify work → reinvest yield

---

## Technical Build Plan (April 6 – May 11)

### Week 1: Solana Foundation (April 6–13)
- [ ] Fork dryad-eliza → dryad-solana
- [ ] Replace Base dependencies with `@elizaos/plugin-solana-v2`
- [ ] Deploy Solana agent wallet (keypair, fund with devnet SOL → mainnet)
- [ ] Port treasury health check to read Solana balances (USDC SPL token)
- [ ] Register on Solana Agent Registry (SATI)

### Week 2: Native DeFi Integration (April 14–20)
- [ ] Marinade staking integration (mSOL/stSOL yield)
- [ ] Kamino vault deposits (USDC vaults)
- [ ] Drift protocol integration (lending/perps if needed)
- [ ] Port yield monitor to use Solana DeFi protocols instead of Base ones
- [ ] Port rebalancer logic with Solana-native gas estimation

### Week 3: Land + Conservation On-Chain (April 21–27)
- [ ] Anchor program for land parcel registry (9 parcels, metadata, tax status)
- [ ] iNaturalist → on-chain attestation pipeline (observation → Solana transaction)
- [ ] Contractor payment flow via SPL USDC transfers
- [ ] "Buy lots across the street" — tokenize target parcels on Solana
- [ ] Conservation impact dashboard (species detected, invasives removed, area managed)

### Week 4: Polish + Demo (April 28 – May 5)
- [ ] Demo video: autonomous agent managing real Detroit land on Solana
- [ ] Architecture diagram showing: land data → agent decision loop → DeFi yield → conservation funding
- [ ] README + submission write-up
- [ ] Loom technical walkthrough
- [ ] Test full decision loop end-to-end on mainnet

### Buffer (May 5–11)
- [ ] Judge Q&A prep
- [ ] Bug fixes
- [ ] Final polish

---

## Narrative Hooks for Judges

1. **"Real land, real agent, real Solana"** — Not a testnet demo. 9 lots in Detroit, live on Solana mainnet, managing its own treasury.

2. **"The agent that pays its own property taxes"** — Treasury yield from Marinade/Kamino funds property taxes, contractor payments, and conservation work. No human intervention.

3. **"From DeFi to Detroit"** — Yield optimization isn't APY chasing. It funds invasive species removal, native planting, and habitat restoration in a post-industrial American city.

4. **"204 real estate projects, zero autonomous agents"** — The Copilot data proves it: every Solana real estate project does fractional ownership. None of them can think for themselves.

---

## Past Winner Patterns (What Judges Reward)

- **RWA 1st place (Autonom, $25K):** Solved infrastructure problem (reliable RWA oracles). Technical depth + clear gap.
- **RWA 2nd (BORE.FI, $20K):** Tokenized real business cash flows. Real revenue, not speculation.
- **Undefined 1st (attn.markets, $25K):** Novel primitive (revenue tokenization). Didn't fit existing categories.
- **AI 3rd (Agent Arc, $15K):** Non-custodial trading with on-chain fee enforcement. Actually autonomous.
- **Climate Award (AquaSave, $5K):** IoT + conservation incentives. Environmental angle resonates.

Dryad maps to multiple winning patterns: real assets (BORE.FI), infrastructure novelty (Autonom), genuine autonomy (Agent Arc), environmental impact (AquaSave).

---

## Registration

- **Platform:** arena.colosseum.org
- **Account:** Nock4
- **Status:** Account created, need to register for Frontier specifically before April 6
- **Copilot PAT:** Active (expires June 26, 2026) — use for ongoing competitive research
- **Action:** Register at https://arena.colosseum.org when Frontier registration opens
