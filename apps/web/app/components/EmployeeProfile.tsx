"use client";

import { useEffect, useState } from "react";

import { api, type EmployeeProfile as Profile } from "../lib/api";

/**
 * The state the events actually produced. Polls on the same cadence as the
 * event list so a change can be watched landing.
 */
export function EmployeeProfile({ employeeId }: { employeeId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const data = await api.profile(employeeId);
        if (active) setProfile(data);
      } catch {
        // A 404 means no event has succeeded yet, which is a state worth
        // showing rather than an error.
        if (active) setProfile(null);
      } finally {
        if (active) setPending(false);
      }
    }

    setPending(true);
    void load();
    const timer = setInterval(() => void load(), 2000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [employeeId]);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Payroll record</h2>
        <code>{employeeId}</code>
      </div>

      {!profile ? (
        <p className="muted">
          {pending
            ? "Loading…"
            : "Nothing applied yet — the record appears when an event succeeds."}
        </p>
      ) : (
        <dl className="meta" style={{ marginTop: 12 }}>
          <dt>Salary</dt>
          <dd>
            {profile.salary
              ? `${profile.salary.amount.toLocaleString()} ${profile.salary.currency}`
              : "—"}
          </dd>
          <dt>IBAN</dt>
          <dd>{profile.iban ? <code>{profile.iban}</code> : "—"}</dd>
          <dt>Address</dt>
          <dd>
            {profile.address
              ? [
                  profile.address.street,
                  profile.address.postalCode,
                  profile.address.city,
                  profile.address.country,
                ]
                  .filter(Boolean)
                  .join(", ")
              : "—"}
          </dd>
          <dt>Last applied</dt>
          <dd>
            seq {profile.lastAppliedSequence} ·{" "}
            <code>{profile.lastAppliedEventId?.slice(0, 8)}</code>
          </dd>
          <dt>Updated</dt>
          <dd className="muted">
            {new Date(profile.updatedAt).toLocaleTimeString()}
          </dd>
        </dl>
      )}
    </div>
  );
}
