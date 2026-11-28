# M7.0 Phase 2 — SPEC-GAP-18 MI-6a ～ MI-6h：Manual Intervention 操作語意 Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | MI-6a～MI-6h Manual Intervention 操作語意 Owner 決策紀錄 |
| Decision Status | **`CONFIRMED`**（八項決策） |
| Implementation Authorization | **`NOT GRANTED`** |
| SPEC-GAP-18 狀態 | **`OPEN`**（本文件僅解決其操作語意子集） |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `MI-6a`、`MI-6b`、`MI-6c`、`MI-6d`、`MI-6e`、`MI-6f`、`MI-6g`、`MI-6h` |
| 參照 | `SPEC-GAP-18`（M7.0 規格 L795）；`OUT-25`（L623）；MI-1～MI-5、MI-7、MI-8；P-4 |
| 階段 | Phase 2 |
| 性質 | 決策紀錄。**不授予任何實作授權，不解決任何未列明的技術細節。** |
| 母規格 | `docs/design/m7-0-ai-news-processing-pipeline.md`（M7.0），SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |

**標籤圖例。** `[OD]` 本文件所記錄的 Owner 已確認決策 · `[EX]` 既有已確認政策（非本文件所創） · `[ODR]` 未決 · `[TO]` 技術觀察／非規範說明

---

## 1. Purpose and Scope（目的與範圍）

`[OD]` 本文件彙整並保存 Owner 於 2026-11-27 確認的八項 MI-6 決策，界定 Manual Intervention 的操作語意，並明確標示仍未決定的技術細節。

`[OD]` 本文件**只**記錄政策。它不設計 schema、不設計 SQL、不設計 CLI、不設計 worker 或 recovery、不授權任何實作。

`[OD]` 本文件**不**完成 `SPEC-GAP-18`。該項仍為 `OPEN`：介入表示法、操作介面、到期與升級、兩結果的具體記錄方式等仍未全部解決。

`[TO]` 範圍邊界：本文件處理的是**已 `dead` 之一般 Outbox 事件的 Manual Intervention 操作語意**；不處理 Alert 通道（`SPEC-GAP-10`）、payload 欄位（`OUT-11`）、保留期間與清理（`OUT-14`／`OUT-15`／`OUT-16`）。

---

## 2. Decision Status（決策狀態）

| 決策 | 狀態 | 選項 |
| --- | --- | --- |
| MI-6a 成功 retry 不完成介入 | **`CONFIRMED`** | Option A |
| MI-6b 獨立 Active Hold 表示 | **`CONFIRMED`** | Option A |
| MI-6c Manual Retry 計數 | **`CONFIRMED`** | Option A |
| MI-6d 一次性 CLI 與兩階段 retry | **`CONFIRMED`** | Option A |
| MI-6e Operation ID | **`CONFIRMED`** | Option A |
| MI-6f Actor 來源 | **`CONFIRMED`** | Option C |
| MI-6g 不建立獨立 Request Log | **`CONFIRMED`** | Option A |
| MI-6h 無固定 retry 上限 | **`CONFIRMED`** | Option A |

`[OD]` 全部八項均為 **Owner 政策決策**，不是實作授權。

---

## 3. Authoritative Policy Decisions（MI-6a ～ MI-6h）

### 3.1 MI-6a — Manual Retry 不完成 Manual Intervention

`[OD]` Owner 選擇 **Option A**。

1. Manual Retry **永不**自動完成 Manual Intervention。
2. **只有**明確的 Abandon 操作會完成介入。
3. `provider_accepted` 使 Delivery Status 變為 `sent`，但**不**設定 `intervention_outcome`，**不**設定 `completed_at`。
4. `provider_rejected` 與 `outcome_unknown` 使 Delivery Status 維持 `dead`，且**不**完成介入。
5. 明確的 Abandon 設定 `intervention_outcome = 'abandoned'` 並設定 `completed_at`。
6. `sent` 事件可透過**成功投遞**條件取得清理資格。
7. `dead` 事件必須**介入完成**才可透過介入完成條件取得清理資格。
8. **不得**將 Provider acceptance 等同於介入完成。

### 3.2 MI-6b — 獨立的 Active Hold 表示

`[OD]` Owner 選擇 **Option A**。

1. Active Hold **必須**與 `intervention_outcome` 分開表示。
2. 使用獨立欄位；`held_at` 僅為**示例**，**不是**已定案的欄位名稱。
3. `intervention_outcome` 表示介入的**最終結果**，不是 Active Hold 狀態。
4. Release 清除 Active Hold 欄位。
5. Abandon 以原子方式清除 Active Hold 並完成介入。
6. 先前已提交的 Hold 與 Release 操作歷史紀錄**保持不變**。

`[ODR]` 仍**未決**：確切欄位名稱、欄位型別、`CHECK` 約束、索引、完整 schema。

`[TO]` **不得**把 `held_at` 當作已定案的 schema 決策引用。

### 3.3 MI-6c — Manual Retry 計數

`[OD]` Owner 選擇 **Option A**。

1. 只有在 **Provider invocation 實際發生**時，才計為一次 Manual Retry。
2. `outcome_unknown` **計入**，因為 Provider invocation 已發生。
3. 已被接受、但在 Provider invocation 之前中斷的 retry **不計入**。
4. 被拒絕的請求與 state conflict **不計入**。
5. **必須**存在 Provider invocation 的持久證據，使計數可被準確重建。
6. **不得**假設一般的 Operation History 自動提供此證據。

`[OD]` 本決策**不**隱含任何固定的 Manual Retry 上限。

### 3.4 MI-6d — 一次性 CLI 與兩階段 Retry 執行

`[OD]` Owner 選擇 **Option A**。

**Phase 1（SQLite 交易內）：**

1. 以 `BEGIN IMMEDIATE` 開始交易。
2. 驗證 Retry 資格與預期狀態。
3. 以 CAS 執行條件式狀態轉移。
4. 持久化 Retry 意圖與已接受的 Operation History 紀錄。
5. 取得一個**可區別**的 Manual Lease。
6. 提交。

**Phase 2（SQLite 交易外）：**

1. 在 SQLite 交易**之外**呼叫 Provider。
2. 使用既有 `OUT-9` 的 HTTP timeout 政策（**30 秒**）。
3. 在後續交易中持久化 Provider Attempt 結果。
4. 更新 Delivery Status：
   - `provider_accepted` → `sent`
   - `provider_rejected` → `dead`
   - `outcome_unknown` → `dead`

**附加要求：**

- Phase 2 **不得**變更 append-only Operation History。
- Provider Attempt 結果需要**獨立**持久化。
- Manual Lease **必須**可與 Automatic Delivery Lease 區別。
- Automatic Worker 與 Recovery **不得**誤將 Manual Lease 當作一般自動工作處理。
- Manual Retry **不得**消耗或重設自動 retry budget。
- 若 Manual Lease 過期且無法判定 Provider 結果，**必須**保守歸類為 `outcome_unknown`。
- **不得**自動重送已過期且結果不確定的 Manual Retry。

`[OD]` **不得**臆造確切 SQL、欄位名稱、lease schema 或 Recovery 實作。

### 3.5 MI-6e — Operation ID

`[OD]` Owner 選擇 **Option A**。

1. 由應用程式產生 **UUIDv4**。
2. **全域唯一**，跨所有事件與所有操作型別。
3. 持久化於 append-only Operation History。
4. 以唯一性約束／索引保護。
5. 同一 Operation ID 被用於**另一事件**或**另一操作型別**時，**永不**得被靜默視為新操作。

`[ODR]` 仍**未決**：確切 replay 回應語意、同一 ID 搭配不同請求 payload 的處理、request binding／fingerprint 設計、ID 保留與 replay 保證、確切產生時機與失敗語意。

`[TO]` **不得**由 P-1 的 `event_id` 決策推定 Operation ID 的實作細節；兩者是不同的識別碼。

### 3.6 MI-6f — Actor 身分來源

`[OD]` Owner 選擇 **Option C**。

1. 初期接受透過 CLI 或環境變數提供的 Actor 身分。
2. 持久化所提供之 Actor 字串。
3. **明確標示該身分為未經驗證（unverified）**。
4. **不得**聲稱 Actor 已通過認證或授權。
5. 正式的 Authentication 與 Authorization 可於未來另行設計。

`[EX]` Actor 依 MI-4e **必填**；Reason 依 MI-4e **選填**。

`[ODR]` 仍**未決**：Actor 字串格式、確切持久化表示、長度限制、可信來源與未來認證機制。

### 3.7 MI-6g — 不建立獨立 Request Log

`[OD]` Owner 選擇 **Option A**。

1. **不**建立獨立 Request Log。
2. Append-only Intervention History **只**記錄成功完成有效狀態轉移的已接受操作。
3. 被拒絕的請求與 state conflict **不**建立 Intervention History 紀錄。
4. 它們也**不**建立獨立 Request Log。
5. 回傳適當的 **State Conflict** 回應。

`[OD]` 本決策**不得**被重新解釋為允許變更或丟棄已接受的操作歷史。

### 3.8 MI-6h — 無固定 Manual Retry 上限

`[OD]` Owner 選擇 **Option A**。

1. Manual Retry 次數**沒有**固定數值上限。
2. 每次 Retry 仍**必須**是明確的人工操作。
3. 每次 Retry 仍受資格檢查、CAS、Operation ID 冪等與 append-only history 約束。
4. 本決策**不**授權自動 retry。
5. 本決策**不**移除 Provider 成本、服務限制或營運約束。

`[OD]` **不得**新增 retry 上限欄位或任意數值門檻。

---

## 4. Consolidated Cross-Decision Invariants（跨決策不變式）

`[OD]` 以下 20 條不變式**彙整既有已確認決策**，並非全由 MI-6 產生。來源欄標明出處。

| # | 不變式 | 來源 |
| --- | --- | --- |
| 1 | Delivery Status 與 Manual Intervention 狀態是**分開的概念** | P-4（既有） |
| 2 | Delivery Status 僅為 `pending`／`leased`／`sent`／`dead` | P-4（既有） |
| 3 | Intervention outcome 與 Provider Attempt 結果**分離** | `OUT-25`（既有）、MI-2（既有） |
| 4 | Provider Attempt 結果僅為 `provider_accepted`／`provider_rejected`／`outcome_unknown` | MI-3（既有） |
| 5 | `sent` 表示 Provider acceptance，**不是**終端使用者已收到 | `OUT-3`（既有）、P-4 |
| 6 | `abandoned` 表示介入以未成功方式完成，**不是** Provider rejection、投遞成功或事件刪除 | MI-5-ε（既有） |
| 7 | Abandon 依 MI-5-γ **不可逆** | MI-5-γ（既有） |
| 8 | Hold 為未完成，且阻止自動投遞與 manual retry | MI-4a（既有） |
| 9 | Release 只清除 Hold；不設 `pending`、不觸發投遞、不完成介入 | MI-4b（既有） |
| 10 | 處於 held 的事件可直接被 abandon | MI-5-α（既有） |
| 11 | Abandon 以原子方式清除 Active Hold | MI-5-β（既有） |
| 12 | Manual Retry 與 Automatic Retry 的預算**互相獨立** | MI-3（既有）、MI-6d |
| 13 | `outcome_unknown` **不得**導致自動重送 | MI-3（既有）、MI-6d |
| 14 | Operation History 為 **append-only** | MI-7（既有）、MI-6d |
| 15 | 只有完成有效轉移的已接受操作才建立 Intervention History 紀錄 | MI-5-δ、MI-6g |
| 16 | Actor 必填但初期**未經驗證**；Reason 選填 | MI-4e（既有）、MI-6f |
| 17 | Operation ID 冪等與 Provider 端冪等是**不同**概念 | MI-8（既有）、MI-6e |
| 18 | 本設計**不**建立 exactly-once 投遞保證 | `OUT-4`（既有） |
| 19 | **不**授權獨立 Request Log | MI-6g（本文件） |
| 20 | **不**建立固定 Manual Retry 上限 | MI-6h（本文件） |

`[TO]` 第 19、20 條是本文件新增的決策；其餘為既有政策之彙整，不得視為 MI-6 重新決定。

---

## 5. State and Outcome Semantic Distinctions（狀態與結果語意區分）

| 維度 | 值域 | 來源 | **不是**什麼 |
| --- | --- | --- | --- |
| **Delivery Status** | `pending`／`leased`／`sent`／`dead` | P-4 | 不是介入狀態；不得包含 `abandoned` |
| **Intervention 結果** | `intervention_outcome`（值集 OPEN；`abandoned` 已確認）＋ `completed_at` | MI-2、MI-5-ε | 不是投遞成功；不是 Provider 結果 |
| **Active Hold** | 獨立欄位（名稱／型別 OPEN） | MI-6b | 不是 `intervention_outcome` 的值 |
| **Provider Attempt 結果** | `provider_accepted`／`provider_rejected`／`outcome_unknown` | MI-3 | 不是介入結果；不是操作結果 |
| **Operation 結果** | 成功／state conflict／replay 回傳 | MI-4c、MI-8 | 不是投遞結果 |
| **Actor／Reason** | actor（必填、未驗證）／reason（選填） | MI-4e、MI-6f | 不是授權證明 |

`[OD]` 六個維度必須分別可判定，**不得**以任一維度推導另一維度。

---

## 6. Unresolved Technical Details（未決技術細節，全部 `OPEN`）

`[ODR]` 本節所列項目**全部未決**。本文件不提供預設值，也不得以實作便利為由自行填補。

### 6.1 Operation ID 與 Replay

- 同一 ID、同一請求：**確切**的原始結果 replay 行為。
- 同一 ID、不同事件或不同操作型別：conflict 語意。
- 同一 ID、不同請求 payload：mismatch 語意。
- ID 的持久唯一性與保留。
- Operation History 保留期與 replay 保證之間的關係。
- 歷史被清理後，是否需要持久 idempotency 紀錄或 tombstone。

### 6.2 Manual Retry 與 Provider Attempt

- Provider Attempt 的確切資料模型。
- Provider invocation 的持久標記／證據（MI-6c 計數重建所必需）。
- MI-6c 計數的具體重建方式。
- Operation 與 Attempt 的關聯。
- Phase 1 與 Phase 2 持久化失敗的處理。
- Provider 端冪等的支援或不存在。
- **不得**聲稱外部投遞為 exactly-once。

### 6.3 Lease 與 Recovery

- Manual Lease 的確切表示。
- Automatic Worker 與 Recovery 如何排除 Manual Lease。
- 過期 Manual Lease 的復原。
- 不確定結果如何維持 `dead` 而不自動重送。
- 與既有自動 delivery lease 及 retry 邏輯的互動。

### 6.4 Intervention Schema 與交易

- `outbox_intervention` 的確切欄位與約束。
- Hold 欄位名稱與型別。
- `intervention_outcome` 的**完整**值集。
- `completed_at` 的約束。
- Operation History 的 schema 與關聯。
- Retry、Hold、Release、Abandon 各自的 CAS 條件。
- Outbox、Intervention、Operation History、Provider Attempt 之間的原子性邊界。
- 既有 SQLite transaction／repository 組合的限制。

`[TO]` 既有實作觀察（僅為背景，不構成決策）：`SqliteDatabase.transaction()` 具巢狀交易守衛，而 repository 的 `immediate()` 以 raw `BEGIN IMMEDIATE` 繞過該旗標；`SqliteQueryable` 僅暴露 `query`。跨 repository 的原子操作需要共同交易邊界，其設計仍未決。

### 6.5 Actor 與 Reason

- Actor 格式與最大長度。
- 「未經驗證 Actor」如何表示。
- 未來 authentication／authorization 的邊界。
- Reason 的型別與最大長度。

### 6.6 Retention

- Operation History 保留。
- Operation ID 保留。
- Provider Attempt 保留。
- 與 `OUT-14`／`OUT-15`／`OUT-16` 的關係。
- 依 MI-4f 保留未完成介入與長期 Hold 事件。

`[OD]` 本節**不得**以任何方式解決，包括以「合理預設」形式。

---

## 7. Relationship to Previous Decisions（與既有決策的關係）

| 項目 | 關係 |
| --- | --- |
| MI-1 ～ MI-8 | Owner 政策決策，**非**實作授權 |
| MI-6a ～ MI-6h | Owner 政策決策，**非**實作授權 |
| `SPEC-GAP-18` | **未完成**；本文件只涵蓋操作語意子集 |
| P-1 ～ P-4 | 各自獨立的決策；本文件不修改、不延伸 |
| D-1 ～ D-5 | 各自獨立的決策；本文件不修改 |
| `OUT-14`／`OUT-15`／`OUT-16` | 保留與清理問題**仍 OPEN** |
| 其他 `SPEC-GAP` | 除本文件明列者外，**維持 OPEN** |
| `docs/architecture.md` | 本文件**不**取代它 |
| M7.0 主規格 | 本文件**不**取代它；衝突時以主規格為準並須回報 |

`[OD]` 本文件**不得**被解讀為聲稱 Outbox、Intervention、Provider Attempt 或 Recovery 的實作已存在。

`[TO]` **可追溯性觀察**：本 repository 先前沒有任何文件記錄 MI-1～MI-5；本文件是 MI 系列第一份落於 `docs/design/` 的紀錄，且僅涵蓋 MI-6a～MI-6h。MI-1～MI-5、MI-7、MI-8 的正式文件仍不存在。此為文件治理缺口，不是本文件可自行修補的範圍。

---

## 8. Implementation Authorization Boundary（實作授權邊界）

`[OD]` 本文件**未**授權且不得被解讀為授權：

- Outbox 資料表或 repository；
- `outbox_intervention` 資料表或 repository；
- Provider Attempt 的持久化結構；
- Retry／Hold／Release／Abandon 的 CLI；
- Delivery Worker 或 Recovery 的任何變更；
- Manual Lease 的實作；
- 任何 migration；
- 任何資料庫操作；
- 任何原始碼、測試、manifest、lockfile 的變更；
- 任何既有文件的變更。

`[TO]` 前置條件仍未滿足：Outbox envelope（P-5）、六個 `CHECK`、payload（`OUT-11`）、投遞通道（`SPEC-GAP-10`）、保留與清理（`OUT-14`／`OUT-15`／`OUT-16`）皆未決，因此介入相關實作**不得**開始。

---

## 9. Acceptance Criteria（本文件的驗收準則）

本文件被視為完整，僅當：

1. MI-6a～MI-6h 八項決策全部以 `CONFIRMED` 記錄，且條文與 Owner 選擇一致。
2. 20 條跨決策不變式全部列出，並標明來源歸屬（不得全部歸於 MI-6）。
3. `Unresolved Technical Details` 一節存在，且涵蓋 Operation ID／Provider Attempt／Lease／Schema／Actor／Retention 六類。
4. 所有未決項目標為 `OPEN`，無任何項目被靜默決定或填入預設值。
5. `held_at` 僅以示例形式出現，未作為已定案欄位名。
6. 未出現任何 SQL、欄位定義、lease schema 或 Recovery 設計。
7. 明確聲明本文件不授予實作授權、不完成 `SPEC-GAP-18`、不取代主規格或架構文件。
8. 未聲稱任何功能已實作或已測試。

---

## 10. Change History（變更歷史）

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | 建立 MI-6a～MI-6h 決策紀錄：成功 retry 不完成介入（6a）；Active Hold 獨立表示（6b）；retry 以 Provider invocation 計數（6c）；一次性 CLI 與兩階段 retry 執行（6d）；全域唯一 UUIDv4 Operation ID（6e）；Actor 由 CLI／環境提供且標示未驗證（6f）；不建立 Request Log（6g）；無固定 retry 上限（6h）。彙整 20 條跨決策不變式；未決技術細節全部標為 `OPEN`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[TO]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md`、S1、S0a、S0b、D-1～D-5、P-1～P-4 備忘錄、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema 或 migration。未執行測試、build、typecheck、lint、format、SQL、資料庫操作或任何 Git 寫入。
