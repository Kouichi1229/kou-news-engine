# M7.0 Phase 2 — SPEC-GAP-18 OD-1：Expired Manual Lease Result Policy（提案）

| 項目 | 內容 |
| --- | --- |
| 文件 | OD-1 Expired Manual Lease Result Policy 決策提案 |
| 狀態 | **`PROPOSED — AWAITING USER APPROVAL`** |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `OD-1` |
| 選定選項 | **Option A — Discard Phase 2 results after Manual Lease expiry** |
| Implementation Authorization | **`NOT GRANTED`** |
| 參照 | MI-6 備忘錄 §3.4（MI-6d）；OD-A 備忘錄 §2–§5；P-4 備忘錄 §C；M7.0 `OUT-4`、`OUT-9`、`OUT-10`、`OUT-25` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |

**標籤圖例。** `[PROPOSED DECISION]` 本文件提出、**尚待使用者核准**的決策 · `[SPECIFICATION]` 既有已確認政策 · `[RECOMMENDATION]` 技術建議（未核准） · `[OPEN]` 未決

`[TO]` **本文件不是已核准政策。** 在使用者明確核准前，不得據此實作，也不得對外引用為已決事項。

---

## 1. Problem（問題）

`[SPECIFICATION]` MI-6d 規定 Manual Retry 為兩階段：Phase 1（交易內取得 lease）、Phase 2（交易外 HTTP，30 秒，再以交易寫結果）。`OUT-10` 固定 lease 為 60 秒。

`[SPECIFICATION]` 兩者僅有 30 秒餘裕。若程序延遲、暫停或網路緩慢，Phase 2 可能在 **lease 已過期** 之後才取得寫入交易。

`[TO]` 此時有兩種可能行為，且既有政策未決定：

- **A**：Phase 2 仍寫入真實結果（`sent`／`dead`）——結果取決於 recovery 是否已先執行，**不可預測**。
- **B**：Phase 2 因 lease 已過期而失敗，由 recovery 判定 `outcome_unknown`——行為**可預測**，但**已知的真實結果被丟棄**。

`[TO]` 前次技術分析指出此為「可預測性」與「避免重複投遞」的取捨，非技術最優解，故提出本決策。

---

## 2. Proposed Decision（提案內容）

`[PROPOSED DECISION]` **Option A**：一旦 Manual Lease 過期，Phase 2 **不得**持久化其結果，即使 HTTP 回應為 `provider_accepted` 或 `provider_rejected`。

`[PROPOSED DECISION]` 條文：

1. Phase 2 的條件式寫入必須同時要求：
   - 正確的 **Event ID**；
   - 正確的**當前 Manual Lease token**；
   - **Manual Lease discriminator**；
   - 仍允許完成的 **Delivery Status 與 Intervention 狀態**；
   - 相符的 **Attempt 身分**；
   - **未過期的 lease**。
2. Lease 有效性必須在**取得 SQLite `BEGIN IMMEDIATE` 寫入交易之後**、以該交易的權威 `now` 判定。
3. 過期判定謂詞：**`lease_expires_at >= now`**（Phase 2 與 Marker 適用）。
4. Recovery 判定謂詞：**`lease_expires_at < now`**。
5. **Recovery 擁有已過期 lease**，並持久化 `outcome_unknown`。
6. 舊的 Phase 2 程序**不得**覆寫 Recovery 或後續 Manual Retry 的狀態。
7. 過期的 HTTP 結果**不得**變更權威的 Attempt、Delivery 或 Intervention 狀態。
8. 本地 fencing **無法**撤銷 Provider 端已發生的副作用。
9. 若 Provider 已接受前一請求，後續 Manual Retry **可能造成重複外部投遞**。
10. **不得**聲稱 exactly-once 投遞。

---

## 3. Rationale（理由）

| # | 理由 |
| --- | --- |
| 1 | 使終態**不依賴 recovery 的排程時機**；相同輸入在相同 crash 點必得相同結果 |
| 2 | 讓「過期」成為**單向門檻**：過期後只有 recovery 能決定，消除兩寫入者競爭 |
| 3 | 與 MI-6d「過期不確定 → `outcome_unknown`」一致；不需修改 MI-6d |
| 4 | 與 `OUT-25` 的「delivery 與 intervention 分別判定」一致：`dead` 事件仍需介入完成才可清理 |

`[TO]` **已知代價**：若 Provider 實際已接受、但回應在過期後才回到本機，該成功結果會被丟棄，事件停在 `dead`。操作者若再 retry，可能重複投遞。這是本選項明確接受的取捨。

---

## 4. Crash and Concurrency Implications

| 情境 | 行為 | 後果 |
| --- | --- | --- |
| Phase 2 於過期前取得寫鎖 | 寫入真實結果、清除 token | 正常完成 |
| 過期後、Recovery 未執行，Phase 2 才寫 | 條件不成立 → 0 列 → 不寫入 | 事件維持 `leased`（過期），待 recovery |
| Recovery 先提交 | token 已清除 → Phase 2 0 列 | 事件 `dead` + `outcome_unknown` |
| 舊回應在新 retry 取得新 token 後到達 | token 不符 → 0 列 | 不影響新 retry |
| HTTP 仍在執行時 lease 過期 | 結果最終被丟棄 | 可能已實際送達 → 重複投遞風險 |

`[TO]` 過期邊界的等號處理：Phase 2 用 `>= now`、Recovery 用 `< now`，兩者互補且**無縫隙**——`lease_expires_at == now` 恰屬 Phase 2 可用、Recovery 不可選，因此不會出現「兩者皆不可處理」的空洞，也不會出現「兩者可同時處理」的重疊。

---

## 5. Preserved Policies

`[SPECIFICATION]` 本提案**不改變**：P-4 的四個 Delivery Status；`sent` = provider 接受；介入與 Delivery Status 分離；MI-6a（retry 不完成介入）；MI-6d 全部條文；MI-6h（無固定上限）；MI-6e（Operation ID）；OD-A（保守計數、marker 邊界）；`OUT-9`（30s）、`OUT-10`（60s）；D-4（`--execute`、無 dry-run、失敗即回）。

---

## 6. Unresolved Details（未決）

`[OPEN]` 本提案**未**決定：

1. `lease_expires_at` 的欄位名、型別、所屬表（屬 P-5／OD-2）。
2. Manual Lease discriminator 的表示法。
3. Attempt 身分的具體形式。
4. 條件式 UPDATE 的實際 SQL。
5. 交易邊界與 repository 歸屬。
6. 被丟棄結果的可觀測性（是否輸出至 CLI；**不得**新增稽核表或 request log）。
7. Provider 端冪等或狀態查詢能力（`SPEC-GAP-10` `OPEN`）。

---

## 7. No Implementation Authorization

`[TO]` 本文件**不授予**任何實作授權：不授權 schema、migration、CLI、worker、recovery、測試或任何程式碼變更。實作需另有一次明確授權，且須先完成 OD-2（P-5 儲存結構）與 `SPEC-GAP-10`。

---

## 8. Change History

| 日期 | 變更 |
| --- | --- |
| 2026-11-27 | 建立 OD-1 提案：過期後丟棄 Phase 2 結果；Phase 2／Marker 用 `>= now`、Recovery 用 `< now`；Recovery 擁有過期 lease。**狀態為提案，待使用者核准。** |
