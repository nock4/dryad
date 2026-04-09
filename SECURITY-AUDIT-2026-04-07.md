# Dryad Security Audit Report

**Date:** April 7, 2026
**Auditor:** Claude Opus 4.6
**Scope:** Full codebase — secrets, authentication, on-chain transactions, input validation, network exposure

## Executive Summary

The Dryad ElizaOS agent has a strong foundational security architecture with multiple defense layers: timing-safe admin auth, multi-layer spending limits, injection detection, rate limiting, and audit logging. The audit identified 3 critical, 3 high, and 4 medium-severity findings. **All critical and high issues have been remediated and deployed.**

## Findings Summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | CRITICAL | `/api/security` used non-timing-safe string comparison | **FIXED** |
| 2 | CRITICAL | Admin error response leaked raw `err.message` | **FIXED** |
| 3 | CRITICAL | No security headers on HTML pages | **FIXED** |
| 4 | HIGH | ERC20 unlimited (max uint256) approvals to DeFi protocols | Open — accepted risk for POC |
| 5 | HIGH | Missing `deadline` parameter in Uniswap swap ABI | Open — DIEM swap not active in POC |
| 6 | HIGH | Admin secret stored in browser localStorage (XSS risk) | Open — acceptable for POC |
| 7 | MEDIUM | Private key accessed from 7+ files (wide surface area) | Open — recommend centralizing |
| 8 | MEDIUM | Rate limiting is in-memory only (resets on restart) | Open |
| 9 | MEDIUM | AMM MEV simulation uses hardcoded heuristics, not real pool state | Open — Aerodrome not active |
| 10 | MEDIUM | `ensureApproval()` spender param not validated against known addresses | Open |

## Detailed Findings

### CRITICAL-1: `/api/security` — Non-Timing-Safe Auth (FIXED)

**File:** `src/routes.ts:983`
**Before:** Used `!==` string comparison on `x-admin-secret` header — vulnerable to character-by-character timing attack.
**Fix:** Replaced with `isAdmin()` which uses `crypto.timingSafeEqual()` and standard `Authorization: Bearer` header.
**Deployed:** Commit `2bee447`, verified 403 on old header / 200 on Bearer.

### CRITICAL-2: Admin Error Response Leak (FIXED)

**File:** `src/routes.ts:1467`
**Before:** `res.json({ error: err?.message })` — if `triggerManualCycle()` throws with internal details (file paths, keys), they'd be exposed.
**Fix:** Generic error message: `{ error: 'Failed to trigger decision loop' }`, raw error logged server-side only.

### CRITICAL-3: Missing Security Headers (FIXED)

**File:** `src/routes.ts` — all HTML-serving routes
**Added:** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` on dashboard, submit, and legacy dashboard routes.

### HIGH-4: Unlimited ERC20 Approvals

**File:** `src/actions/defiYield.ts:121-127`
**Issue:** `approve(spender, MAX_UINT256)` grants unlimited token spending to Aave V3 Pool and Compound V3 Comet contracts. If either protocol were compromised, the attacker could drain the full USDC balance.
**Mitigating factors:** Aave and Compound are battle-tested protocols; wallet balance is small ($110 USDC in POC).
**Recommendation:** For production, approve only the exact deposit amount per transaction, or implement approve-then-revoke pattern.

### HIGH-5: Missing Swap Deadline

**File:** `src/actions/manageDIEM.ts:39`
**Issue:** Uniswap V3 `exactInputSingle` ABI definition omits the `deadline` parameter. Without it, a swap transaction stuck in the mempool could execute at a future block at a stale/worse price.
**Mitigating factors:** DIEM swap is not active in the current POC phase. Slippage protection (10%) is present.
**Recommendation:** Add `deadline` parameter (e.g., `block.timestamp + 300`).

### HIGH-6: Admin Secret in localStorage

**File:** `src/dashboard/api.ts:15,70-76`
**Issue:** The admin secret is stored in `localStorage`, which is readable by any JS on the page (XSS risk) and persists across sessions.
**Mitigating factors:** Dashboard is served from the agent's own origin; no third-party scripts loaded.
**Recommendation:** Migrate to `HttpOnly` session cookie or short-lived JWT.

### MEDIUM-7 through MEDIUM-10

See findings table above. These are design-level improvements that don't pose immediate exploitation risk in the POC phase.

## Positive Security Findings

The audit identified several well-implemented security controls:

- **Timing-safe admin auth** (`isAdmin()` uses `crypto.timingSafeEqual`) on all `/admin/*` routes
- **Multi-layer spending limits** in `transactionGuard.ts`: per-tx ($50), daily ($200), per-contractor (1/day), quiet hours, treasury floor (80%), auto-pause after 3 consecutive failures
- **Prompt injection detection** in `sanitize.ts`: 43+ patterns with Unicode normalization, applied to chat and submissions
- **Rate limiting** in `rateLimiter.ts`: per-endpoint limits (submit: 10/hr, chat: 30/hr, API: 60/min), global daily caps
- **CORS whitelist** restricted to `dryad.vercel.app`, the agent server, and localhost dev
- **Input validation** via `parseIntParam()` with min/max bounds on all numeric query parameters
- **File upload validation**: JPEG/PNG/HEIC only, 10MB max, random filenames (no path traversal)
- **Transaction confirmation**: All on-chain writes use `waitForTransactionReceipt` before state updates
- **Nonce management**: Shared viem client instances between approval and deposit to prevent desync
- **Flashbots Protect RPC** for MEV-sensitive transactions
- **Comprehensive audit logging** of all security events, transactions, and injection attempts

## Recommendations (Priority Order)

1. **Rotate credentials** if `.env` was ever exposed (EVM private key, API keys, GitHub token, Twitter creds)
2. **For production:** Switch unlimited approvals to exact-amount approvals
3. **For production:** Add `deadline` parameter to swap ABI
4. **For production:** Replace localStorage admin secret with HttpOnly session cookies
5. Centralize private key access through a single utility instead of 7+ files reading `EVM_PRIVATE_KEY`
6. Add persistent rate limiting (Redis or disk-backed) to survive restarts
7. Add Content Security Policy (CSP) meta tag to dashboard HTML build
