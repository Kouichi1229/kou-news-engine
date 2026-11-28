# M7.0 Phase 2 — SPEC-GAP-18 OD-2：Outbox Envelope and Attempt Storage（提案）

| 項目 | 內容 |
| --- | --- |
| 文件 | OD-2 Outbox Envelope and Lease/Attempt Storage 決策提案 |
| 狀態 | **`PROPOSED — AWAITING USER APPROVAL`** |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `OD-2` |
| 選定選項 | **Option B — 保留 18 欄 envelope；lease 與 attempt 存於獨立表** |
| Implementation Authorization | **`NOT GRANTED`** |
| 參照 | M7.0 `OUT-1`（L599）、`OUT-2`（L600）；MI-1、MI-2、MI-7；OD-A；OD-1；OD-3；P-5（`OPEN`） |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |

**標籤圖例。** `[PROPOSED DECISION]` 尚待使用者核准的決策 · `[SPECIFICATION]` 既有已確認政策 · `[RECOMMENDATION]` 技術建議（未核准） · `[OPEN]` 未決

`[TO]` **本文件不是已核准政策**，也不是 schema 規格。在使用者核准前不得據此實作。

---

## 1. Problem（問題）

`[SPECIFICATION]` `OUT-1` 固定 Outbox 有 **18 個欄位**、PK `event_id`、唯一約束 `UNIQUE(event_type, aggregate_id, notification_key)`；`OUT-2` 固定 4 個 status 與 6 個 check（數量）。此「18」是**已確認的數量事實**。

`[SPECIFICATION]` MI-6d 要求 Manual Retry 取得「可與 Automatic Lease 區別的 Manual Lease」；OD-A 要求一個持久的 possible-invocation marker；MI-6d 要求 Provider Attempt 結果**獨立**持久化。

`[TO]` 若把 lease、marker、attempt 欄位放入 envelope，欄數將超過 18，直接與 `OUT-1` 衝突，需 Owner 修訂已確認事實。若不放入，則需決定這些資料的落點。

---

## 2. Proposed Decision（提案內容）

`[PROPOSED DECISION]` **Option B**：**保留 `OUT-1` 的 18 欄 envelope 不變**，將 Manual Lease 與 Provider Attempt 資料放在獨立表中。

`[PROPOSED DECISION]` 條文：

1. **保留** Outbox envelope 的 18 個欄位；**不新增**任何 Manual Lease 或 Provider Attempt 欄位至 envelope。
2. Manual Intervention 與 **Manual Lease** 資料存於獨立的 1:1 `outbox_intervention` 表（與 MI-1 一致）。
3. Provider Attempt 資料存於獨立的 `provider_attempt` 表。
4. Operation History 保持獨立且 **append-only**（MI-7）。
5. **不得**靜默變更 `OUT-1` 的欄位計數。
6. P-5 於日後指定概念關聯與確切 schema；**本文件不授權 schema 實作**。

---

## 3. Conceptual Relations（概念關聯，非 schema）

`[RECOMMENDATION]`（未核准）概念模型：

```
outbox_event            (18 欄，不變)          1 ── 1  outbox_intervention
   │                                              （hold、intervention_outcome、
   │                                                completed_at、manual lease token、
   │                                                lease expiry、lease discriminator）
   ├── 1 ── N  outbox_operation_history（append-only）
   └── 1 ── N  provider_attempt（每次 manual lease 一列；
                                marker 時間、outcome、finalized_at）
```

| 實體 | 職責 | 可變性 | 保留期影響正確性 |
| --- | --- | --- | --- |
| `outbox_event` | 權威 Delivery Status（四值） | 可變 | 是 |
| `outbox_intervention` | 介入狀態、最終結果、Manual Lease | 可變 | 是 |
| `outbox_operation_history` | 已接受操作的稽核 | append-only | 是（replay 冪等） |
| `provider_attempt` | 單次呼叫的證據與結果 | 建立後僅可最終化一次 | 是（OD-A 計數） |

`[TO]` **為何 lease 放 `outbox_intervention` 而非 envelope**：Manual Lease 只存在於介入生命週期內（僅 `dead` 事件進入介入），語意上屬介入維度而非投遞 envelope；放此處同時滿足 MI-1 與 `OUT-1`。

`[TO]` **為何 attempt 獨立成表**：MI-6d 要求「Provider Attempt 結果需獨立持久化」，且 OD-A 的 marker 需要可稽核的時間戳；若放入 intervention 表，將使 1:1 表變成 1:N，破壞 MI-1 的 1:1 性質。

---

## 4. Consequences

| 面向 | 影響 |
| --- | --- |
| `OUT-1` 相容性 | **完全相容**（18 欄不變，無需修訂已確認事實） |
| 跨表原子性 | Phase 1／Marker／Phase 2／Recovery 皆需跨 event + intervention + attempt（+ history）的**同一交易** |
| 交易邊界 | `[RECOMMENDATION]` 由**單一 repository** 擁有上述四表，沿用既有 `immediate()` 模式（`sqlite-processing-job.repository.ts:86-104`），**不引入**共享交易抽象 |
| 查詢成本 | 介入／attempt 查詢需 JOIN；可接受 |
| Cleanup | 四表需一致的清理順序（`OUT-14`–`OUT-16` 未決） |
| Migration | 純新增表，不改既有 5 張表 |

`[TO]` **既有實作限制（已驗證）**：`SqliteQueryable` 僅暴露 `query`（`sqlite-processing-job.repository.ts:17`），且 `immediate()` 為 private（`:86`）→ 跨 repository 交易**不可組合**。因此四表同屬一個 repository 是必要條件，而非偏好。

---

## 5. Preserved Policies

`[SPECIFICATION]` 不改變：`OUT-1` 的 18 欄與唯一鍵；`OUT-2` 的 4 status／6 check 數量；P-1（`event_id` UUIDv4）；P-2（`aggregate_id`）；P-3（`notification_key`）；P-4（四 status）；MI-1（1:1 表）；MI-2（outcome + completed_at）；MI-7（append-only）；OD-A（計數邊界）；OD-1（過期丟棄）；OD-3（marker 獨立交易）。

---

## 6. Unresolved Details（未決）

`[OPEN]` 本提案**未**決定：

1. `outbox_intervention` 與 `provider_attempt` 的確切欄位、型別、約束、索引。
2. 兩表與 `outbox_event` 之間是否使用 FK（MI-1 未確立 FK）。
3. Manual Lease discriminator 的表示法。
4. Attempt 主鍵形式（surrogate 或 `(event_id, lease_token)`）。
5. 唯一性約束（token 全域唯一之落地方式）。
6. 六個 `CHECK` 的內容（`OUT-2`）。
7. `OUT-11` payload 欄位。
8. `OUT-14`／`OUT-15`／`OUT-16` 保留與清理。
9. Migration 版本與命名。

`[TO]` 上述全部屬 P-5 與後續決策，本文件**不代為決定**。

---

## 7. No Implementation Authorization

`[TO]` 本文件**不授予**任何實作授權：不授權建表、migration、repository、CLI、worker、recovery 或測試變更。實作需另有一次明確授權。

---

## 8. Change History

| 日期 | 變更 |
| --- | --- |
| 2026-11-27 | 建立 OD-2 提案：保留 18 欄 envelope；lease 與介入存 `outbox_intervention`；attempt 存 `provider_attempt`；history 獨立 append-only。**狀態為提案，待使用者核准。** |
