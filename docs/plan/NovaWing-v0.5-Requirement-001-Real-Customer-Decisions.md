# Requirement 001 real customer decisions — planning audit

Date: 2026-09-27. Planning session: `d1acd690-5722-4d08-99b2-64be77f7093f`.

The original Requirement 001 text remains unchanged. Source plan v1 passed deterministic and independent semantic review, then stopped at `needs_customer_input` with blocking questions Q1–Q3. Its offered options did not exactly match the customer's final rules. The customer decisions were recorded through the formal CustomerAnswer path as `custom` answers, each bound to source plan v1 with `provenance: customer_decision`.

| Question | Customer decision |
| --- | --- |
| Q1 — cancellation | Only the customer may initiate cancellation. Before pickup it succeeds and persists `CANCELLED`; after pickup it is rejected without changing the saved state. The merchant cannot proactively cancel. No formal refund system is added. |
| Q2 — today order count | Count orders created today that are paid and not cancelled. Unpaid, paid then cancelled, and earlier-created orders are excluded. |
| Q3 — today turnover | Sum the actual paid amount for exactly the same valid-order set as Q2, assigned by creation date. No separate today payment, refund, net turnover, or formal refund feature is added. |

The planning provider generated v2 from those recorded decisions. The first invocation passed deterministic validation but received two independent semantic findings; its repair call timed out and did not persist v2. A rerun from the unchanged saved answers generated and persisted v2. Final gates: deterministic **PASS**, semantic **PASS**, 25/25 MUST clauses with blocking assertion coverage, zero blocking customer questions, status `ready_for_approval`.

Blocking cancellation assertions `AS106`–`AS112` distinguish customer cancellation before and after pickup, merchant rejection, observable results, and reread of persisted states. Metric assertions `AS113`–`AS116` use O1 created on D1 and paid on D2 (80), O2 created on D1 and unpaid (40 order value), O3 created on D1 and paid then cancelled (60), O4 created on D0 and paid on D1 (100), plus O5/O6 to distinguish later dates. For D1, only O1 contributes: count **1**, turnover **80**. O2/O3/O4 are excluded. The plan also compares the two metrics' contributing order IDs and checks the turnover change from 140 to 80 when O3 is cancelled.

This is a planning result awaiting the customer's approval. No approval, frozen snapshot, Work Session, Runtime compiler, or business implementation was started. The source v1 and v2 plans and CustomerAnswers are stored in the local Customer Mode planning data directory; historical benchmark files remain untouched.
