"use client";

import { useState } from "react";

import { api, type EventType } from "../lib/api";

const TYPES: { value: EventType; label: string }[] = [
  { value: "SALARY_CHANGE", label: "Salary change" },
  { value: "ADDRESS_CHANGE", label: "Address change" },
  { value: "BANK_ACCOUNT_CHANGE", label: "Bank account change" },
];

/** Field sets mirror the per-type payload DTOs on the API. */
const FIELDS: Record<
  EventType,
  { name: string; label: string; type?: string }[]
> = {
  SALARY_CHANGE: [
    { name: "newSalary", label: "New salary", type: "number" },
    { name: "currency", label: "Currency (EUR/USD/GBP/CHF)" },
  ],
  ADDRESS_CHANGE: [
    { name: "street", label: "Street" },
    { name: "city", label: "City" },
    { name: "postalCode", label: "Postal code" },
    { name: "country", label: "Country (ISO-2, e.g. DE)" },
  ],
  BANK_ACCOUNT_CHANGE: [{ name: "iban", label: "IBAN" }],
};

const DEFAULTS: Record<EventType, Record<string, string>> = {
  SALARY_CHANGE: { newSalary: "65000", currency: "EUR" },
  ADDRESS_CHANGE: {
    street: "Hauptstrasse 12",
    city: "Berlin",
    postalCode: "10115",
    country: "DE",
  },
  BANK_ACCOUNT_CHANGE: { iban: "DE89370400440532013000" },
};

export function SubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [type, setType] = useState<EventType>("SALARY_CHANGE");
  const [employeeId, setEmployeeId] = useState("emp-1001");
  const [effectiveDate, setEffectiveDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [values, setValues] = useState<Record<string, string>>(
    DEFAULTS.SALARY_CHANGE,
  );
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  function changeType(next: EventType) {
    setType(next);
    setValues(DEFAULTS[next]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);

    try {
      const payload: Record<string, unknown> = { ...values };
      if (type === "SALARY_CHANGE") {
        payload.newSalary = Number(payload.newSalary);
      }

      const res = await api.submit({
        type,
        employeeId,
        effectiveDate,
        payload,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

      setNotice({
        ok: true,
        text: res.duplicate
          ? `Duplicate detected — returned existing event ${res.id.slice(0, 8)} (seq ${res.sequence}). No second change applied.`
          : `Accepted as ${res.id.slice(0, 8)} (seq ${res.sequence}).`,
      });
      onSubmitted();
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h2>Submit event</h2>

      {notice && (
        <div className={`alert ${notice.ok ? "ok" : "err"}`}>{notice.text}</div>
      )}

      <label>
        <span>Event type</span>
        <select
          value={type}
          onChange={(e) => changeType(e.target.value as EventType)}
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Employee ID</span>
        <input
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          required
        />
      </label>

      <label>
        <span>Effective date</span>
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
          required
        />
      </label>

      {FIELDS[type].map((field) => (
        <label key={field.name}>
          <span>{field.label}</span>
          <input
            type={field.type ?? "text"}
            value={values[field.name] ?? ""}
            onChange={(e) =>
              setValues((v) => ({ ...v, [field.name]: e.target.value }))
            }
            required
          />
        </label>
      ))}

      <label>
        <span>
          Idempotency key (optional — leave blank to derive one from the body)
        </span>
        <input
          value={idempotencyKey}
          onChange={(e) => setIdempotencyKey(e.target.value)}
          placeholder="reuse the same key to demo deduplication"
        />
      </label>

      <button type="submit" disabled={busy}>
        {busy ? "Submitting…" : "Submit event"}
      </button>
    </form>
  );
}
