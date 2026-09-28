export interface GovernanceAccountCreateInput {
  readonly userId: string;
  readonly displayName: string;
  readonly login: string;
  readonly role: "teacher" | "student";
  readonly classId: string | null;
}
