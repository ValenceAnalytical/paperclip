import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { heartbeatsApi } from "@/api/heartbeats";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type HermesApprovalRun = {
  id: string;
  companyId?: string | null;
  agentId?: string | null;
  status?: string | null;
};

type RunEventsInput = {
  runId: string;
  runStatus?: string | null;
  events: readonly HeartbeatRunEvent[];
};

type ApprovalStatus = "pending" | "resolved" | "failed" | "expired";

type HermesApprovalRequestCard = {
  eventId: string | number;
  runId: string;
  requestId: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  choice: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requestStatus(input: {
  payload: Record<string, unknown>;
  requestId: string;
  runStatus?: string | null;
  resolved: ReadonlyMap<string, string>;
  failed: ReadonlySet<string>;
  nowMs: number;
}): { status: ApprovalStatus; choice: string | null } {
  const choice = input.resolved.get(input.requestId) ?? null;
  if (choice) return { status: "resolved", choice };
  if (input.failed.has(input.requestId)) return { status: "failed", choice: null };
  const expiresAt = nonEmptyString(input.payload.expiresAt);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAtMs) && input.nowMs > expiresAtMs) {
    return { status: "expired", choice: null };
  }
  if (input.runStatus && !["queued", "running", "waiting_for_approval"].includes(input.runStatus)) {
    return { status: "expired", choice: null };
  }
  return { status: "pending", choice: null };
}

export function collectHermesApprovalRequests(
  runEvents: readonly RunEventsInput[],
  nowMs = Date.now(),
): HermesApprovalRequestCard[] {
  const resolved = new Map<string, string>();
  const failed = new Set<string>();
  const requested: HermesApprovalRequestCard[] = [];

  for (const { runId, runStatus, events } of runEvents) {
    for (const event of events) {
      const payload = asRecord(event.payload);
      const requestId = nonEmptyString(payload?.requestId);
      if (!requestId) continue;
      if (event.eventType === "hermes_gateway.approval.resolved") {
        resolved.set(requestId, nonEmptyString(payload?.choice) ?? "resolved");
      } else if (event.eventType === "hermes_gateway.approval.dispatch_failed") {
        failed.add(requestId);
      }
    }

    for (const event of events) {
      if (event.eventType !== "hermes_gateway.approval.requested") continue;
      const payload = asRecord(event.payload);
      const requestId = nonEmptyString(payload?.requestId);
      if (!payload || !requestId) continue;
      const state = requestStatus({ payload, requestId, runStatus, resolved, failed, nowMs });
      requested.push({
        eventId: event.id,
        runId,
        requestId,
        payload,
        status: state.status,
        choice: state.choice,
      });
    }
  }

  return requested.sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    const aRequested = Date.parse(nonEmptyString(a.payload.requestedAt) ?? "");
    const bRequested = Date.parse(nonEmptyString(b.payload.requestedAt) ?? "");
    return (Number.isFinite(bRequested) ? bRequested : 0) - (Number.isFinite(aRequested) ? aRequested : 0);
  });
}

export function HermesApprovalCards({
  runEvents,
  className,
  onResolved,
}: {
  runEvents: readonly RunEventsInput[];
  className?: string;
  onResolved?: (runId: string) => void | Promise<void>;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const approvalRequests = useMemo(
    () => collectHermesApprovalRequests(runEvents, nowMs),
    [runEvents, nowMs],
  );
  const mutation = useMutation({
    mutationFn: (input: { runId: string; requestId: string; choice: "once" | "deny" }) =>
      heartbeatsApi.resolveHermesApproval(input),
    onSuccess: async (_result, variables) => {
      if (variables) await onResolved?.(variables.runId);
    },
  });

  if (approvalRequests.length === 0) return null;

  return (
    <div className={className ?? "space-y-2"} data-testid="hermes-approval-cards">
      {approvalRequests.map((request) => {
        const payload = request.payload;
        const description = nonEmptyString(payload.description) ?? "Hermes is waiting for operator approval.";
        const preview = nonEmptyString(payload.command) ?? nonEmptyString(payload.code);
        const reason = nonEmptyString(payload.reason);
        const cwd = nonEmptyString(payload.cwd);
        const displayDigest = nonEmptyString(payload.displayDigest);
        const expiresAt = nonEmptyString(payload.expiresAt);
        const pendingThis = mutation.isPending &&
          mutation.variables?.runId === request.runId &&
          mutation.variables?.requestId === request.requestId;
        const canResolve = request.status === "pending";
        return (
          <div key={`${request.runId}:${request.eventId}:${request.requestId}`} className="rounded-2xl border border-amber-300/70 bg-amber-50/80 p-3 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/20 dark:text-amber-100">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Hermes approval required</div>
                <div>{description}</div>
                {reason && <div className="text-xs text-amber-800/80 dark:text-amber-200/80">Reason: {reason}</div>}
                {cwd && <div className="text-xs text-amber-800/80 dark:text-amber-200/80">cwd: {cwd}</div>}
                {preview && (
                  <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-background/70 p-2 text-xs text-foreground whitespace-pre-wrap">
                    {preview}
                  </pre>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-amber-800/75 dark:text-amber-200/75">
                  <span>Run {request.runId}</span>
                  <span>Request {request.requestId}</span>
                  <span>Status {request.status}{request.choice ? ` (${request.choice})` : ""}</span>
                  {displayDigest && <span>Digest {displayDigest}</span>}
                  {expiresAt && <span>Expires {relativeTime(expiresAt)}</span>}
                </div>
                <div className="text-xs text-amber-800/70 dark:text-amber-200/70">
                  Approve once authorizes only this exact Hermes run/request. The digest is Paperclip display integrity, not a Hermes-enforced command hash.
                </div>
              </div>
              {canResolve && (
                <div className="flex shrink-0 gap-2">
                  <Button type="button" size="xs" variant="default" disabled={pendingThis} onClick={() => mutation.mutate({ runId: request.runId, requestId: request.requestId, choice: "once" })}>
                    Approve once
                  </Button>
                  <Button type="button" size="xs" variant="outline" disabled={pendingThis} onClick={() => mutation.mutate({ runId: request.runId, requestId: request.requestId, choice: "deny" })}>
                    Deny
                  </Button>
                </div>
              )}
            </div>
            {mutation.isError && mutation.variables?.runId === request.runId && mutation.variables?.requestId === request.requestId && (
              <div className="mt-2 text-xs text-red-700 dark:text-red-300">
                {mutation.error instanceof Error ? mutation.error.message : "Failed to resolve approval"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function LiveHermesApprovalCards({
  runs,
  className,
}: {
  runs: readonly HermesApprovalRun[];
  className?: string;
}) {
  const queryClient = useQueryClient();
  const uniqueRuns = useMemo(() => {
    const seen = new Set<string>();
    return runs.filter((run) => {
      if (!run.id || seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    });
  }, [runs]);
  const queries = useQueries({
    queries: uniqueRuns.map((run) => ({
      queryKey: ["heartbeat-run", run.id, "events"] as const,
      queryFn: () => heartbeatsApi.events(run.id, 0, 200),
      enabled: Boolean(run.id),
      refetchInterval: run.status && ["completed", "failed", "cancelled", "canceled", "timed_out"].includes(run.status)
        ? false
        : 1000,
      staleTime: 500,
    })),
  });
  const runEvents = uniqueRuns.map((run, index) => ({
    runId: run.id,
    runStatus: run.status,
    events: queries[index]?.data ?? [],
  }));
  return (
    <HermesApprovalCards
      runEvents={runEvents}
      className={className}
      onResolved={async (runId) => {
        await queryClient.invalidateQueries({ queryKey: ["heartbeat-run", runId, "events"] });
      }}
    />
  );
}
