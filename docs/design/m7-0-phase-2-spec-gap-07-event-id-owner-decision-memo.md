# M7.0 Phase 2 — SPEC-GAP-07 P-1：`event_id` Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | P-1 `event_id` Owner 決策紀錄（SPEC-GAP-07 子項） |
| Decision Status | **`CONFIRMED`** |
| Implementation Authorization | **`NOT GRANTED`** |
| Remaining Details | **`OPEN` / `NOT DECIDED`**（見 G 節） |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `P-1`（提案識別碼，來自 SPEC-GAP-07 唯讀分析；非 M7.0 規格中的 `SPEC-GAP` 或 `OUT-*` 識別碼） |
| 參照 | `SPEC-GAP-07`（M7.0 規格 L784）；P-1 選項分析 |
| 階段 | Phase 2 |
| 性質 | 決策紀錄。**本文件不授予任何實作授權。** |
| 母規格 | `docs/design/m7-0-ai-news-processing-pipeline.md`（M7.0），SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| 相關文件 | P-2（aggregate_id）、P-3（notification_key）、D-1～D-5、S1、S0a、S0b |

**標籤圖例。** `[OD]` 本文件所記錄的 Owner 已確認決策 · `[EX]` 既有已確認政策（非本文件所創） · `[ODR]` 未決、需 Owner 決策 · `[TO]` 技術觀察／非規範說明

---

## A. Document Purpose and Scope（文件目的與範圍）

`[OD]` 本文件記錄 Owner 對 `SPEC-GAP-07` 子項 **P-1（`event_id` 識別碼設計）** 的確認決策。

`[OD]` 本文件**只**確立 `event_id` 的**型別**、**識別碼格式**與**產生責任**三件事。

`[OD]` 本文件**不**決定 Outbox 表的完整結構、不決定任何約束或索引、不決定產生時機與失敗處理、不授權任何實作（見 G、H 節）。

`[TO]` 本文件是一份政策紀錄，不是設計文件、不是實作計畫，也不是 schema 規格。

---

## B. Decision Status（決策狀態）

| 欄位 | 值 |
| --- | --- |
| Decision Status | **`CONFIRMED`** |
| Decision ID | `P-1` |
| Decision date | 2026-11-27 |
| Owner selection | **Option A — SQLite `TEXT` + Application-generated UUIDv4** |
| Implementation Authorization | **`NOT GRANTED`** |
| Remaining Details | **`OPEN` / `NOT DECIDED`** |

`[OD]` `CONFIRMED` 僅指上述三項（型別、格式、產生責任）已由 Owner 確認；它**不**代表 `SPEC-GAP-07` 整體已解決。

---

## C. Owner Decision — P-1（已確認決策）

`[OD]` Owner 選擇 **Option A — SQLite `TEXT` + Application-generated UUIDv4**。

`[OD]` 已確認事項，共五項：

| # | 條文 |
| --- | --- |
| 1 | Outbox 的 `event_id` 欄位使用 SQLite **`TEXT`** 型別。 |
| 2 | `event_id` 使用 **UUIDv4** 作為識別碼格式。 |
| 3 | UUIDv4 由**應用程式**產生（application-generated）。 |
| 4 | **不採用** SQLite `INTEGER` 自增主鍵作為此識別碼方案。 |
| 5 | **不採用** UUIDv7 或 ULID 作為此決策的識別碼方案。 |

`[TO]` 第 4、5 項記錄的是**已排除**的方案，不是「尚未決定的選項」。

`[OD]` 本決策只涉及 `event_id`。它不改變、不覆蓋、也不重新開啟 P-2（`aggregate_id`）或 P-3（`notification_key`）的任何條文。

---

## D. Identifier Semantics（識別碼語意）

`[OD]` 三個識別碼用途不同，**不得**混為一談：

| 識別碼 | 所代表的身分 | 決策來源 | 在唯一性中的角色 |
| --- | --- | --- | --- |
| `event_id` | **Outbox Event 自身**的識別碼 | P-1（本文件） | **不屬於**邏輯唯一性 tuple |
| `aggregate_id` | **Article Lifecycle** 的識別碼 | P-2 | 屬於 `UNIQUE(event_type, aggregate_id, notification_key)` |
| `notification_key` | 事件的**邏輯唯一性**識別鍵 | P-3 | 屬於 `UNIQUE(event_type, aggregate_id, notification_key)` |

`[OD]` `event_id` 回答的是「這是哪一列事件」；`notification_key` 回答的是「這個邏輯事件是否已經存在」。兩者職責不可互換。

`[OD]` `event_id` 的 UUID 值**不得**被寫入 `notification_key`。

---

## E. Relationship with P-2 and P-3（與 P-2、P-3 的關係）

### E.1 P-2 — `aggregate_id`

`[EX]` P-2 仍為權威：

- 型別為 SQLite `TEXT`；
- 儲存原始 `processing_lifecycle.lifecycle_id`；
- **原樣保存**，不做 normalization、case conversion、prefix 或 hash；
- 為 **soft reference**，**不設** Lifecycle 外鍵；
- Outbox Event 必須能在 Lifecycle 資料列被刪除後繼續存在。

`[OD]` P-1 與 P-2 無衝突：`event_id` 標識事件列，`aggregate_id` 標識 lifecycle，兩者為不同欄位、不同來源、不同用途。

### E.2 P-3 — `notification_key`

`[EX]` P-3 仍為權威：

- 型別為 SQLite `TEXT`；
- Initial Success：`success:initial`；
- Exhausted Alert：`exhausted:v<n>`（`<n>` 為 `processing_version` 的標準十進位表示）；
- Correction 具體格式：**`DEPENDENT — SPEC-GAP-17`**。

`[OD]` `notification_key` **不得**混入 `event_id` 的 UUID 值。

`[TO]` 三者的關係可概括為：`event_id` 唯一標識一列；`(event_type, aggregate_id, notification_key)` 唯一標識一個邏輯事件；P-1 只處理前者。

---

## F. Compatibility with Confirmed Outbox Policies（與已確認 Outbox 政策的相容性）

### F.1 `OUT-1` — 邏輯唯一性 tuple

`[EX]` Outbox 邏輯唯一性依據為：`UNIQUE(event_type, aggregate_id, notification_key)`。

`[OD]` 明確的三點：

1. **`event_id` 不屬於**上述邏輯唯一性 tuple。
2. **不得**把 `processing_version` 加回上述唯一性 tuple（該舊方案已於 2026-11-26 被取代）。
3. `event_id` 是事件識別碼，**不能**取代 `notification_key` 的邏輯去重責任。

### F.2 `OUT-24`、`OUT-25`、`OUT-26`

`[EX]` 事件必須**先持久化**再進行 delivery（`OUT-24`）；一般 `dead` 事件的 **Manual Intervention** 與 **Delivery Status** 必須保持不同概念（`OUT-25`）；Outbox payload 必須 **self-contained**（`OUT-26`）。

`[OD]` `event_id` 的選擇**不會改變**上述任一政策。

### F.3 D-5 — Exhausted Alert 邏輯唯一性

`[EX]` Exhausted Alert 的邏輯唯一性範圍為 **Article Lifecycle + Processing Version**；同一 Lifecycle、同一 Processing Version **不得**因重複 Recovery 產生多筆邏輯 Alert。

`[OD]` P-1 **不改變** D-5 的邏輯唯一性政策；該政策由 `aggregate_id`（P-2）與 `notification_key`（P-3）承載，與 `event_id` 無關。

---

## G. Explicitly Undecided Details（明確未決細節）

`[ODR]` 以下細節**沒有**獲得 Owner 核准，維持 `OPEN` / `NOT DECIDED`。**不得**因為採用 UUIDv4 而推定其已核准：

| # | 未決事項 | 狀態 |
| --- | --- | --- |
| 1 | `event_id` 是否使用 `NOT NULL` | **`NOT DECIDED`** |
| 2 | 是否設定 `UNIQUE` 約束 | **`NOT DECIDED`** |
| 3 | 是否建立獨立索引 | **`NOT DECIDED`** |
| 4 | 是否設定 `CHECK` 約束 | **`NOT DECIDED`** |
| 5 | UUIDv4 的格式驗證規則 | **`NOT DECIDED`** |
| 6 | UUID 字串大小寫規範 | **`NOT DECIDED`** |
| 7 | UUIDv4 的具體產生時機 | **`NOT DECIDED`** |
| 8 | 由哪一個應用程式模組負責產生 | **`NOT DECIDED`** |
| 9 | UUID 產生失敗時的處理方式 | **`NOT DECIDED`** |
| 10 | Outbox Table 的完整欄位結構及其他約束 | **`OPEN`**（P-5、六個 `CHECK`） |

`[ODR]` 其他仍為 `OPEN` 的項目（本文件未解決）：P-4 status 模型、P-5 完整 18 欄 envelope、六個 `CHECK` 約束、`OUT-11` payload、`SPEC-GAP-10` 投遞通道、`SPEC-GAP-17` Correction Event 身分、`SPEC-GAP-18` manual intervention、`SPEC-GAP-05` 版本域與建立政策、`OUT-12`、`OUT-14`、`OUT-15`、`OUT-16`、`L-01`、`L-02`、`SPEC-GAP-15`、`M-4`，以及其他無關的 `SPEC-GAP`。

---

## H. Non-Goals and Authorization Boundary（非目標與授權邊界）

### H.1 明確禁止的推論

`[OD]` 本文件**不得**被解讀為主張以下任何一項：

| # | 禁止的推論 |
| --- | --- |
| 1 | UUIDv4 自動保證 Outbox Event 的邏輯唯一性 |
| 2 | UUIDv4 可以取代資料庫 `UNIQUE` 約束 |
| 3 | UUIDv4 可以取代 `notification_key` |
| 4 | UUIDv4 可以保證外部 delivery exactly-once |
| 5 | UUIDv4 代表 Outbox Table Schema 已經定案 |
| 6 | P-1 已授權 Outbox 實作 |
| 7 | P-1 已解決其他 `SPEC-GAP` |

`[TO]` UUIDv4 是本次核准的**識別碼生成方案**，不是資料完整性保證，也不是 delivery 保證。

### H.2 未授權的實作

`[OD]` 本文件**未**授權且不得被解讀為授權：

- 建立 Outbox 資料表；
- 執行資料庫 migration；
- 實作 Outbox repository；
- 實作 Alert、Correction 或 delivery 功能；
- 變更 Processing repository 或 Processing 行為；
- 變更 Lifecycle ID 或 Processing Version 的產生；
- 變更原始碼、測試、`package.json`、`package-lock.json`；
- 變更 M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md` 或任何既有決策備忘錄；
- 任何生產資料庫操作；
- Scheduler 部署或設定。

---

## I. Impact on Future Implementation（對未來實作的影響）

`[TO]` 本決策對未來實作的影響僅限於一項：Outbox 表的 `event_id` 欄位型別為 `TEXT`，其值由應用程式以 UUIDv4 產生。除此之外，實作仍受下列未決項目限制：

| 阻擋項 | 影響 |
| --- | --- |
| P-4（status 模型）、六個 `CHECK` | 無法撰寫 `status` 欄與表約束 |
| P-5（18 欄配置） | 無法完成表結構 |
| `SPEC-GAP-17` | Correction key 與 Correction Event schema 無法實作 |
| `OUT-11`（payload） | 無法決定 payload 欄位 |
| `SPEC-GAP-10`（通道） | 無法實作 delivery |

`[TO]` 因此 Outbox 表仍**不可建立**。P-1 只解除「識別碼型別與產生責任」這一項不確定性。

---

## J. References and Decision Traceability（引用與追溯）

| 引用 | 內容 |
| --- | --- |
| M7.0 L599 `OUT-1` | 18 欄、PK `event_id`、`UNIQUE(event_type, aggregate_id, notification_key)` |
| M7.0 L636-641 | 唯一鍵曾為 `(event_type, aggregate_id, processing_version)`，2026-11-26 已被取代 |
| M7.0 L655 | `processing_version` 為 provenance，不屬唯一性 |
| M7.0 L623 `OUT-25` | `dead` 進入 manual intervention；介入完成 ≠ 投遞成功 |
| M7.0 L624 `OUT-26` | payload 自足 |
| M7.0 L784 `SPEC-GAP-07` | 欄位列舉、status 名、六個 check、型別與產生 |
| P-2 備忘錄 | `aggregate_id` = `TEXT`、`lifecycle_id` 原值、soft reference、無 FK |
| P-3 備忘錄 | `notification_key` = `TEXT`；`success:initial`；`exhausted:v<n>`；Correction `DEPENDENT — SPEC-GAP-17` |
| D-5 備忘錄 | Exhausted Alert 邏輯唯一性 = Lifecycle + Processing Version |

`[TO]` 決策追溯：Owner 於 2026-11-27 自 P-1 選項 A/B/C 中選擇 **Option A**；本文件為該選擇的正式紀錄。

---

## K. 變更歷史

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | 建立 P-1 決策紀錄：Owner 選擇 **Option A** — `event_id` 使用 SQLite `TEXT`，以 application-generated UUIDv4 產生；排除 SQLite `INTEGER` 自增主鍵、UUIDv7、ULID。G 節十項細節維持 `NOT DECIDED`／`OPEN`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[TO]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md`、S1、S0a、S0b、D-1～D-5、P-2、P-3 備忘錄、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema 或 migration。未執行測試、build、typecheck、lint、format、SQL、資料庫操作或任何 Git 寫入。
