import { createHash } from "node:crypto";

/**
 * Watchlist rows are telemetry, not immutable promotion evidence. Reuse one ID
 * per hourly market/policy bucket so a one-minute scan does not manufacture
 * tens of thousands of statistically identical observations each day.
 */
export function researchObservationId(
  prefix: string,
  marketId: string,
  tokenId: string,
  policyVersion: string,
  now: number,
  bucketMs = 60 * 60_000
): string {
  const bucket = Math.floor(now / bucketMs);
  const digest = createHash("sha256")
    .update([prefix, marketId, tokenId, policyVersion, String(bucket)].join("|"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}
