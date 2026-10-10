export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Result<T = unknown> = {
  status:
    | "ok"
    | "partial"
    | "pending"
    | "requires_user_action"
    | "unsupported"
    | "conflict"
    | "failed"
    | "outcome_unknown";
  data?: T;
  observation?: {
    observedAt: string;
    source: string;
    contextRef: string;
    deliveryContextRef?: string;
    authentication?: "verified";
  };
  coverage?: { complete: boolean; missing: string[]; reason?: string };
  nextCursor?: string;
  operationId?: string;
  action?: { kind: string; url?: string; expiresAt?: string };
  error?: { code: string; retryable: boolean; message?: string };
};
export type Owner = { id: string; scopes: string[] };
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 409,
  ) {
    super(message);
  }
}
export type ProviderContext = {
  ownerId: string;
  accountRef: string;
  sessionGeneration: number;
  marketplace: "amazon.com";
  intentExpiresAt?: string;
};
export type ProviderRead = (
  kind: string,
  input: Record<string, unknown>,
  context: ProviderContext,
) => Promise<Result>;
export type ProviderMutation = (
  kind: string,
  terms: Record<string, unknown>,
  context: ProviderContext,
) => Promise<Result>;
export interface ShoppingProvider {
  read: ProviderRead;
  mutate: ProviderMutation;
  close(): Promise<void>;
}
