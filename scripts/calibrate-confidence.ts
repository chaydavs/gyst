#!/usr/bin/env bun
/**
 * Confidence calibration analyzer.
 *
 * Groups entries by confidence bucket (0-0.2, 0.2-0.4, ...) and computes
 * what percentage received positive feedback ("helpful": true).
 *
 * Perfect calibration: an entry with 0.8 confidence is actually helpful
 * 80% of the time. Deviations tell us the scoring formula is miscalibrated.
 */

import { initDatabase } from "../src/store/database.js";
import { loadConfig } from "../src/utils/config.js";

interface BucketStat {
  range: string;
  confidenceMin: number;
  confidenceMax: number;
  entryCount: number;
  feedbackCount: number;
  positiveCount: number;
  positiveRate: number;
  expectedRate: number;  // midpoint of bucket
  delta: number;         // actual - expected
}

const BUCKETS: readonly { min: number; max: number; label: string }[] = [
  { min: 0.0, max: 0.2, label: "0.0-0.2" },
  { min: 0.2, max: 0.4, label: "0.2-0.4" },
  { min: 0.4, max: 0.6, label: "0.4-0.6" },
  { min: 0.6, max: 0.8, label: "0.6-0.8" },
  { min: 0.8, max: 1.0, label: "0.8-1.0" },
];

function calibrate(): void {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);

  const stats: BucketStat[] = BUCKETS.map((bucket) => {
    // Count entries in bucket
    const entryRow = db
      .query<{ n: number }, [number, number]>(
        `SELECT COUNT(*) AS n FROM entries
         WHERE confidence >= ? AND confidence < ?
           AND status = 'active'`,
      )
      .get(bucket.min, bucket.max);
    const entryCount = entryRow?.n ?? 0;

    // Count feedback + positives for entries in bucket
    const fbRow = db
      .query<
        { total: number; positive: number },
        [number, number]
      >(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN f.helpful = 1 THEN 1 ELSE 0 END) AS positive
         FROM feedback f
         JOIN entries e ON e.id = f.entry_id
         WHERE e.confidence >= ? AND e.confidence < ?`,
      )
      .get(bucket.min, bucket.max);

    const feedbackCount = fbRow?.total ?? 0;
    const positiveCount = fbRow?.positive ?? 0;
    const positiveRate = feedbackCount > 0 ? positiveCount / feedbackCount : 0;
    const expectedRate = (bucket.min + bucket.max) / 2;

    return {
      range: bucket.label,
      confidenceMin: bucket.min,
      confidenceMax: bucket.max,
      entryCount,
      feedbackCount,
      positiveCount,
      positiveRate,
      expectedRate,
      delta: positiveRate - expectedRate,
    };
  });

  // Print report
  process.stdout.write("\n=== Confidence Calibration Report ===\n\n");
  process.stdout.write("Bucket    | Entries | Feedback | Positive | Actual%  | Expected% | Delta\n");
  process.stdout.write("----------|---------|----------|----------|----------|-----------|-------\n");
  for (const s of stats) {
    const row = `${s.range.padEnd(9)} | ${String(s.entryCount).padStart(7)} | ${String(s.feedbackCount).padStart(8)} | ${String(s.positiveCount).padStart(8)} | ${(s.positiveRate * 100).toFixed(1).padStart(7)}% | ${(s.expectedRate * 100).toFixed(1).padStart(8)}% | ${(s.delta * 100 >= 0 ? "+" : "") + (s.delta * 100).toFixed(1)}%\n`;
    process.stdout.write(row);
  }

  const totalFeedback = stats.reduce((sum, s) => sum + s.feedbackCount, 0);
  process.stdout.write(`\nTotal feedback records: ${totalFeedback}\n`);

  if (totalFeedback === 0) {
    process.stdout.write("No feedback data yet. Use the `feedback` MCP tool to start recording signals.\n");
  } else if (totalFeedback < 50) {
    process.stdout.write("Not enough data for meaningful calibration (need ~50+ feedback records).\n");
  } else {
    // Compute overall miscalibration
    const avgAbsDelta = stats.reduce((sum, s) => sum + Math.abs(s.delta), 0) / BUCKETS.length;
    process.stdout.write(`\nMean absolute calibration error: ${(avgAbsDelta * 100).toFixed(1)}%\n`);
    if (avgAbsDelta > 0.15) {
      process.stdout.write("Calibration error > 15%. Consider adjusting the confidence formula.\n");
    } else {
      process.stdout.write("Calibration looks reasonable.\n");
    }
  }

  db.close();
}

calibrate();
