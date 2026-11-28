# M7.0 Phase 2 — SPEC-GAP-18 OD-3：Independent Possible-Invocation Marker Transaction（提案）

| 項目 | 內容 |
| --- | --- |
| 文件 | OD-3 Independent Possible-Invocation Marker Transaction 決策提案 |
| 狀態 | **`PROPOSED — AWAITING USER APPROVAL`** |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `OD-3` |
| 選定選項 | **Option A — Marker 為獨立的持久交易** |
| Implementation Authorization | **`NOT GRANTED`** |
| 參照 | OD-A 備忘錄 §2–§5；MI-6d §3.4；MI-6c §3.3（經 OD-A 局部取代）；OD-1；OD-2 |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |

**標籤圖例。** `[PROPOSED DECISION]` 尚待使用者核准的決策 · `[SPECIFICATION]` 既有已確認政策 · `[RECOMMENDATION]` 技術建議（未核准） · `[OPEN]` 未決

`[TO]` **本文件不是已核准政策。** 在使用者核准前不得據此實作。

---

## 1. Problem（問題）

`[SPECIFICATION]` OD-A 規定：retry 於「**持久地跨越 possible-invocation 邊界**」時計數一次；且明文排除兩個候選邊界——「operation accepted」（OD-A §4.1 事件 1）與「Manual Lease acquired」（事件 2）。

`[TO]` 因此計數邊界必須是**第三個**、介於 lease 取得與 HTTP 呼叫之間的持久事件。

`[TO]` 若把 marker 併入 Phase 1 的同一個交易，marker 與「接受 + 取得 lease」同時提交，邊界實質退化為「接受」——**直接違反 OD-A §4.1**。

`[TO]` 前次技術分析已指出：OD-A 的邊界定義在結構上**強制要求第三個交易**（Phase 1 → Marker → HTTP → Phase 2）。

---

## 2. Proposed Decision（提案內容）

`[PROPOSED DECISION]` **Option A**：OD-A 的 Marker 必須在 **Phase 1 已提交之後**、**Provider HTTP 呼叫之前**，以**獨立交易**持久提交。

`[PROPOSED DECISION]` 必要序列：

| 步驟 | 內容 | 交易 |
| --- | --- | --- |
| 1 | **Phase 1**：接受操作、寫入 append-only history、建立 Provider Attempt、取得 Manual Lease；提交 | `BEGIN IMMEDIATE` |
| 2 | **Marker 交易**：驗證當前 Manual Lease 並持久化 possible-invocation marker；提交 | `BEGIN IMMEDIATE` |
| 3 | **Provider HTTP**：於 SQLite 交易**之外**執行，30 秒逾時 | 無 |
| 4 | **Phase 2**：以 fenced 交易持久化結果 | `BEGIN IMMEDIATE` |

`[PROPOSED DECISION]` Marker **不得**併入 Phase 1 提交，因為「接受 + lease 取得」已被 OD-A 明文排除於計數邊界之外。

### 2.1 Marker 交易本身必須 fenced

`[PROPOSED DECISION]` Marker 交易必須驗證：

1. 正確的 **Event ID**；
2. 正確的 **Manual Lease token**；
3. **Manual Lease discriminator**；
4. 仍允許的 **Delivery Status 與 Intervention 狀態**；
5. 相符的 **Attempt 身分**；
6. Lease 在**權威交易時間**仍未過期（`lease_expires_at >= now`，`now` 於取得 `BEGIN IMMEDIATE` 後取得）。

`[PROPOSED DECISION]` 若 Marker 交易**未影響預期列數**，則**不得**呼叫 Provider HTTP。

### 2.2 計數規則

`[PROPOSED DECISION]`：

- Marker **不存在** → **不計數**。
- Marker **已持久提交** → **恰好計一次**。
- `outcome_unknown` **本身不決定**計數（OD-A §6）。

---

## 3. Rationale（理由）

| # | 理由 |
| --- | --- |
| 1 | 唯一能同時滿足 OD-A §4.1（排除事件 1、2）與「可從持久證據重建」的結構 |
| 2 | Marker 交易若被 fenced，則**舊程序無法在 Recovery 已失效其 lease 之後**跨越計數邊界 |
| 3 | 讓計數與 HTTP 是否真正發生**解耦**：計數代表「已進入可能呼叫階段」，符合 OD-A 的保守語意 |
| 4 | 三個短交易皆在毫秒級，不違反 `OUT-9`（30s）與 `OUT-10`（60s） |

`[TO]` **已知成本**：每次 retry 需要 **三個** 交易與 **兩個** 崩潰窗口（Phase 1→Marker、Marker→HTTP），較兩交易方案多一次 fsync 與一個窗口。

---

## 4. Crash and Concurrency Implications

| 崩潰點 | Marker 狀態 | 依 OD-A 計數 | 後續 |
| --- | --- | --- | --- |
| Phase 1 交易中 | 無 | 不計 | 無狀態變化 |
| Phase 1 提交後、Marker 前 | 無 | **不計** | lease 過期 → Recovery → `outcome_unknown`（不計） |
| Marker 交易中 | 無 | 不計 | 同上 |
| Marker 提交後、HTTP 前 | 有 | **計** | lease 過期 → Recovery → `outcome_unknown`（計） |
| HTTP 進行中 | 有 | 計 | 同 OD-1：過期後結果被丟棄 |
| Marker 與 Recovery 競爭 | 取決於寫鎖順序 | — | Marker 若先提交則計；Recovery 若先提交則 Marker 0 列 → 不呼叫 HTTP、不計 |

`[TO]` **關鍵安全性**：Marker 交易 fenced 於 token + 未過期 + discriminator + attempt 身分，因此 **Recovery 一旦提交（清除 token），舊程序的 Marker 交易必為 0 列** → 不可能在 Recovery 之後跨越計數邊界。

`[TO]` **不得**聲稱 exactly-once 投遞：Marker 只影響**計數**，不影響 Provider 端是否已收到請求。

---

## 5. Preserved Policies

`[SPECIFICATION]` 不改變：MI-6c 經 OD-A 修訂後的計數語意；MI-6d 全部條文（Phase 1／Phase 2 結構、30s、不得在交易內呼叫 HTTP、Phase 2 不得變更 history）；MI-6a（retry 不完成介入）；MI-6h（無上限）；MI-6e（Operation ID）；P-4（四 status）；OD-1（過期丟棄）；OD-2（18 欄不變、lease 與 attempt 獨立表）；`OUT-9`／`OUT-10`；D-4。

---

## 6. Unresolved Details（未決）

`[OPEN]` 本提案**未**決定：

1. Marker 的欄位名、型別、所屬表（建議為 `provider_attempt` 上的時間戳欄，屬 OD-2／P-5）。
2. Marker 與 Attempt 建立的先後（若 Attempt 於 Phase 1 建立，Marker 僅為其欄位更新）。
3. Manual Lease discriminator 的表示法。
4. 條件式 UPDATE 的實際 SQL 與列數要求。
5. 交易邊界與 repository 歸屬（建議單一 repository，屬 OD-2）。
6. Marker 交易失敗時的錯誤語意與退出碼（D-4 要求立即失敗）。
7. Provider 端能力（`SPEC-GAP-10` `OPEN`）。

---

## 7. No Implementation Authorization

`[TO]` 本文件**不授予**任何實作授權：不授權 marker、attempt、lease、CLI、worker、recovery、schema、migration 或測試。實作需另有一次明確授權，且須先完成 OD-1、OD-2 的核准與 `SPEC-GAP-10`。

---

## 8. Change History

| 日期 | 變更 |
| --- | --- |
| 2026-11-27 | 建立 OD-3 提案：Marker 為 Phase 1 之後、HTTP 之前的獨立持久交易；Marker 交易需 fenced；0 列則不得呼叫 HTTP；計數以 marker 為準。**狀態為提案，待使用者核准。** |
