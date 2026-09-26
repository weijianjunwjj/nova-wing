# NovaWing v0.5 — Requirement 001 Phase 1 Product Acceptance Audit

## Audit identity and method

- Date: 2026-09-26; branch: `feat/v0.5-customer-mode`; `HEAD_BEFORE`: `7f85eb797d20767244c9517340033ccd05c29021`.
- Source: `tests/fixtures/requirement-001.txt`, SHA-256 `16a0b09340e4f0f37ba53be7c02319605721a29e38a65acfac4ba137499a0fe8` (3,854 UTF-8 bytes). Its substantive content matches the original customer request used by the Phase 1 benchmark; the external copy has one extra trailing blank line.
- Execution: Node v24.21.0, current source compiled, real local Launchpad `POST /api/planning/generate`, real default Codex planning provider, isolated `NOVAWING_DATA_DIR` and empty trusted config directory. No fixture provider, feedback, revision, approval, Runtime call, or manual edit to the returned plan. HTTP 200; plan `cf5660de-d085-4afe-962f-3afc69dc372d`, version 1, `ready_for_approval`. The complete returned `DevelopmentPlan` is preserved verbatim by value in the appendix. The temporary HTTP response and plan store were retained outside the repository for this audit run.
- Deterministic validator: PASS, zero issues, 100% MUST task coverage and 100% MUST blocking acceptance coverage. **This is ID coverage, not a semantic product pass.** The newly generated plan has **21** MUST clauses, **6** tasks, and **6** criteria. The earlier checked-in benchmark sample has **22 / 8 / 22**. This audit evaluates the newly generated plan as the current result and uses the earlier 22 clauses and 22 criteria as an independent source-level comparison. No historical item is silently presented as part of the new plan.

## Verdict

| Field | Result |
| --- | --- |
| PRODUCT_ACCEPTANCE | **FAIL** |
| REQUIREMENT_UNDERSTANDING | Product goal, two roles, included scope, and all 15 explicit non-goals are substantially correct. All 22 historical requirement themes appear in the new plan, although its 21-clause extraction merges two engineering themes. One unapproved paid-only interpretation of today's order count changes business meaning. |
| TASK_DAG_QUALITY | Acyclic and broadly in delivery order, but T1, T2, and T4 are too broad for independent executor handoff. T1 maps customer-facing requirements to storage-only work; the task-to-criterion links do not provide an action-level implementation contract. |
| ACCEPTANCE_QUALITY | **FAIL. All 6 current blocking criteria are weak in at least one mapped behavior.** Command success is paired with a core-flow claim in A6, but the stated path omits required steps and the evidence does not require the same order and cross-role observations. |
| CUSTOMER_QUESTION_POLICY | Zero questions is not acceptable for this specific plan because `CANCELLED` behavior and the newly chosen paid-only daily order-count meaning affect business semantics. Technology and excluded features should not become questions. |
| ARCHITECTURE_BOUNDARY | PASS for the specified boundary: the customer-visible plan does not name Codex, Claude, DeepSeek, model selection, Reviewer, shell commands, allowed paths, WorkSession wiring, or checkpoint internals. Payment Adapter is in the customer's request. |
| TELEMETRY_BOUNDARY | PASS for this run and the inspected writer: events contain closed metadata, provider/model identifier and duration, with no requirement text, revision note, prompt, response, or secret. Usage is `{}` and cost is absent; neither is fabricated. Revision-note behavior is supported by source inspection because this run had no revision. |
| WEAK_ACCEPTANCE | **A1–A6 (6 current criteria).** See criterion-by-criterion findings below. Four historical reference criteria also need tightening; they are not included in the current count. |
| MISSING_REQUIREMENTS | **0 wholly absent source themes.** Six material source behaviors lack sufficient blocking proof in the current acceptance plan: cart deletion and total arithmetic; address create/edit/select; complete persisted order fields; merchant receipt of the paid order and Adapter replaceability; exact state/cancellation rules; all steps of the customer's cross-role core path. |
| INVENTED_SCOPE | **1 unapproved business rule:** A5 narrows “今日订单数” to paid/closed transactions, although the customer specified only today's order count. Product architecture choices and data snapshots are implementation choices, not counted as invented business scope. |
| QUESTIONABLE_ASSUMPTIONS | S1 and S2 restate explicit single-merchant/Mock boundaries. S3 reasonably treats paid, non-cancelled orders as turnover, but does not define the business day or whether today's order **count** includes unpaid/cancelled orders; A5 silently chooses a paid-only count. |
| CUSTOMER_QUESTIONS_THAT_SHOULD_EXIST | (1) Who may cancel, and at which order stages, especially after simulated payment or acceptance? (2) Does “今日订单数” include unpaid and cancelled orders, or only successfully paid orders? The answer determines A5's counting rule. |
| CUSTOMER_QUESTIONS_THAT_SHOULD_NOT_EXIST | No standalone questions about refunds, delivery fees, delivery distance, multiple merchants, independent couriers, discounts, inventory, or real payment integration. These are absent or explicitly excluded; cancellation can be discussed without adding real refund capability. No framework, database, model, Reviewer, command or runtime question. |
| WOULD_A_REASONABLE_CUSTOMER_APPROVE | **NO.** A customer could see 100% coverage and approve a plan whose evidence permits a cart without delete/accurate total, uneditable addresses, paid orders invisible to the merchant, and an incomplete cross-role acceptance path. Cancellation rights and order-count meaning are also undecided. |

## Requirement understanding and semantic traceability

The left IDs and themes come from the **historical 22-clause benchmark inventory** and are used only as an audit checklist. The middle IDs, tasks, and criteria belong to the **new actual plan**. “Gap” means that the requirement is mentioned but the linked blocking proof can still pass without the full customer behavior. Every source location is in the original Requirement 001 text.

| Original 22-theme inventory and source | New clause → task → criterion | Semantic assessment |
| --- | --- | --- |
| B-R1 单商户；产品背景 | R1 → T1 → A1 | Partial: single-merchant data is checked; no explicit customer/admin context check. |
| B-R2 本地模拟登录；顾客端/登录 | R2 → T2 → A2 | Covered: no third-party credential and customer entry are stated. |
| B-R3 分类/名称/图片/描述/价格/可售；顾客端/浏览 | R3 → T1,T2 → A1,A2 | Gap: A1 is storage-only; A2 says “字段” without naming or checking all six visible fields. |
| B-R4 SKU/不同价格；顾客端/规格 | R4 → T1,T2 → A1,A2 | Gap: selecting differently priced SKU is mentioned, but no required before/after price or persisted unit-price assertion. |
| B-R5 加入/改数量/删除/合计；顾客端/购物车 | R5 → T2 → A2 | **Gap:** “修改购物车” can pass without deletion or correct total arithmetic. |
| B-R6 新建/编辑/选择地址及三字段；顾客端/地址 | R6 → T1,T2 → A1,A2 | **Gap:** address storage and an order with an address do not prove create, edit, select, or chosen-address propagation. |
| B-R7 订单十项字段；顾客端/提交订单 | R7 → T1,T2 → A1,A2 | **Gap:** “所需快照字段/完整字段” do not enumerate and assert all ten saved values after reread. |
| B-R8 Mock 支付→商家待处理、可替换；顾客端/支付 | R8 → T3 → A3 | **Gap:** PAID is checked; merchant seeing the same paid order and replacing the Adapter without changing ordering behavior are not required by A3. |
| B-R9 顾客列表/详情/状态；顾客端/查看订单 | R9 → T5 → A5 | Covered at a high level; should reread after merchant transitions. |
| B-R10 商家 Web 后台；商家后台 | R10 → T4 → A4 | Covered. |
| B-R11 商品创建/编辑/上下架/分类/SKU；后台/商品管理 | R11 → T4 → A4 | Partial: actions are listed, but evidence need not show the changed catalog/SKU/availability to a customer. |
| B-R12 商家订单详情及完整状态序列；后台/订单管理 | R12, R13 → T4,T3 → A4,A3 | **Gap:** A4 jumps from paid to delivering/completed; A3 says transitions are legal, but neither mapped criterion explicitly requires the same order to visit ACCEPTED and PREPARING in the merchant UI. A6 mentions these stages but is mapped only to R17, not R12. |
| B-R13 合理 CANCELLED；后台/订单管理 | R13 → T3 → A3 | **Gap:** “合理” is circular without actor, eligible stage, and post-cancel behavior. |
| B-R14 商家自营配送、不需骑手 App；后台/自营配送 | R14 → T4 → A4 | Covered for backend delivery and completion, subject to state sequence proof above. |
| B-R15 今日订单数/成交金额；后台/基础统计 | R15 → T5 → A5 | Questionable: A5 appears to count only paid orders, which the customer did not state; date and cancellation treatment need an agreed rule. |
| B-R16 15 项非目标；第 5 节 | R16 → T6 → A6 | Partial: out-of-scope list is complete, but A6's generic checklist does not name every exclusion. |
| B-R17 实际执行 13 步核心路径；第 6 节 | R17 → T6 → A6 | **Gap:** A6 skips explicit product browsing, add-to-cart, address creation/selection, merchant order arrival and same-order evidence. |
| B-R18 真正状态闭环；第 6 节 | R18 → T3 → A3 | Partial: persistence and both-side reads are stated, but not refresh/requery of the same order after each transition. |
| B-R19 明确可重复验证入口；第 7 节 | R19 → T6 → A6 | Covered as a deliverable; a repeat on clean data is not independently required by evidence. |
| B-R20 install/typecheck/tests/build/cold start/core flow；第 7 节 | R19 → T6 → A6 | Covered in text; this is the historical clause merged into new R19, accounting for 22→21. |
| B-R21 条件性空库/迁移/seed/fresh start；第 7 节 | R20 → T1,T6 → A1,A6 | Covered, because the plan chooses a database. Require proof that the app starts from that same empty database. |
| B-R22 不依赖脏数据；第 7 节 | R21 → T1,T6 → A1,A6 | Covered in intent; separate storage paths and end-to-end run should make isolation provable. |

**Coverage conclusion:** all 22 customer themes have a new clause or a merged clause. The declared 100% refers only to nonempty ID references. It does **not** mean that all 22 are semantically demonstrated by their blocking criterion. The baseline 22/8/22 sample is more granular than this new 21/6/6 generation; that variability itself prevents treating the prior sample's result as today's product evidence.

## Task quality and DAG

| Current task | Objective, size and deliverables | Dependencies, mapping and executor readiness |
| --- | --- | --- |
| T1 单商户数据模型与初始化 | Clear storage objective, real schema/migration/seed outputs, but **large** and spans seven clauses. | Root is sensible. R3/R4/R6 customer interactions are mapped here for coverage even though A1 can only prove storage; executor would need T2 for these behaviors. Split acceptance responsibilities conceptually before approval. |
| T2 顾客点餐和订单创建 | Useful objective but **large**: login, catalog, SKU, cart, address and checkout are separate deliverable surfaces. | T1 dependency is reasonable. One criterion A2 cannot tell the executor which cart, address or pricing states must be demonstrated. |
| T3 支付适配和订单状态机 | Medium size and tangible Adapter/state outputs. | Depends on T1/T2; order creation before payment is sensible. R8 mapping lacks merchant arrival, while R13 has no decided cancellation rule. |
| T4 商家后台商品和订单管理 | Large combined catalog administration and full fulfillment; outputs are deliverable. | T1 and T3 are enough for order flow, while product CRUD could develop independently of payment. A4 lacks customer-side effects and full status sequence, so handoff is under-specified. |
| T5 顾客订单查询和商家统计 | Two distinct outputs bundled into one medium task. | T3/T4 order-state dependencies are plausible. R9/R15 mapping is direct, but statistic count semantics are unapproved; customer order lookup could start before all of T4. |
| T6 范围保护和 repeatable acceptance | Real handoff artifacts, though scope protection is a cross-cutting delivery gate rather than a standalone product feature. | Final dependency on T1–T5 is sensible. A6 bundles all commands and business flow; a successful command log cannot substitute for explicit same-order, two-role outcome assertions. |

The graph has no cycle and broadly follows data → customer order → payment/state → merchant fulfillment → lookup/reporting → delivery validation. A future Executor would understand the broad work packages, but **not enough to implement and prove the exact customer contract without additional product decisions and more granular acceptance**. Several dependencies serialize independently buildable work; the more serious problem is underspecified completion, not the DAG shape.

### Historical eight-task benchmark comparison

The following eight tasks belong to the checked-in **reference sample**, not the new plan. They are reviewed separately because the requested eight-task audit cannot truthfully be applied to a six-task response.

| Reference task | Objective, deliverables, mapping, dependency and executor judgment |
| --- | --- |
| T1 单商户基线/模拟身份 | Medium and coherent; single-merchant boundary, mock login and exclusion list are deliverable. Root dependency is sound. R16/A16 needs itemized scope proof; otherwise executor can deliver only a generic statement. |
| T2 商品目录/SKU/商家管理 | Large but cohesive catalog slice; customer catalog and merchant CRUD are real outputs. T1 prerequisite is reasonable. R10/A10 broad admin capability is only partly delivered by catalog admin; merchant order admin comes in T6. |
| T3 购物车/地址/订单快照 | Large yet coherent checkout slice with concrete artifacts and A5–A7 proof. T1/T2 prerequisites are sensible. A6 should prove that edited/selected address reaches the persisted order. |
| T4 Mock 支付/状态机 | Large cross-role business core with real outputs. T3 dependency is correct. Maps R12/R14 even though merchant operating UI is later T6; Executor needs to distinguish state-service completion from merchant workflow completion. A13's undefined cancellation policy is a handoff blocker. |
| T5 顾客订单查询 | Moderate single-purpose task, clear outputs and R9/A9 match. T4 dependency works for latest status testing, though basic list/detail could develop earlier. |
| T6 商家订单后台/统计 | Large but clear admin delivery. T2/T4 dependencies support catalog and state flow. A10/A12 overlap earlier T2/T4 ownership; T6 should own the merchant UI evidence. Stats formula remains undecided. |
| T7 端到端核心路径 | Medium validation task with real repeatable evidence. Dependencies T2–T6 enforce a completed cross-role path. A17 should name every source arrow and same-order evidence. |
| T8 干净环境工程验证 | Medium delivery task with real outputs. T1–T6 dependencies omit T7 even though R20/A20 says core business flow is covered. As written, T8 could finish before the actual E2E acceptance task; either depend on T7 or explicitly invoke the same verified flow. |

The historical eight-task graph is acyclic and more granular than today's six-task graph. Its T8→T7 omission and overlapping criterion ownership show that even the stronger historical breakdown was not a complete executor contract.

## Current acceptance quality — all 6 actual criteria

All six are marked `blocking: true`; none is purely a build or typecheck command. Nevertheless, each can produce a product false positive. `WEAK_ACCEPTANCE` is an audit label, not a modification to the generated plan.

| Criterion and mapped clauses | Why WEAK_ACCEPTANCE; possible false positive | Better acceptance target and evidence |
| --- | --- | --- |
| **A1** R1,R3,R4,R6,R7,R20,R21 | An empty DB can migrate and contain seeded catalog and blank order structures while no usable customer catalog/address/checkout exists. “所需快照字段” is not a field-by-field assertion. | On an isolated empty DB, initialize then start the app; query the exact single-merchant records and create/reload an order asserting every required field, SKU price and chosen address. Keep customer UI checks in their own criterion. |
| **A2** R2–R7 | A UI test may login, view some product text, “modify” a cart, and submit one preselected address while deletion, total calculation, address create/edit/select, and each catalog/record field fail. | Require at least two differently priced SKUs and assert selected price and saved unit price; add/change quantity/delete cart items with exact totals; create/edit/select an address and verify its contact/phone/location on the new and reloaded order; assert all six catalog and ten order fields. |
| **A3** R8,R13,R18 | PAID plus generic legal transitions does not prove the merchant receives a processable order. A fake Adapter boundary can remain hardwired; “reasonable CANCELLED” passes without a defined rule. The same order might not persist across both roles. | From a newly created PENDING_PAYMENT order, simulate payment and prove the same ID appears in merchant pending orders; demonstrate Adapter substitution through its contract. After the customer decides cancellation policy, test allowed and forbidden cancel stages and persisted results. Reread status from both roles after transitions. |
| **A4** R10–R12,R14 | Backoffice button recordings can pass even if customer catalog does not reflect edits or a paid order skips acceptance/preparation before delivery. It does not demand same-ID order details across views. | Create/edit/list/delist product/category/SKU in admin and verify customer-visible changes. On the same paid order, inspect admin list/detail, advance ACCEPTED→PREPARING→DELIVERING→COMPLETED, and verify each step in persisted state and customer detail. |
| **A5** R9,R15 | A correct-looking dashboard may count only paid orders because the wording already assumes a paid-only order count. A single sample cannot distinguish today vs yesterday, cancelled vs active, or list vs detail status freshness. | Agree the daily count/turnover rule first. Seed paid, unpaid, cancelled and adjacent-day orders in the chosen business timezone; calculate expected counts/amounts explicitly and compare to the UI. After a merchant transition, refresh customer list/detail for the same order. |
| **A6** R16,R17,R19–R21 | Successful install/typecheck/tests/build and a generic “end-to-end passed” can coexist with an E2E script that skips browse, add-to-cart, address creation/selection and merchant order arrival. A generic scope checklist can omit some of 15 exclusions. | On one fresh data set, record the exact 13 customer-specified actions and the same order ID across customer and merchant UIs, persisted transitions and final customer refresh. Separately record all required engineering gate results and enumerate each explicit non-goal in scope review. A passing command is supporting evidence, never the only business evidence. |

## Historical 22 acceptance criteria — separate reference check

These are the 22 `A1`–`A22` items in `tests/fixtures/requirement-001-model-output.json`. They are **not** the criteria returned in this run. This table evaluates each to satisfy the full benchmark comparison; its labels do not change the current weak count of 6.

| Reference criterion | Assessment against source and evidence |
| --- | --- |
| A1 | Adequate single-merchant UI/data check; a full order flow is useful confirmation. |
| A2 | Adequate no-credential login check in a clean environment. |
| A3 | Adequate six-field customer catalog assertion. |
| A4 | Adequate multi-SKU price change plus saved SKU/unit price. |
| A5 | Adequate add/change/delete and exact total assertions. |
| A6 | Adequate create/edit/select address actions; improve by checking chosen address in the created order. |
| A7 | Adequate explicit ten-field persisted order readback. |
| A8 | Adequate same-order merchant arrival and Adapter boundary; improve replaceability proof with a second implementation in test. |
| A9 | Adequate customer list/detail and persisted state consistency. |
| A10 | Broad admin-access smoke, but A11/A12 carry the actual business checks. |
| A11 | Adequate CRUD/catalog propagation; verify both listing and delisting. |
| A12 | Adequate same-order state sequence across merchant/customer views. |
| **A13 — WEAK_ACCEPTANCE** | “符合状态机规则” never defines who may cancel or when. A no-op or arbitrary cancel policy could pass. Agree policy, then assert allowed and rejected transitions after requery. |
| A14 | Adequate merchant self-delivery action without courier dependency. |
| **A15 — WEAK_ACCEPTANCE** | “当日已成交订单” leaves order-count and turnover composition unclear, especially paid-then-cancelled orders. Agree formula/day boundary; test mixed statuses and adjacent dates with hand-calculated totals. |
| **A16 — WEAK_ACCEPTANCE** | Categories of exclusions omit item-by-item evidence for the full 15-item customer list. An unlisted excluded capability could slip through. Enumerate each exclusion in the review record. |
| A17 | Strong same-order E2E evidence, but explicitly add catalog browse and address creation/selection so all customer arrows are observed. |
| A18 | Strong persisted state and both-side refresh test. |
| **A19 — WEAK_ACCEPTANCE** | A single successful invocation plus documentation does not prove repeatability. Run the documented entry twice from separate fresh environments and compare outputs/outcomes. |
| A20 | Command results plus core flow are appropriate **if** the referenced core flow is the real customer E2E path; command success alone is insufficient. |
| A21 | Adequate fresh DB migration/seed/start evidence. |
| A22 | Adequate fresh data and completed core-flow evidence, provided isolation is recorded. |

## Customer question policy

The actual result has `customerQuestions: []`. The count alone is neutral; the content makes it inadequate here.

**A — Business decisions:** Requirement 001 explicitly permits a “reasonable” `CANCELLED` state but does not say who may cancel, which states permit it, or what happens to a simulated paid order. That changes customer and merchant behavior. Ask one bounded cancellation-policy question with concrete stage/actor choices; do not presume a real refund system. The plan's A5 separately imposes a paid-only interpretation on “今日订单数”; ask whether unpaid/cancelled orders count, or present a concrete proposed rule for explicit customer acceptance before treating it as a requirement.

**B — NovaWing decisions:** Choose UI stack, local database and schema, Adapter design, test runner, time handling implementation, API shape and verification commands internally. The chosen relational database is within the engineering discretion the customer granted. A local business timezone can be a documented default; the metric composition is the business decision.

**C — Non-goals, not questions:** Refund/real payment, platform multi-merchant, courier app, discounts and marketing are excluded or unrequested. Delivery fee, distance/routing and inventory are unrequested; no question should pull them into the MVP. A cancellation question should focus on cancellation eligibility and state, not offer a refund feature.

## Architecture and telemetry boundary

The actual plan's goal, tasks, dependencies and acceptance discuss the customer's product and product architecture. It includes implementation-level decisions about persistence, status machine and Mock Payment Adapter; these are product delivery choices, not NovaWing Runtime wiring. A scan of the actual customer-visible plan fields found none of the forbidden model/Reviewer/Executor, shell, allowed-path, WorkSession or checkpoint concepts. The plan's `requirement.text` naturally contains the customer's original technical verification terms; these are source requirements, not leaked NovaWing internals.

This run wrote five telemetry events: `requirement.received`, `planning.started`, `requirement.analyzed`, `development_plan.generated`, `plan.validation_passed`. The generated event records `provider=codex`, `model=gpt-5.6-terra`, `durationMs=108537`, `usage={}`, plan version and task count. There is no `estimatedCost` and no token count. A raw event-file inspection found no exact requirement, source excerpt, plan response text, prompt prefix, revision-note field, or secret-like string. Source inspection confirms event metadata is a closed numeric whitelist and provider/model identifiers are filtered; revision feedback is sent to the provider and stored in the plan's requirement record, not passed to telemetry. The source has no invocation-level token/cost recovery from this provider, so empty usage means unknown, not zero. For clarity, future telemetry could omit an empty usage object, but this is not a fabricated metric. The stored DevelopmentPlan is separate plan data, not telemetry.

## Approval decision and scope of this audit

**PRODUCT_ACCEPTANCE: FAIL. WOULD_A_REASONABLE_CUSTOMER_APPROVE: NO.** The customer should receive a revised **product plan** with explicit cancellation and daily-count decisions, narrower task completion contracts, and blocking evidence for every source action, especially the full same-order cross-role flow. This audit did not approve or revise the plan and did not start Phase 2 or Runtime execution.

## Appendix — complete actual DevelopmentPlan

The JSON block below is the complete `plan` value returned by the real Phase 1 HTTP pipeline. It is pretty-printed for reading; no field value was edited. The separate `validation` value is reported in the audit identity above.

```json
{
  "clauses": [
    {
      "id": "R1",
      "statement": "系统仅服务单一商户，不采用平台型多商户模式。",
      "type": "constraint",
      "priority": "must",
      "source": {
        "excerpt": "目前只有一个商户，不考虑平台型多商户模式。",
        "location": "产品背景"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R2",
      "statement": "首版必须提供无需第三方账号、密钥或真实微信 AppID即可完整本地运行的模拟登录。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "首版必须支持无需第三方账号和密钥即可完整本地运行的模拟登录。",
        "location": "顾客端 > 登录系统"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R3",
      "statement": "顾客可以浏览商品分类、名称、图片、描述、价格和可售状态。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "商品分类\n- 商品名称\n- 图片\n- 描述\n- 价格\n- 可售状态",
        "location": "顾客端 > 浏览商品"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R4",
      "statement": "支持部分商品配置 SKU/规格，不同 SKU 可有不同价格。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "选择不同 SKU 后价格可以不同。",
        "location": "顾客端 > 商品规格"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R5",
      "statement": "顾客可以加入商品、修改数量、删除商品并查看购物车合计金额。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "加入商品\n- 修改数量\n- 删除商品\n- 查看合计金额",
        "location": "顾客端 > 购物车"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R6",
      "statement": "顾客可以新建、编辑和选择本次订单配送地址；地址至少包含联系人、手机号和地址。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "新建地址\n- 编辑地址\n- 选择本次订单配送地址",
        "location": "顾客端 > 配送地址"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R7",
      "statement": "订单至少持久化商品、SKU、数量、单价、总金额、配送地址、联系人、手机号、订单状态和创建时间。",
      "type": "business-rule",
      "priority": "must",
      "source": {
        "excerpt": "商品\n- SKU\n- 数量\n- 单价\n- 总金额\n- 配送地址\n- 联系人\n- 手机号\n- 订单状态\n- 创建时间",
        "location": "顾客端 > 提交订单"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R8",
      "statement": "支付采用 Mock Payment/Payment Adapter，顾客可完成下单、模拟支付成功，且商家收到待处理订单；设计应可替换为真实支付实现。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "下单 → 模拟支付成功 → 商家收到待处理订单",
        "location": "顾客端 > 支付"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R9",
      "statement": "顾客可以查看订单列表、订单详情和当前订单状态。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "查看订单列表\n- 查看订单详情\n- 查看当前订单状态",
        "location": "顾客端 > 查看订单"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R10",
      "statement": "提供商家 Web 管理后台。",
      "type": "constraint",
      "priority": "must",
      "source": {
        "excerpt": "商家需要一个 Web 管理后台。",
        "location": "4. 商家后台"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R11",
      "statement": "商家可创建、编辑、上架或下架商品，并管理商品分类和 SKU。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "创建商品\n- 编辑商品\n- 上架 / 下架商品\n- 管理商品分类\n- 管理 SKU",
        "location": "4. 商家后台 > 商品管理"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R12",
      "statement": "商家可以查看订单列表和详情，并推进订单状态。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "商家可以看到订单列表和订单详情。\n\n商家能够推进订单状态。",
        "location": "4. 商家后台 > 订单管理"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R13",
      "statement": "订单状态须支持从 PENDING_PAYMENT 经 PAID、ACCEPTED、PREPARING、DELIVERING 到 COMPLETED 的完整业务闭环，并允许 CANCELLED。",
      "type": "business-rule",
      "priority": "must",
      "source": {
        "excerpt": "最终必须支持完整业务闭环。",
        "location": "4. 商家后台 > 订单管理"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": "状态名称可按规划优化，但必须保留等价的完整闭环。"
      }
    },
    {
      "id": "R14",
      "statement": "配送为商家自营跑腿；无需独立骑手 App，后台可将订单推进至配送中和已完成。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "Requirement 001 不需要独立骑手 App。\n\n后台能够将订单推进到：\n\n- 配送中\n- 已完成",
        "location": "4. 商家后台 > 自营配送"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R15",
      "statement": "后台至少展示今日订单数和今日成交金额，不建设复杂 BI。",
      "type": "functional",
      "priority": "must",
      "source": {
        "excerpt": "今日订单数\n- 今日成交金额",
        "location": "4. 商家后台 > 基础统计"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R16",
      "statement": "不得实现明确列出的非目标，也不得主动扩张范围。",
      "type": "constraint",
      "priority": "must",
      "source": {
        "excerpt": "不要主动扩张范围。",
        "location": "5. 非目标"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R17",
      "statement": "必须可实际执行从顾客登录、选购和模拟支付，到商家处理、配送完成，再到顾客看到完成状态的核心端到端路径。",
      "type": "quality",
      "priority": "must",
      "source": {
        "excerpt": "必须能够实际执行：",
        "location": "6. 最终核心验收路径"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": "完整步骤以验收路径中箭头顺序为准。"
      }
    },
    {
      "id": "R18",
      "statement": "实现必须具有真实状态闭环，只有页面而没有状态闭环不通过。",
      "type": "quality",
      "priority": "must",
      "source": {
        "excerpt": "任何只做页面、没有真实状态闭环的实现都不算通过。",
        "location": "6. 最终核心验收路径"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R19",
      "statement": "项目必须具备明确、可重复执行的工程验证机制，覆盖安装、类型检查、测试、构建、冷启动或干净启动及核心业务流程。",
      "type": "delivery",
      "priority": "must",
      "source": {
        "excerpt": "最终项目至少需要存在明确且可重复执行的验证机制。",
        "location": "7. 工程验收"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    },
    {
      "id": "R20",
      "statement": "若采用数据库，必须验证空环境初始化、schema/migration、seed或等效测试数据，以及全新数据库可启动。",
      "type": "delivery",
      "priority": "must",
      "source": {
        "excerpt": "如果项目采用数据库，需要验证：\n\n- 空环境初始化\n- schema / migration\n- seed 或等效测试数据方案\n- fresh database 可以启动",
        "location": "7. 工程验收"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": "仅在选用数据库时适用。"
      }
    },
    {
      "id": "R21",
      "statement": "系统运行不得依赖开发过程遗留的本地脏数据。",
      "type": "constraint",
      "priority": "must",
      "source": {
        "excerpt": "不能依赖开发过程中遗留下来的本地脏数据才能运行。",
        "location": "7. 工程验收"
      },
      "ambiguity": {
        "ambiguous": false,
        "note": ""
      }
    }
  ],
  "analysis": {
    "productGoal": "交付一个可本地独立运行的单商户餐饮点餐系统，使顾客下单并模拟支付后，商家可完成自营配送处理，双方看到一致的订单状态。",
    "summary": "范围覆盖顾客点餐、商家后台、模拟支付、订单状态闭环、基础统计和可重复工程验收；不扩展为平台、骑手或营销系统。",
    "userRoles": [
      {
        "id": "U1",
        "name": "顾客",
        "goals": [
          "模拟登录",
          "浏览和选择商品 SKU",
          "维护地址",
          "下单并模拟支付",
          "跟踪订单状态"
        ]
      },
      {
        "id": "U2",
        "name": "商家",
        "goals": [
          "维护商品、分类和 SKU",
          "处理并推进订单",
          "完成自营配送",
          "查看当日基础经营数据"
        ]
      }
    ],
    "businessFlows": [
      {
        "id": "F1",
        "title": "顾客下单与模拟支付",
        "steps": [
          "顾客模拟登录",
          "浏览可售商品并选择 SKU",
          "加入购物车并调整数量",
          "创建或选择配送地址",
          "创建包含价格快照和联系信息的订单",
          "完成模拟支付",
          "订单成为商家待处理订单"
        ],
        "requirementIds": [
          "R2",
          "R3",
          "R4",
          "R5",
          "R6",
          "R7",
          "R8"
        ]
      },
      {
        "id": "F2",
        "title": "商家自营履约与顾客查询",
        "steps": [
          "商家在后台查看已支付订单",
          "商家接单",
          "商家开始制作",
          "商家开始配送",
          "商家完成订单",
          "顾客在订单详情看到完成状态"
        ],
        "requirementIds": [
          "R9",
          "R10",
          "R12",
          "R13",
          "R14",
          "R17",
          "R18"
        ]
      },
      {
        "id": "F3",
        "title": "商家商品与经营管理",
        "steps": [
          "商家维护分类、商品和 SKU",
          "商家控制商品上架状态",
          "后台汇总今日订单数和成交金额"
        ],
        "requirementIds": [
          "R3",
          "R4",
          "R11",
          "R15"
        ]
      }
    ]
  },
  "productScope": {
    "inScope": [
      "单商户顾客点餐端",
      "本地模拟登录",
      "商品、分类、SKU 与可售状态",
      "购物车、地址、订单和模拟支付",
      "商家 Web 管理后台",
      "自营配送状态推进",
      "今日订单数和今日成交金额",
      "可重复的本地工程与核心流程验证"
    ],
    "outOfScope": [
      "多商户平台",
      "骑手独立 App",
      "智能派单",
      "地图路线规划",
      "优惠券系统",
      "积分",
      "会员等级",
      "分销",
      "营销中心",
      "复杂 RBAC",
      "真实微信支付",
      "真实微信登录",
      "云端生产部署",
      "高并发架构",
      "微服务"
    ]
  },
  "architecture": {
    "summary": "采用单体应用边界：顾客端和商家 Web 后台通过同一业务 API 访问持久化订单域；订单状态机、支付适配器和数据初始化机制作为独立业务组件。",
    "components": [
      "顾客点餐界面",
      "商家 Web 管理后台",
      "商品、分类与 SKU 服务",
      "购物车、地址与订单服务",
      "订单状态机",
      "Mock Payment Adapter 接口及实现",
      "持久化数据层、迁移与种子数据",
      "今日经营汇总查询",
      "可重复工程与端到端验证套件"
    ],
    "decisions": [
      "使用单商户数据模型，不引入商户租户隔离。",
      "以服务端订单状态机约束合法流转并持久化状态历史或等价审计信息。",
      "在创建订单时保存商品、SKU、单价和配送信息快照，避免后续商品或地址编辑改变历史订单。",
      "支付通过稳定的适配器边界接入 Mock 实现，保留未来真实支付替换位置。",
      "选用关系型持久化方案并交付迁移、空库初始化和确定性种子数据，以满足干净环境验收。"
    ]
  },
  "tasks": [
    {
      "id": "T1",
      "title": "建立单商户数据模型与可重复初始化",
      "objective": "实现单商户商品、SKU、地址、订单和订单项的持久化结构，以及空库迁移和确定性测试数据。",
      "requirementIds": [
        "R1",
        "R3",
        "R4",
        "R6",
        "R7",
        "R20",
        "R21"
      ],
      "outputs": [
        "schema 与 migration",
        "商品分类、商品、SKU、地址、订单数据模型",
        "fresh database 初始化与 seed 方案"
      ],
      "dependencyIds": [],
      "acceptanceCriterionIds": [
        "A1"
      ],
      "complexity": "large"
    },
    {
      "id": "T2",
      "title": "实现顾客点餐和订单创建",
      "objective": "提供模拟登录、商品浏览、规格选择、购物车、地址管理和订单创建体验。",
      "requirementIds": [
        "R2",
        "R3",
        "R4",
        "R5",
        "R6",
        "R7"
      ],
      "outputs": [
        "顾客登录与点餐界面",
        "购物车与地址管理",
        "订单创建服务"
      ],
      "dependencyIds": [
        "T1"
      ],
      "acceptanceCriterionIds": [
        "A2"
      ],
      "complexity": "large"
    },
    {
      "id": "T3",
      "title": "实现支付适配与订单状态机",
      "objective": "通过 Mock Payment Adapter 完成支付，并以受控状态机支持取消和完整履约闭环。",
      "requirementIds": [
        "R8",
        "R13",
        "R18"
      ],
      "outputs": [
        "Payment Adapter 接口与 Mock 实现",
        "订单支付状态处理",
        "合法状态转换规则"
      ],
      "dependencyIds": [
        "T1",
        "T2"
      ],
      "acceptanceCriterionIds": [
        "A3"
      ],
      "complexity": "medium"
    },
    {
      "id": "T4",
      "title": "实现商家后台商品和订单管理",
      "objective": "交付商家 Web 后台，用于商品维护、订单查看和履约状态推进。",
      "requirementIds": [
        "R10",
        "R11",
        "R12",
        "R14"
      ],
      "outputs": [
        "商品分类、商品和 SKU 管理界面",
        "订单列表与详情",
        "自营配送履约操作"
      ],
      "dependencyIds": [
        "T1",
        "T3"
      ],
      "acceptanceCriterionIds": [
        "A4"
      ],
      "complexity": "large"
    },
    {
      "id": "T5",
      "title": "实现顾客订单查询和商家基础统计",
      "objective": "让顾客查看订单实时状态，并让商家查看当日订单数和成交金额。",
      "requirementIds": [
        "R9",
        "R15"
      ],
      "outputs": [
        "顾客订单列表与详情",
        "当日订单数和成交金额汇总视图"
      ],
      "dependencyIds": [
        "T3",
        "T4"
      ],
      "acceptanceCriterionIds": [
        "A5"
      ],
      "complexity": "medium"
    },
    {
      "id": "T6",
      "title": "交付范围保护与可重复验收",
      "objective": "固定非目标边界，提供安装、检查、构建、干净启动和端到端闭环的可重复验证。",
      "requirementIds": [
        "R16",
        "R17",
        "R19",
        "R20",
        "R21"
      ],
      "outputs": [
        "工程验证说明与自动化入口",
        "干净环境验证脚本或等效机制",
        "核心闭环端到端验证"
      ],
      "dependencyIds": [
        "T1",
        "T2",
        "T3",
        "T4",
        "T5"
      ],
      "acceptanceCriterionIds": [
        "A6"
      ],
      "complexity": "medium"
    }
  ],
  "acceptancePlan": {
    "strategy": "在隔离的全新数据环境中，先验证初始化与工程质量门槛，再执行顾客至商家的真实端到端状态闭环，并保存可复查的运行日志、测试结果和界面/API 证据。",
    "criteria": [
      {
        "id": "A1",
        "requirementIds": [
          "R1",
          "R3",
          "R4",
          "R6",
          "R7",
          "R20",
          "R21"
        ],
        "description": "在空环境创建全新数据库后，迁移和确定性种子数据成功执行；可查询单商户商品分类、商品、SKU，并能持久化含所需快照字段的地址和订单。",
        "level": "integration",
        "expectedEvidence": "空库初始化日志、migration 结果、seed 结果及数据库查询或 API 响应记录。",
        "blocking": true
      },
      {
        "id": "A2",
        "requirementIds": [
          "R2",
          "R3",
          "R4",
          "R5",
          "R6",
          "R7"
        ],
        "description": "无需第三方凭据的本地顾客可登录，浏览可售商品及字段，选择不同价格 SKU，修改购物车，并创建带完整地址和订单字段的订单。",
        "level": "ui",
        "expectedEvidence": "可重复 UI 测试结果及创建订单后的订单详情记录。",
        "blocking": true
      },
      {
        "id": "A3",
        "requirementIds": [
          "R8",
          "R13",
          "R18"
        ],
        "description": "已创建订单可经 Mock Payment Adapter 变为 PAID；系统仅允许合法的 ACCEPTED、PREPARING、DELIVERING、COMPLETED 流转，并支持合理的 CANCELLED；状态变化持久化且可供双方读取。",
        "level": "api",
        "expectedEvidence": "支付和状态流转自动化测试、订单状态持久化记录及非法流转被拒绝的结果。",
        "blocking": true
      },
      {
        "id": "A4",
        "requirementIds": [
          "R10",
          "R11",
          "R12",
          "R14"
        ],
        "description": "商家可在 Web 后台创建和编辑商品、管理分类及 SKU、上下架商品、查看订单列表和详情，并把已支付订单推进至配送中和已完成。",
        "level": "ui",
        "expectedEvidence": "后台 UI 自动化或录制的操作结果，以及对应订单状态记录。",
        "blocking": true
      },
      {
        "id": "A5",
        "requirementIds": [
          "R9",
          "R15"
        ],
        "description": "顾客订单列表和详情显示当前状态；商家后台显示与当日已支付成交订单数据一致的今日订单数和今日成交金额。",
        "level": "integration",
        "expectedEvidence": "顾客与商家界面结果、汇总查询结果及用于核对的订单数据。",
        "blocking": true
      },
      {
        "id": "A6",
        "requirementIds": [
          "R16",
          "R17",
          "R19",
          "R20",
          "R21"
        ],
        "description": "在干净本地环境中，可重复完成 install、typecheck、tests、build、cold start/clean start，并实际执行顾客登录→选 SKU→下单→模拟支付→商家接单/制作/配送/完成→顾客看到完成的完整路径；交付物不包含非目标功能。",
        "level": "delivery",
        "expectedEvidence": "各工程命令成功输出、全新数据环境启动记录、端到端测试结果和范围审查清单。",
        "blocking": true
      }
    ]
  },
  "risks": [
    {
      "id": "K1",
      "description": "商品或 SKU 在下单后被编辑，可能导致历史订单金额或内容变化。",
      "mitigation": "在订单创建时持久化订单项和配送信息快照，并以订单快照作为历史展示和金额依据。"
    },
    {
      "id": "K2",
      "description": "支付成功与订单状态更新非原子，可能产生商家看不到待处理订单的情况。",
      "mitigation": "将 Mock 支付确认和 PAID 状态持久化纳入单一受控业务事务，并以集成测试覆盖。"
    },
    {
      "id": "K3",
      "description": "仅验证页面渲染而未验证跨端状态同步，可能违反核心闭环验收。",
      "mitigation": "将顾客与商家共同参与的端到端闭环设为阻塞验收项。"
    },
    {
      "id": "K4",
      "description": "开发遗留数据掩盖迁移、种子或冷启动缺陷。",
      "mitigation": "验收始终从隔离的空数据库执行迁移和确定性初始化。"
    }
  ],
  "assumptions": [
    {
      "id": "S1",
      "statement": "单一商家主体无需商户切换或平台结算能力。",
      "impactIfFalse": "需要引入租户隔离、商户管理与平台型结算范围，超出 Requirement 001。"
    },
    {
      "id": "S2",
      "statement": "Mock Payment 的支付成功由本地系统可控地模拟，不连接真实支付渠道。",
      "impactIfFalse": "需要真实支付账户、密钥、回调和合规流程，超出 Requirement 001。"
    },
    {
      "id": "S3",
      "statement": "订单成交金额按成功模拟支付的订单统计，取消或未支付订单不计入今日成交金额。",
      "impactIfFalse": "需要重新定义成交金额口径，基础统计结果将改变产品含义。"
    }
  ],
  "customerQuestions": [],
  "id": "cf5660de-d085-4afe-962f-3afc69dc372d",
  "version": 1,
  "status": "ready_for_approval",
  "requirement": {
    "id": "811e514f-f58b-44af-9ae5-bb2331a16706",
    "text": "# Requirement 001 — 单商户餐饮点餐系统\n\n## 产品背景\n\n我要一个单商户餐饮点餐系统。\n\n顾客通过小程序完成浏览商品、选择规格、加入购物车、填写配送地址、下单和查看订单状态。\n\n商家有一个管理后台，可以维护商品、处理订单，并完成自己的跑腿配送流程。\n\n目前只有一个商户，不考虑平台型多商户模式。\n\n---\n\n## 顾客端\n\n用户需要能够：\n\n1. 登录系统\n\n首版必须支持无需第三方账号和密钥即可完整本地运行的模拟登录。\n\n未来可以接微信登录，但本次 Requirement 001 不要求接入真实微信 AppID。\n\n2. 浏览商品\n\n能够看到：\n\n- 商品分类\n- 商品名称\n- 图片\n- 描述\n- 价格\n- 可售状态\n\n3. 商品规格\n\n部分商品允许存在 SKU / 规格，例如：\n\n- 大杯 / 中杯\n- 微辣 / 中辣\n- 不同套餐\n\n选择不同 SKU 后价格可以不同。\n\n4. 购物车\n\n用户能够：\n\n- 加入商品\n- 修改数量\n- 删除商品\n- 查看合计金额\n\n5. 配送地址\n\n用户能够：\n\n- 新建地址\n- 编辑地址\n- 选择本次订单配送地址\n\n至少包括：\n\n- 联系人\n- 手机号\n- 地址\n\n6. 提交订单\n\n订单至少包含：\n\n- 商品\n- SKU\n- 数量\n- 单价\n- 总金额\n- 配送地址\n- 联系人\n- 手机号\n- 订单状态\n- 创建时间\n\n7. 支付\n\nRequirement 001 不要求接真实支付渠道。\n\n使用 Mock Payment / Payment Adapter。\n\n用户应该能够完成：\n\n下单 → 模拟支付成功 → 商家收到待处理订单\n\n未来应该容易替换为真实支付实现。\n\n8. 查看订单\n\n用户可以：\n\n- 查看订单列表\n- 查看订单详情\n- 查看当前订单状态\n\n---\n\n# 4. 商家后台\n\n商家需要一个 Web 管理后台。\n\n至少包含：\n\n## 商品管理\n\n商家可以：\n\n- 创建商品\n- 编辑商品\n- 上架 / 下架商品\n- 管理商品分类\n- 管理 SKU\n\n## 订单管理\n\n商家可以看到订单列表和订单详情。\n\n商家能够推进订单状态。\n\n建议业务状态至少覆盖：\n\n`PENDING_PAYMENT`\n→ `PAID`\n→ `ACCEPTED`\n→ `PREPARING`\n→ `DELIVERING`\n→ `COMPLETED`\n\n同时允许合理的：\n\n`CANCELLED`\n\n具体状态模型可以由系统规划阶段优化，但最终必须支持完整业务闭环。\n\n## 自营配送\n\n本项目不是第三方配送平台。\n\n商家自己跑腿配送。\n\nRequirement 001 不需要独立骑手 App。\n\n后台能够将订单推进到：\n\n- 配送中\n- 已完成\n\n即可。\n\n## 基础统计\n\n后台至少能够看到：\n\n- 今日订单数\n- 今日成交金额\n\n不要求复杂 BI。\n\n---\n\n# 5. 非目标\n\nRequirement 001 明确不做：\n\n- 多商户平台\n- 骑手独立 App\n- 智能派单\n- 地图路线规划\n- 优惠券系统\n- 积分\n- 会员等级\n- 分销\n- 营销中心\n- 复杂 RBAC\n- 真实微信支付\n- 真实微信登录\n- 云端生产部署\n- 高并发架构\n- 微服务\n\n不要主动扩张范围。\n\n目标是完成最小但真实、完整的业务闭环。\n\n---\n\n# 6. 最终核心验收路径\n\n必须能够实际执行：\n\n顾客登录\n→ 浏览商品\n→ 选择 SKU\n→ 加入购物车\n→ 创建 / 选择地址\n→ 创建订单\n→ 模拟支付\n→ 商家后台出现订单\n→ 商家接单\n→ 商家开始制作\n→ 商家开始配送\n→ 商家完成订单\n→ 顾客端看到订单完成\n\n任何只做页面、没有真实状态闭环的实现都不算通过。\n\n---\n\n# 7. 工程验收\n\n最终项目至少需要存在明确且可重复执行的验证机制。\n\nNovaWing 应自行确定合理工程方案，但最终至少验证：\n\n- install\n- typecheck\n- tests\n- build\n- cold start / clean start\n- 核心业务流程\n\n如果项目采用数据库，需要验证：\n\n- 空环境初始化\n- schema / migration\n- seed 或等效测试数据方案\n- fresh database 可以启动\n\n不能依赖开发过程中遗留下来的本地脏数据才能运行。\n\n---\n",
    "receivedAt": "2026-09-26T15:03:06.429Z",
    "revisionNotes": []
  },
  "dependencies": [
    {
      "fromTaskId": "T1",
      "toTaskId": "T2"
    },
    {
      "fromTaskId": "T1",
      "toTaskId": "T3"
    },
    {
      "fromTaskId": "T2",
      "toTaskId": "T3"
    },
    {
      "fromTaskId": "T1",
      "toTaskId": "T4"
    },
    {
      "fromTaskId": "T3",
      "toTaskId": "T4"
    },
    {
      "fromTaskId": "T3",
      "toTaskId": "T5"
    },
    {
      "fromTaskId": "T4",
      "toTaskId": "T5"
    },
    {
      "fromTaskId": "T1",
      "toTaskId": "T6"
    },
    {
      "fromTaskId": "T2",
      "toTaskId": "T6"
    },
    {
      "fromTaskId": "T3",
      "toTaskId": "T6"
    },
    {
      "fromTaskId": "T4",
      "toTaskId": "T6"
    },
    {
      "fromTaskId": "T5",
      "toTaskId": "T6"
    }
  ],
  "coverage": [
    {
      "requirementId": "R1",
      "taskIds": [
        "T1"
      ],
      "acceptanceCriterionIds": [
        "A1"
      ],
      "blockingAcceptanceCriterionIds": [
        "A1"
      ]
    },
    {
      "requirementId": "R2",
      "taskIds": [
        "T2"
      ],
      "acceptanceCriterionIds": [
        "A2"
      ],
      "blockingAcceptanceCriterionIds": [
        "A2"
      ]
    },
    {
      "requirementId": "R3",
      "taskIds": [
        "T1",
        "T2"
      ],
      "acceptanceCriterionIds": [
        "A1",
        "A2"
      ],
      "blockingAcceptanceCriterionIds": [
        "A1",
        "A2"
      ]
    },
    {
      "requirementId": "R4",
      "taskIds": [
        "T1",
        "T2"
      ],
      "acceptanceCriterionIds": [
        "A1",
        "A2"
      ],
      "blockingAcceptanceCriterionIds": [
        "A1",
        "A2"
      ]
    },
    {
      "requirementId": "R5",
      "taskIds": [
        "T2"
      ],
      "acceptanceCriterionIds": [
        "A2"
      ],
      "blockingAcceptanceCriterionIds": [
        "A2"
      ]
    },
    {
      "requirementId": "R6",
      "taskIds": [
        "T1",
        "T2"
      ],
      "acceptanceCriterionIds": [
        "A1",
        "A2"
      ],
      "blockingAcceptanceCriterionIds": [
        "A1",
        "A2"
      ]
    },
    {
      "requirementId": "R7",
      "taskIds": [
        "T1",
        "T2"
      ],
      "acceptanceCriterionIds": [
        "A1",
        "A2"
      ],
      "blockingAcceptanceCriterionIds": [
        "A1",
        "A2"
      ]
    },
    {
      "requirementId": "R8",
      "taskIds": [
        "T3"
      ],
      "acceptanceCriterionIds": [
        "A3"
      ],
      "blockingAcceptanceCriterionIds": [
        "A3"
      ]
    },
    {
      "requirementId": "R9",
      "taskIds": [
        "T5"
      ],
      "acceptanceCriterionIds": [
        "A5"
      ],
      "blockingAcceptanceCriterionIds": [
        "A5"
      ]
    },
    {
      "requirementId": "R10",
      "taskIds": [
        "T4"
      ],
      "acceptanceCriterionIds": [
        "A4"
      ],
      "blockingAcceptanceCriterionIds": [
        "A4"
      ]
    },
    {
      "requirementId": "R11",
      "taskIds": [
        "T4"
      ],
      "acceptanceCriterionIds": [
        "A4"
      ],
      "blockingAcceptanceCriterionIds": [
        "A4"
      ]
    },
    {
      "requirementId": "R12",
      "taskIds": [
        "T4"
      ],
      "acceptanceCriterionIds": [
        "A4"
      ],
      "blockingAcceptanceCriterionIds": [
        "A4"
      ]
    },
    {
      "requirementId": "R13",
      "taskIds": [
        "T3"
      ],
      "acceptanceCriterionIds": [
        "A3"
      ],
      "blockingAcceptanceCriterionIds": [
        "A3"
      ]
    },
    {
      "requirementId": "R14",
      "taskIds": [
        "T4"
      ],
      "acceptanceCriterionIds": [
        "A4"
      ],
      "blockingAcceptanceCriterionIds": [
        "A4"
      ]
    },
    {
      "requirementId": "R15",
      "taskIds": [
        "T5"
      ],
      "acceptanceCriterionIds": [
        "A5"
      ],
      "blockingAcceptanceCriterionIds": [
        "A5"
      ]
    },
    {
      "requirementId": "R16",
      "taskIds": [
        "T6"
      ],
      "acceptanceCriterionIds": [
        "A6"
      ],
      "blockingAcceptanceCriterionIds": [
        "A6"
      ]
    },
    {
      "requirementId": "R17",
      "taskIds": [
        "T6"
      ],
      "acceptanceCriterionIds": [
        "A6"
      ],
      "blockingAcceptanceCriterionIds": [
        "A6"
      ]
    },
    {
      "requirementId": "R18",
      "taskIds": [
        "T3"
      ],
      "acceptanceCriterionIds": [
        "A3"
      ],
      "blockingAcceptanceCriterionIds": [
        "A3"
      ]
    },
    {
      "requirementId": "R19",
      "taskIds": [
        "T6"
      ],
      "acceptanceCriterionIds": [
        "A6"
      ],
      "blockingAcceptanceCriterionIds": [
        "A6"
      ]
    },
    {
      "requirementId": "R20",
      "taskIds": [
        "T1",
        "T6"
      ],
      "acceptanceCriterionIds": [
        "A1",
        "A6"
      ],
      "blockingAcceptanceCriterionIds": [
        "A1",
        "A6"
      ]
    },
    {
      "requirementId": "R21",
      "taskIds": [
        "T1",
        "T6"
      ],
      "acceptanceCriterionIds": [
        "A1",
        "A6"
      ],
      "blockingAcceptanceCriterionIds": [
        "A1",
        "A6"
      ]
    }
  ],
  "frozenAt": null,
  "createdAt": "2026-09-26T15:04:54.962Z",
  "updatedAt": "2026-09-26T15:04:54.962Z",
  "approvedAt": null
}
```
