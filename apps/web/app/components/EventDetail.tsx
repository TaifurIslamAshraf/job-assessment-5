"use client";

import { useEffect, useState } from "react";

import { api, type PayrollEvent, type Transition } from "../lib/api";

type Detail = PayrollEvent & { transitions: Transition[] };

/**
 * Polls while the event is still moving so state changes (ACCEPTED →
 * PROCESSING → PENDING_RETRY → SUCCEEDED/FAILED) are visible as they happen.
 */
export function EventDetail({ id }: { id: string }) {
  const [event, setEvent] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setEvent(null);
  }, [id]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const data = await api.get(id);
        if (!active) return;
        setEvent(data);
        setError(null);

        const settled = data.status === "SUCCEEDED" || data.status === "FAILED";
        if (!settled) timer = setTimeout(poll, 1000);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }

    void poll();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, reload]);

  async function retry(force: boolean) {
    setRetrying(true);
    try {
      await api.retry(id, force);
      setError(null);
      // The event is moving again, so restart the poll the effect stopped.
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  if (!event) {
    return error ? (
      <div className="panel alert err">{error}</div>
    ) : (
      <div className="panel muted">Loading…</div>
    );
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{event.type}</h2>
        <span className={`badge ${event.status}`}>{event.status}</span>
      </div>

      <dl className="meta" style={{ marginTop: 12 }}>
        <dt>Event ID</dt>
        <dd>
          <code>{event.id}</code>
        </dd>
        <dt>Employee</dt>
        <dd>{event.employeeId}</dd>
        <dt>Accept sequence</dt>
        <dd>{event.sequence}</dd>
        <dt>Effective</dt>
        <dd>{event.effectiveDate.slice(0, 10)}</dd>
        <dt>Attempts</dt>
        <dd>
          {event.attempts} / {event.maxAttempts}
        </dd>
        {event.lockedBy && (
          <>
            <dt>Locked by</dt>
            <dd>
              <code>{event.lockedBy}</code>
            </dd>
          </>
        )}
      </dl>

      {error && <div className="alert err">{error}</div>}

      {event.failureReason && (
        <div className="alert err">
          <strong>{event.failureCode}</strong>
          <br />
          {event.failureReason}
        </div>
      )}

      {event.status === "FAILED" && (
        <div className="row">
          <button
            type="button"
            style={{ width: "auto", padding: "5px 10px" }}
            disabled={retrying}
            onClick={() => void retry(false)}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={retrying}
            onClick={() => void retry(true)}
          >
            Force retry
          </button>
          <span className="muted">
            Force is for a permanent failure — it will fail the same way unless
            the cause was fixed.
          </span>
        </div>
      )}

      <h2>Submitted payload</h2>
      <pre className="json">{JSON.stringify(event.payload, null, 2)}</pre>

      {event.result && (
        <>
          <h2 style={{ marginTop: 16 }}>Provider result</h2>
          <pre className="json">{JSON.stringify(event.result, null, 2)}</pre>
        </>
      )}

      <h2 style={{ marginTop: 16 }}>Audit trail</h2>
      <ol className="timeline">
        {event.transitions.map((t) => (
          <li key={t.id}>
            <div className="row">
              <span className={`badge ${t.toStatus}`}>{t.toStatus}</span>
              {t.attempt > 0 && (
                <span className="muted">attempt {t.attempt}</span>
              )}
            </div>
            {t.message && <div>{t.message}</div>}
            <time>{new Date(t.createdAt).toLocaleString()}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}
