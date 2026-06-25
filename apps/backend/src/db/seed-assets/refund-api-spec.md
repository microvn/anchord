# Refund API — v0 Specification

This document describes the v0 refund endpoint: what it accepts, what it guarantees, and the failure modes a caller must handle. It is the contract the storefront and the support console both build against. Anything not stated here is out of scope for v0.

## Goals

A refund moves money back to the customer for a captured payment. v0 covers the common case end to end and refuses anything it cannot do safely. The design favors correctness over coverage: a request we cannot prove safe is rejected, never half-applied.

- Refund a **fully captured** payment in one call.
- Make every request **idempotent**, so a retry after a timeout never double-refunds.
- Return a **typed error** for every refusal, so the caller can react without parsing prose.

Partial refunds, multi-capture orders, and currency conversion are explicitly deferred to v1.

## Request

A refund is created with `POST /v1/refunds`. The body names the capture to reverse and an idempotency key the caller generates once per logical attempt.

```json
{
  "capture_id": "cap_abc123",
  "idempotency_key": "rf_2026_06_25_001",
  "reason": "requested_by_customer"
}
```

The `capture_id` must reference a capture in the `captured` state and owned by the calling merchant. The `reason` is one of `requested_by_customer`, `duplicate`, or `fraudulent`; it is recorded for reporting and never changes the refund amount.

> The amount is **not** a request field in v0. A refund always reverses the full captured amount. Sending an `amount` is a client error, not a silent partial refund.

## Behavior

The endpoint resolves the capture, verifies ownership, and checks that the full amount is still refundable. On success it records a refund row, kicks off the asynchronous payout reversal, and returns `201` with the refund resource. The payout itself settles out of band; the refund resource carries a `status` the caller can poll.

| Status | Meaning |
|---|---|
| `pending` | Accepted, reversal in flight. |
| `succeeded` | Funds returned to the customer. |
| `failed` | The processor rejected the reversal; funds were not moved. |

A `failed` refund is terminal. The caller may create a new refund with a fresh idempotency key once the underlying cause is resolved.

## Idempotency

The `idempotency_key` is unique per merchant. A repeated request with the same key returns the original refund resource unchanged, even if the first response was lost. A repeated key with a **different** body is a conflict and returns `409` — the caller is reusing a key for a new intent, which is always a bug.

## Errors

Every refusal returns a typed code so the caller branches on the code, not the message.

- `capture_not_found` — no capture for that id under this merchant.
- `already_refunded` — the capture has a non-failed refund already.
- `not_capturable` — the payment is authorized but not captured.
- `idempotency_conflict` — the key was reused with a different body.

## Open questions

Two decisions are deferred, not forgotten. First, whether a `failed` refund should auto-retry on a transient processor error or always require a fresh call — v0 requires the fresh call. Second, how partial refunds will pin to a capture once v1 introduces them; the idempotency model above should extend without a breaking change. Both are tracked for the v1 review.
