"use client";

import { useCallback, useEffect, useState } from "react";

import { EmployeeProfile } from "./components/EmployeeProfile";
import { EventDetail } from "./components/EventDetail";
import { SubmitForm } from "./components/SubmitForm";
import { api, type PayrollEvent } from "./lib/api";

export default function Page() {
  const [events, setEvents] = useState<PayrollEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [health, setHealth] = useState<string>("…");
  const [error, setError] = useState<string | null>(null);

  const selectedEmployee = events.find((e) => e.id === selected)?.employeeId;

  const refresh = useCallback(async () => {
    try {
      const { items } = await api.list();
      setEvents(items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Fetch once on mount; subsequent updates come from onSubmitted callbacks.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void api
      .health()
      .then((h) => setHealth(h.status))
      .catch(() => setHealth("unreachable"));
  }, []);

  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>Payroll Event Processing</h1>
          <p>
            Events are accepted synchronously and processed by a background
            worker. Watch a row change status without reloading.
          </p>
        </div>
        <span className={`badge ${health === "ok" ? "SUCCEEDED" : "FAILED"}`}>
          API {health}
        </span>
      </header>

      {error && <div className="alert err">{error}</div>}

      <div className="layout">
        <SubmitForm onSubmitted={refresh} />

        <div style={{ display: "grid", gap: 20 }}>
          <div className="panel">
            <h2>Events ({events.length})</h2>
            {events.length === 0 ? (
              <p className="muted">
                No events yet — submit one to see it move through the pipeline.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Seq</th>
                    <th>Type</th>
                    <th>Employee</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Accepted</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr
                      key={e.id}
                      aria-selected={e.id === selected}
                      onClick={() => setSelected(e.id)}
                    >
                      <td>{e.sequence}</td>
                      <td>{e.type.replace(/_/g, " ").toLowerCase()}</td>
                      <td>{e.employeeId}</td>
                      <td>
                        <span className={`badge ${e.status}`}>{e.status}</span>
                      </td>
                      <td>
                        {e.attempts}/{e.maxAttempts}
                      </td>
                      <td className="muted">
                        {new Date(e.acceptedAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {selectedEmployee && (
            <EmployeeProfile employeeId={selectedEmployee} />
          )}

          {selected && <EventDetail id={selected} />}
        </div>
      </div>
    </main>
  );
}
