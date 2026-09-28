/** Synthetic injected security only: no password login, issuance or real secret access. */
export const usageHealthTestSecurity = {
  digest: { digest: (token: string) => token },
  ids: { createId: () => "unused" },
  secrets: { issue: () => "unused" },
  passwords: { hash: () => Promise.resolve("unused"), verify: () => Promise.resolve(false) },
  dummyPasswordHash: "unused",
};
