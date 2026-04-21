/**
 * Prompt evolution — types for benchmarking, scoring, and iterating prompt variants.
 *
 * Design goals:
 * - Multi-objective scoring (accuracy, cost, parse reliability) so we don't over-fit
 *   to a single metric.
 * - Deterministic case hashes so the same (prompt, case) pair is always identifiable.
 * - Minimal dependencies on the rest of the codebase so the module is testable in
 *   isolation.
 */
export {};
