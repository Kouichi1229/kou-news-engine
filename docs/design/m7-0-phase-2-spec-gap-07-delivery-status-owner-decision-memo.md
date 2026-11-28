# M7.0 Phase 2 — SPEC-GAP-07 P-4：Outbox Delivery Status Model Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | P-4 Outbox Delivery Status Model Owner 決策紀錄（SPEC-GAP-07 子項） |
| Decision Status | **`CONFIRMED`** |
| Implementation Authorization | **`NOT GRANTED`** |
| Manual Intervention Representation | **`OPEN — SPEC-GAP-18`** |
| Outbox Full Schema | **`OPEN — P-5`** |
| Delivery Transition Details | **`OPEN / NOT DECIDED`** |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `P-4`（提案識別碼，來自 SPEC-GAP-07 唯讀分析；非 M7.0 規格中的 `SPEC-GAP` 或 `OUT-*` 識別碼） |
| 參照 | `SPEC-GAP-07`（M7.0 規格 L784）；`OUT-2`（L600）；P-4 選項分析 |
| 階段 | Phase 2 |
| 性質 | 決策紀錄。**本文件不授予任何實作授權。** |
| 母規格 | `docs/design/m7-0-ai-news-processing-pipeline.md`（M7.0），SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| 相關文件 | P-1（`event_id`）、P-2（`aggregate_id`）、P-3（`notification_key`）、D-1～D-5、S1、S0a、S0b |

**標籤圖例。** `[OD]` 本文件所記錄的 Owner 已確認決策 · `[EX]` 既有已確認政策（非本文件所創） · `[ODR]` 未決、需 Owner 決策 · `[TO]` 技術觀察／非規範說明

---

## A. Document Purpose and Scope（文件目的與範圍）

`[OD]` 本文件記錄 Owner 對 **P-4（Outbox Delivery Status Model）** 的確認決策：採用**四個 Delivery Status**，並將 **Manual Intervention 保持為獨立概念**。

`[OD]` 本文件**只**確立：Delivery Status 的**數量與語意**，以及「Delivery Status 與 Manual Intervention 分離」這項結構原則。

`[OD]` 本文件**不**決定：欄位名稱與型別、`NOT NULL`／`DEFAULT`／`CHECK`、六個 `CHECK` 的內容、完整狀態轉換矩陣、轉換的 SQL 條件、`leased` 的寫入與清除時機、`dead` 的進入條件、時戳欄位、Manual Intervention 的具體結構（見 G 節）。

`[TO]` 本文件是政策紀錄，不是 schema 規格、不是狀態機設計，也不是實作計畫。

---

## B. Decision Status（決策狀態）

| 欄位 | 值 |
| --- | --- |
| Decision Status | **`CONFIRMED`** |
| Decision ID | `P-4` |
| Decision date | 2026-11-27 |
| Owner selection | **Option A — Four Delivery Statuses, with Manual Intervention kept separate** |
| Implementation Authorization | **`NOT GRANTED`** |
| Manual Intervention Representation | **`OPEN — SPEC-GAP-18`** |
| Outbox Full Schema | **`OPEN — P-5`** |
| Delivery Transition Details | **`OPEN / NOT DECIDED`** |

`[TO]` `CONFIRMED` 僅涵蓋 C 節所列的四個 status 語意與分離原則；不涵蓋 `SPEC-GAP-07` 的其他部分。

---

## C. Owner Decision — P-4（已確認決策）

`[OD]` Owner 選擇 **Option A — Four Delivery Statuses, with Manual Intervention kept separate**。

`[OD]` 四種 Delivery Status 與其語意：

| Status | 語意 |
| --- | --- |
| `pending` | 事件等待傳送 |
| `leased` | 事件已取得傳送租約，正在處理 |
| `sent` | Provider 已接受事件 |
| `dead` | 自動傳送流程進入 Dead 狀態 |

`[OD]` 必須明確記錄的七點，全部具約束力：

| # | 條文 |
| --- | --- |
| 1 | Delivery Status **只**描述事件的**傳送生命週期**。 |
| 2 | Manual Intervention 是**另一個獨立概念**，**不得**併入 Delivery Status。 |
| 3 | `dead` **不代表**人工處置已完成。 |
| 4 | `sent` **只**代表 Provider acceptance，**不代表**終端使用者已收到事件。 |
| 5 | `abandon` **不得**將事件標記為 `sent`。 |
| 6 | **不得**將 `abandoned` 增加為第五種 Delivery Status。 |
| 7 | **不得**將 retry、hold、abandon 等人工處置**直接當成** Delivery Status。 |

`[TO]` 本決策為 `OUT-2` 所固定的「四個 status」提供了名稱；`OUT-2` 的「六個 check」內容仍 `OPEN`，未因本決策而決定。

---

## D. Delivery Status Semantics（狀態語意）

`[OD]` 每個 status 的**語意**已確認如下；其**進入條件、離開條件與轉換條件**全部 `NOT DECIDED`（見 G 節）。

| Status | 已確認語意 | 未決事項（不得推定） |
| --- | --- | --- |
| `pending` | 事件等待傳送 | 何時由 `pending` 轉出、是否需要 `next_attempt_at` 條件 |
| `leased` | 已取得傳送租約、正在處理 | 租約的寫入與清除時機、租約失效後的處理 |
| `sent` | Provider 已接受 | 是否伴隨 `sent_at`、是否為終態的 SQL 表達方式 |
| `dead` | 自動傳送流程進入 Dead 狀態 | 具體進入條件（`OUT-8` 固定第 8 次後，但實作判定的 SQL 未定） |

`[TO]` `OUT-8` 已確認「第 8 次 claim 耗盡後事件變為 `dead`」；本決策不改變該規則，也不決定其實作方式。

`[TO]` 四個 status 的**字面名稱**（`pending`、`leased`、`sent`、`dead`）由本決策確認；`sent` 的語意另由 `OUT-3` 固定。

---

## E. Delivery Status vs Manual Intervention（狀態與人工介入的分離）

`[OD]` Delivery Status 與 Manual Intervention 是**兩個獨立維度**：

| 維度 | 描述什麼 | 決策狀態 |
| --- | --- | --- |
| Delivery Status | 事件的**傳送生命週期**（`pending` / `leased` / `sent` / `dead`） | **`CONFIRMED`**（P-4） |
| Manual Intervention | 操作者對 `dead` 事件的處置（retry / hold / abandon） | **`OPEN — SPEC-GAP-18`** |

`[OD]` 分離原則的五項後果：

1. `dead` 是 **Delivery Status** 的終點，**不是**人工介入的完成點。
2. `abandon` 完成的是**介入**，不是**投遞**；因此**不得**使 Delivery Status 變成 `sent`。
3. `abandoned` **不是**第五種 Delivery Status，也**不得**寫入 Delivery Status 欄位。
4. retry、hold、abandon **不得**被當成 Delivery Status 值。
5. 判斷事件是否可清理時，**必須**分別檢視 delivery 條件與 intervention 條件，不得以單一 status 代替（`OUT-25`）。

`[TO]` `OUT-25` 已固定「介入完成不是成功投遞」「`abandon` 永不為 `sent`」「cleanup 必須分別測試 delivery 與 intervention 條件」；本決策以「兩個獨立維度」的結構落實該政策，但**不**決定 intervention 的具體欄位、狀態值或表關係（`SPEC-GAP-18`）。

---

## F. Compatibility with Confirmed Policies（與已確認政策的相容性）

### F.1 `OUT-1` — Outbox 邏輯唯一性

`[EX]` 唯一性依據為 `UNIQUE(event_type, aggregate_id, notification_key)`。

`[OD]` P-4 **不改變**此政策。**Delivery Status 不得**成為邏輯唯一性 tuple 的一部分。

### F.2 `OUT-9` — HTTP Timeout

`[EX]` HTTP timeout 為 **30 秒**。

`[OD]` P-4 **不得**修改此已確認設定。

### F.3 `OUT-10` — Outbox Lease

`[EX]` Outbox lease 為 **60 秒**。

`[OD]` `leased` 是 **Delivery Status**；本決策**不**重新定義 lease duration。

`[OD]` **不得**將 60 秒 lease 誤寫成 HTTP timeout：`OUT-9`（30 秒）與 `OUT-10`（60 秒）是**兩個不同時鐘**上的限制（一次 HTTP 呼叫 vs 一次 claim）。

### F.4 `OUT-24` — Persist Before Delivery

`[EX]` 事件必須**先持久化**，再進行 delivery。

`[OD]` P-4 **不改變**此政策。

### F.5 `OUT-25` — Dead Event Manual Intervention

`[EX]` 一般 `dead` Outbox Event **必須**保留人工介入流程；介入完成不是投遞成功。

`[OD]` 人工處置政策與 Delivery Status **分開**。**不得**將 `dead` 與「人工處置完成」混為一談。

### F.6 `OUT-26` — Self-contained Payload

`[EX]` Outbox Event 必須具有 self-contained payload。

`[OD]` P-4 **不改變**此政策。

### F.7 D-1 — Exhausted Job Handling

`[EX]` Exhausted Processing Job 的 terminalization 與 Alert persistence **必須**維持原先核准的原子性要求（同一個可靠一致性邊界；不得先終止化、後補 Alert）。

`[OD]` P-4 **不授權**修改 D-1。

### F.8 D-5 — Exhausted Alert Identity

`[EX]` Exhausted Alert 的邏輯唯一性範圍仍為 **Article Lifecycle + Processing Version**。

`[OD]` P-4 **不改變** D-5。

### F.9 P-1 — `event_id`

`[EX]` SQLite `TEXT`；application-generated UUIDv4。

`[OD]` P-4 **不改變** event identity。

### F.10 P-2 — `aggregate_id`

`[EX]` SQLite `TEXT`；原樣儲存 `processing_lifecycle.lifecycle_id`；soft reference，不設 FK。

`[OD]` P-4 **不改變** aggregate identity。

### F.11 P-3 — `notification_key`

`[EX]` SQLite `TEXT`；Initial Success `success:initial`；Exhausted Alert `exhausted:v<n>`；Correction 具體格式 `DEPENDENT — SPEC-GAP-17`。

`[OD]` P-4 **不改變** notification key。

---

## G. Explicitly Undecided Details（明確未決細節）

`[ODR]` 本次 P-4 **只**確立四種 Delivery Status 的語意與分類。以下**不得**自行定案：

| # | 未決事項 | 狀態 |
| --- | --- | --- |
| 1 | Outbox 完整資料表欄位及欄位名稱 | **`OPEN — P-5`** |
| 2 | Delivery Status 欄位的 SQLite 型別 | **`NOT DECIDED`** |
| 3 | `NOT NULL`、`DEFAULT`、`CHECK` 約束 | **`NOT DECIDED`** |
| 4 | 六個既有 `CHECK` 的具體定義 | **`OPEN`** |
| 5 | Delivery Status 的完整轉換矩陣 | **`OPEN / NOT DECIDED`** |
| 6 | 每個狀態轉換的 SQL 條件 | **`NOT DECIDED`** |
| 7 | `leased` 的實際寫入與清除時機 | **`NOT DECIDED`** |
| 8 | `dead` 的具體進入條件（實作層） | **`NOT DECIDED`** |
| 9 | `sent_at`、`dead_at` 等時間欄位是否存在 | **`NOT DECIDED`** |
| 10 | Manual Intervention 的具體欄位、狀態值與持久化結構 | **`OPEN — SPEC-GAP-18`** |
| 11 | Manual Intervention 與 Delivery Status 的資料表關係 | **`OPEN — SPEC-GAP-18`** |
| 12 | Retry、hold、abandon 的完整操作流程 | **`OPEN — SPEC-GAP-18`** |

`[ODR]` 其他仍為 `OPEN` 的項目（本文件未解決）：`OUT-11` payload、`SPEC-GAP-10` 投遞通道、`SPEC-GAP-17` Correction Event 身分、`SPEC-GAP-05` 版本域與建立政策、`OUT-12` drain cadence、`OUT-14` 保留期間、`OUT-15` cleanup 命令、`OUT-16` 實體刪除、`L-01`、`L-02`、`SPEC-GAP-15`、`M-4`，以及其他無關的 `SPEC-GAP`。

`[OD]` 本文件**不得**把任何候選設計寫成已核准政策。

---

## H. Non-Goals and Authorization Boundary（非目標與授權邊界）

### H.1 明確禁止的推論

`[OD]` 本文件**不得**被解讀為主張以下任何一項：

| # | 禁止的推論 |
| --- | --- |
| 1 | `dead` 等同於人工介入完成 |
| 2 | `abandoned` 是第五種 Delivery Status |
| 3 | `sent` 代表終端使用者已收到訊息 |
| 4 | Provider acceptance 等於 exactly-once delivery |
| 5 | `leased` 的 60 秒 lease duration 已由 P-4 決定 |
| 6 | 四種狀態已代表完整 Outbox Schema 定案 |
| 7 | P-4 已解決 `SPEC-GAP-18` |
| 8 | P-4 已核准任何 SQL `CHECK` |
| 9 | P-4 已授權 Outbox 或 Delivery 實作 |

`[TO]` 第 5 點特別重要：`OUT-10` 的 60 秒是**既有已確認政策**，P-4 只是使用 `leased` 這個狀態名稱，並未重新決定或延長該期間。

### H.2 未授權的實作

`[OD]` 本文件**未**授權且不得被解讀為授權：

- 建立 Outbox 資料表；
- 執行資料庫 migration；
- 實作 Outbox repository 或 delivery worker；
- 實作 Alert、Correction 或 delivery 功能；
- 實作 manual intervention 介面或資料結構；
- 變更 Processing repository 或 Processing 行為；
- 變更原始碼、測試、`package.json`、`package-lock.json`；
- 變更 M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md` 或任何既有決策備忘錄；
- 任何生產資料庫操作；
- Scheduler 部署或設定。

---

## I. Impact on Future Implementation（對未來實作的影響）

`[TO]` 本決策解除的不確定性只有一項：Delivery Status 有**四個**、名稱固定、且**不含**介入狀態。它使下列後續工作有明確邊界：

| 後續工作 | 仍受阻於 |
| --- | --- |
| 撰寫 `status` 欄與其 `CHECK` | 六個 `CHECK` 內容（`OPEN`）、欄位型別（`NOT DECIDED`） |
| 撰寫狀態轉換 | 轉換矩陣與 SQL 條件（`OPEN / NOT DECIDED`） |
| 設計清理條件 | `OUT-14` 期間、`OUT-16` 刪除機制、`SPEC-GAP-18` 介入完成判定 |
| 實作 delivery worker | `SPEC-GAP-10` 通道、`OUT-12` cadence |
| 完成 Outbox 表 | P-5（18 欄配置） |

`[TO]` 因此 Outbox 表仍**不可建立**。P-4 是必要條件，不是充分條件。

---

## J. References and Decision Traceability（引用與追溯）

| 引用 | 內容 |
| --- | --- |
| M7.0 L600 `OUT-2` | 4 個 status、6 個 check（僅數量；名稱由 P-4 補足） |
| M7.0 L601 `OUT-3` | `sent` = provider 接受，非終端送達 |
| M7.0 L606 `OUT-8` | 第 8 次 claim 耗盡後變為 `dead` |
| M7.0 L607 `OUT-9` | HTTP timeout 30 秒 |
| M7.0 L608 `OUT-10` | Outbox lease 60 秒 |
| M7.0 L622 `OUT-24` | 先持久化，後投遞 |
| M7.0 L623 `OUT-25` | `dead` 進入 manual intervention；介入完成 ≠ 投遞成功；`abandon` 永不為 `sent`；cleanup 分別測試兩條件 |
| M7.0 L624 `OUT-26` | payload 自足 |
| M7.0 L795 `SPEC-GAP-18` | manual intervention 表示法與操作介面仍 `OPEN` |
| M7.0 L784 `SPEC-GAP-07` | 欄位列舉、status 名、六個 check |
| P-1 備忘錄 | `event_id` = `TEXT` + application-generated UUIDv4 |
| P-2 備忘錄 | `aggregate_id` = `TEXT`、`lifecycle_id` 原值、soft reference、無 FK |
| P-3 備忘錄 | `notification_key` = `TEXT`；`success:initial`；`exhausted:v<n>`；Correction `DEPENDENT — SPEC-GAP-17` |
| D-1 備忘錄 | 終止化與 Alert 持久化必須同一一致性邊界 |
| D-5 備忘錄 | Exhausted Alert 邏輯唯一性 = Lifecycle + Processing Version |

`[TO]` 決策追溯：Owner 於 2026-11-27 自 P-4 選項 A/B/C 中選擇 **Option A**；本文件為該選擇的正式紀錄。

---

## K. 變更歷史

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | 建立 P-4 決策紀錄：Owner 選擇 **Option A** — 四個 Delivery Status（`pending`、`leased`、`sent`、`dead`），Manual Intervention 保持為獨立維度；`abandoned` 不為第五種 status；`abandon` 不得標記為 `sent`；`dead` ≠ 介入完成。G 節十二項維持 `OPEN`／`NOT DECIDED`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[TO]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md`、S1、S0a、S0b、D-1～D-5、P-1、P-2、P-3 備忘錄、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema 或 migration。未執行測試、build、typecheck、lint、format、SQL、資料庫操作或任何 Git 寫入。
