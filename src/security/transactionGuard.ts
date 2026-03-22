/**
 * Financial transaction safety layer.
 * Wraps all outgoing payments with allowlist, velocity, and anomaly checks.
 */
import { logSecurityEvent } from './sanitize.ts';

const allowlistedRecipients = new Map<string, { addedAt: number; label: string; coolingOff: boolean }>();
const txHistory: Array<{ timestamp: number; amount: number; recipient: string; txHash?: string }> = [];

const LIMITS = {
  PER_TX_USD: 50,
  DAILY_USD: 200,
  MAX_TX_PER_DAY: 3,
  MAX_TX_PER_CONTRACTOR_PER_DAY: 1,
  COOLING_OFF_HOURS: 24,
  QUIET_HOURS_START: 23,
  QUIET_HOURS_END: 6,
  TREASURY_FLOOR_PERCENT: 0.80,
  MAX_FAILED_CONSECUTIVE: 3,
};

let consecutiveFailures = 0;
let paymentsPaused = false;
let initialTreasuryBalance: number | null = null;

export function setInitialTreasuryBalance(balanceUsd: number): void {
  if (initialTreasuryBalance === null) initialTreasuryBalance = balanceUsd;
}

export function addAllowlistedAddress(address: string, label: string): { success: boolean; reason?: string } {
  const n = address.toLowerCase();
  if (allowlistedRecipients.has(n)) return { success: false, reason: 'Already allowlisted' };

  allowlistedRecipients.set(n, { addedAt: Date.now(), label, coolingOff: true });
  logSecurityEvent('ADDRESS_ADDED', `${label} (${address}) — 24hr cooling off`, 'transactionGuard');

  setTimeout(() => {
    const entry = allowlistedRecipients.get(n);
    if (entry) {
      entry.coolingOff = false;
      logSecurityEvent('ADDRESS_ACTIVE', `${label} (${address}) now active`, 'transactionGuard');
    }
  }, LIMITS.COOLING_OFF_HOURS * 3600000);

  return { success: true };
}

export function isAddressAllowlisted(address: string): boolean {
  const entry = allowlistedRecipients.get(address.toLowerCase());
  return !!entry && !entry.coolingOff;
}

export function validateTransaction(
  recipient: string,
  amountUsd: number,
  currentTreasuryUsd?: number
): { allowed: boolean; reason?: string } {
  const n = recipient.toLowerCase();

  if (paymentsPaused) {
    return { allowed: false, reason: 'Payments paused due to consecutive failures. Steward intervention required.' };
  }

  if (amountUsd > LIMITS.PER_TX_USD) {
    logSecurityEvent('TX_REJECTED', `$${amountUsd} > $${LIMITS.PER_TX_USD} limit`, 'transactionGuard');
    return { allowed: false, reason: `Amount $${amountUsd} exceeds $${LIMITS.PER_TX_USD} per-tx limit` };
  }

  // Allowlist check (skip if list is empty — first-time setup)
  if (allowlistedRecipients.size > 0) {
    if (!allowlistedRecipients.has(n)) {
      logSecurityEvent('TX_REJECTED', `${recipient} not allowlisted`, 'transactionGuard');
      return { allowed: false, reason: `Recipient not allowlisted. New addresses need 24hr cooling-off.` };
    }
    const entry = allowlistedRecipients.get(n)!;
    if (entry.coolingOff) {
      const hrs = Math.ceil((entry.addedAt + LIMITS.COOLING_OFF_HOURS * 3600000 - Date.now()) / 3600000);
      return { allowed: false, reason: `${entry.label} in cooling-off (${hrs}h remaining)` };
    }
  }

  // Quiet hours
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hour12: false }));
  if (hour >= LIMITS.QUIET_HOURS_START || hour < LIMITS.QUIET_HOURS_END) {
    logSecurityEvent('TX_REJECTED', `Quiet hours (${hour}:00 ET)`, 'transactionGuard');
    return { allowed: false, reason: `Blocked during quiet hours (11pm-6am ET)` };
  }

  // Daily limits
  const dayAgo = Date.now() - 86400000;
  const recent = txHistory.filter(tx => tx.timestamp > dayAgo);
  const dailyTotal = recent.reduce((s, tx) => s + tx.amount, 0);

  if (dailyTotal + amountUsd > LIMITS.DAILY_USD) {
    return { allowed: false, reason: `Daily limit: $${dailyTotal.toFixed(0)}/$${LIMITS.DAILY_USD} spent` };
  }
  if (recent.length >= LIMITS.MAX_TX_PER_DAY) {
    return { allowed: false, reason: `Max ${LIMITS.MAX_TX_PER_DAY} tx/day reached` };
  }

  const contractorToday = recent.filter(tx => tx.recipient === n);
  if (contractorToday.length >= LIMITS.MAX_TX_PER_CONTRACTOR_PER_DAY) {
    return { allowed: false, reason: 'Already paid this contractor today' };
  }

  // Treasury floor
  if (currentTreasuryUsd !== undefined && initialTreasuryBalance !== null) {
    const floor = initialTreasuryBalance * LIMITS.TREASURY_FLOOR_PERCENT;
    if (currentTreasuryUsd < floor) {
      logSecurityEvent('TREASURY_CRITICAL', `$${currentTreasuryUsd} < floor $${floor}`, 'transactionGuard');
      return { allowed: false, reason: `Treasury below ${LIMITS.TREASURY_FLOOR_PERCENT * 100}% floor` };
    }
  }

  return { allowed: true };
}

export function recordTransaction(recipient: string, amountUsd: number, txHash?: string): void {
  txHistory.push({ timestamp: Date.now(), amount: amountUsd, recipient: recipient.toLowerCase(), txHash });
  consecutiveFailures = 0;
  // Trim to 30 days
  const cutoff = Date.now() - 30 * 86400000;
  while (txHistory.length > 0 && txHistory[0].timestamp < cutoff) txHistory.shift();
}

export function recordFailedTransaction(reason: string): void {
  consecutiveFailures++;
  logSecurityEvent('TX_FAILED', `#${consecutiveFailures}: ${reason}`, 'transactionGuard');
  if (consecutiveFailures >= LIMITS.MAX_FAILED_CONSECUTIVE) {
    paymentsPaused = true;
    logSecurityEvent('PAYMENTS_PAUSED', `${LIMITS.MAX_FAILED_CONSECUTIVE} failures — paused`, 'transactionGuard');
  }
}

export function unpausePayments(): void {
  paymentsPaused = false;
  consecutiveFailures = 0;
  logSecurityEvent('PAYMENTS_RESUMED', 'Manual resume', 'transactionGuard');
}

export function isPaymentsPaused(): boolean { return paymentsPaused; }
export function getTransactionHistory() { return [...txHistory]; }
