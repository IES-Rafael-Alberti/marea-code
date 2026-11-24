import type { AdmissionRule } from "@marea/plugin-api";

import type { ClassAdmissionRules } from "./contracts.js";

/** Asks whether one rule admits the person; it rejects when the provider is unavailable. */
export type AdmitsRule = (rule: AdmissionRule) => Promise<boolean>;

/**
 * The classes that admit a person. Every (class, rule) check is one task of a shared pool of
 * `concurrency` workers, so slow group lookups overlap across classes and rules. A class stops
 * being checked as soon as one of its rules admits, and the first failure stops new checks.
 */
export async function admittedClassIds(
  classes: readonly ClassAdmissionRules[],
  admits: AdmitsRule,
  concurrency: number,
): Promise<readonly string[]> {
  const tasks = classes.flatMap(({ classId, rules }) => rules.map((rule) => ({ classId, rule })));
  const admitted = new Set<string>();
  const queue = tasks.values();
  let failed = false;
  const worker = async (): Promise<void> => {
    for (const { classId, rule } of queue) {
      if (failed) return;
      if (admitted.has(classId)) continue;
      try {
        if (await admits(rule)) admitted.add(classId);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return classes.filter(({ classId }) => admitted.has(classId)).map(({ classId }) => classId);
}
