// Generate a 9-digit connection ID (TeamViewer-style), zero-padded.
import crypto from "node:crypto";

export function generateConnectionId() {
  // 9 decimal digits = up to 999_999_999, fits in 32-bit unsigned.
  const n = crypto.randomInt(100_000_000, 1_000_000_000);
  return String(n);
}
