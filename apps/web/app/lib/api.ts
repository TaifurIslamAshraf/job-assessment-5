export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

export type EventStatus =
  | "ACCEPTED"
  | "PROCESSING"
  | "PENDING_RETRY"
  | "SUCCEEDED"
  | "FAILED";

export type EventType =
  | "BANK_ACCOUNT_CHANGE"
  | "ADDRESS_CHANGE"
  | "SALARY_CHANGE";

export interface PayrollEvent {
  id: string;
  employeeId: string;
  type: EventType;
  status: EventStatus;
  sequence: number;
  attempts: number;
  maxAttempts: number;
  effectiveDate: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  failureCode: string | null;
  failureReason: string | null;
  acceptedAt: string;
  processingStartedAt: string | null;
  completedAt: string | null;
  lockedBy: string | null;
}

export interface Transition {
  id: string;
  fromStatus: EventStatus | null;
  toStatus: EventStatus;
  attempt: number;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface SubmitResponse {
  id: string;
  status: EventStatus;
  duplicate: boolean;
  sequence: number;
  idempotencyKey: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    cache: "no-store",
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message = Array.isArray(body?.message)
      ? body.message.join("; ")
      : (body?.message ?? `Request failed with ${res.status}`);
    throw new Error(message);
  }

  return body as T;
}

export const api = {
  submit: (body: unknown) =>
    request<SubmitResponse>("/events", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  list: (employeeId?: string) =>
    request<{ items: PayrollEvent[]; total: number }>(
      `/events?take=50${employeeId ? `&employeeId=${encodeURIComponent(employeeId)}` : ""}`,
    ),

  get: (id: string) =>
    request<PayrollEvent & { transitions: Transition[] }>(`/events/${id}`),

  health: () =>
    request<{ status: string; checks: Record<string, { status: string }> }>(
      "/health",
    ),
};
