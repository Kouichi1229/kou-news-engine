# M7.0 Phase 2 — SPEC-GAP-07 P-3：`notification_key` Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | P-3 `notification_key` Owner 決策紀錄（SPEC-GAP-07 子項，ODQ-1 至 ODQ-4） |
| 狀態 | **`PARTIALLY RESOLVED — OWNER DECISIONS CONFIRMED; CORRECTION ENCODING DEPENDENT`** |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `P-3`（提案識別碼，來自 SPEC-GAP-07 唯讀分析；非 M7.0 規格中的 `SPEC-GAP` 或 `OUT-*` 識別碼） |
| 參照 | `SPEC-GAP-07`（M7.0 規格 L784）；P-3 唯讀分析報告 ODQ-1～ODQ-4 |
| 階段 | Phase 2 |
| 性質 | 決策紀錄。**本文件不授予任何實作授權。** |
| 母規格 | `docs/design/m7-0-ai-news-processing-pipeline.md`（M7.0），SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| 相關文件 | P-2（`m7-0-phase-2-spec-gap-07-aggregate-id-owner-decision-memo.md`）；D-1～D-5；S1；S0a（L-01）；S0b（M-4） |

**標籤圖例。** `[OD]` 本文件所記錄的 Owner 已確認決策 · `[EX]` 既有已確認政策（非本文件所創） · `[DEP]` 依賴其他未決項目 · `[ODR]` 未決、需 Owner 決策 · `[TO]` 技術觀察／非規範理由

---

## A. 背景與未決問題

`[EX]` `OUT-1` 固定 Outbox 的唯一約束為 `UNIQUE(event_type, aggregate_id, notification_key)`。該約束曾為 `(event_type, aggregate_id, processing_version)`，於 2026-11-26 因與 `OUT-19` 衝突而**被取代**（M7.0 L636-641）；`processing_version` 自此僅為 provenance 欄位，不屬唯一性（L655）。

`[EX]` `OUT-19` 固定初始成功通知的 key 為 lifecycle 常數，且不得由 `processing_version`、attempt 或 derived-record identity 派生。`OUT-21` 固定 correction 通知的 key 來自**已持久化 correction event 的身分**。D-5 固定耗盡 Alert 的邏輯身分為 **Article Lifecycle + Processing Version**，並要求版本維度由 `notification_key` 承載。P-2 固定 `aggregate_id` 為 `TEXT` 且儲存 `processing_lifecycle.lifecycle_id` 原值。

`[ODR]` 仍未決的是 `notification_key` 的**具體編碼規則**：欄位型別、三種事件型別各自的字面格式、版本的正規化方式，以及 correction 在識別格式未定前如何處理。

`[OD]` 本文件記錄 Owner 對 ODQ-1～ODQ-4 的裁示。其中 ODQ-4 的結果是**延後** correction 的具體編碼，因此本文件狀態為「部分解決」。

---

## B. ODQ-1 — `notification_key` 的 SQLite 型別

`[OD]` Owner 選擇 **Option A**。

`[OD]` **`notification_key` SHALL use SQLite `TEXT`.**

`[OD]` 本決策**僅**確立欄位型別。以下**不在**本決策範圍，仍受相關未決 schema 決策管轄：

- `NOT NULL` 約束；
- 最大長度；
- collation；
- 索引定義；
- 任何 `CHECK` 約束；
- 完整 Outbox 表結構。

---

## C. ODQ-2 — 命名空間鍵方案

`[OD]` Owner 選擇 **Option B**：對**具體格式已決定**的事件類別採用命名空間鍵方案。

`[OD]` 已確認的格式如下，字面即為契約：

| 事件類別 | 精確 key 格式 |
| --- | --- |
| Initial Success | `success:initial` |
| Exhausted Alert | `exhausted:v<n>` |
| Correction | **`DEPENDENT — SPEC-GAP-17`**（見 F 節） |

`[OD]` 命名空間字串為**固定小寫 ASCII 字面**（`success`、`exhausted`）。

`[OD]` 冒號（`:`）為命名空間分隔符。

`[OD]` **不得**引入 scheme 版本前綴（例如 `nk1:`）。

`[OD]` **不得**以雜湊式 key 取代本方案。

`[OD]` **不得**在上述 key 中加入 Lifecycle ID、attempt 次數、Recovery 執行識別或可變 payload 欄位。

`[TO]` `success:initial` 中的 `initial` 段與命名空間同義重複；Owner 已選擇一致性優先於最短長度，此為已決事實，非待決項。

---

## D. ODQ-3 — Exhausted Alert 的版本正規化

`[OD]` Owner 選擇 **Option A**。

`[OD]` Exhausted Alert key 中的 Processing Version 部分，**SHALL** 由已持久化的 `processing_version` **整數值**格式化為其**標準十進位表示**產生。

`[OD]` 精確格式：`exhausted:v<canonical-decimal-integer>`

`[OD]` 範例（僅示範編碼行為）：

| 已持久化整數 | 精確 key |
| ---: | --- |
| 0 | `exhausted:v0` |
| 1 | `exhausted:v1` |
| 10 | `exhausted:v10` |
| -1 | `exhausted:v-1` |

`[OD]` **規範性格式規則（七條，全部具約束力）**：

1. 來源值為已持久化的整數 `processing_version`。
2. key 必須由整數值產生，**不得**以未經檢核的外部字串拼接產生。
3. 十進位表示**不得**含前導零。
4. 正值**不得**含前導 `+`。
5. 負值保留 `-` 號。
6. **不得**使用固定寬度補零。
7. 本決策**不引入**任何 Processing Version 的最小或最大域限制。

`[OD]` **重要邊界**：上述範例僅定義**編碼行為**，**不**表示零或負數的 Processing Version 是合法業務值。Processing Version 的合法域、起始值與版本建立政策仍由 `SPEC-GAP-05` 管轄，**不得**在本文件中臆造。

`[OD]` **不得**引入最大版本號。

---

## E. ODQ-4 — Correction key 的具體編碼

`[OD]` Owner 選擇 **Option C**：Correction key 的具體字串格式**延後**至 `SPEC-GAP-17` 解決。

`[OD]` 以下**語意要求**在 `OUT-21` 之下維持已確認，且不因延後格式而改變：

1. Correction key 的身分**必須**源自已持久化的 Correction Event 身分。
2. 同一已持久化 Correction Event 的重複通知嘗試**必須**產生相同的邏輯 key。
3. 不同的已持久化 Correction Event **必須**具有不同的邏輯身分。
4. 僅有 Lifecycle ID **不足**。
5. 僅有 Processing Version **不足**。
6. attempt 次數與 transient Worker 執行識別**不得**取代 Correction Event 身分。
7. key **不得**僅由可變 payload 內容派生。

`[OD]` 以下細節**未**經核准，不得選擇、暗示或推定：

- surrogate Correction ID；
- UUID 格式；
- 複合身分編碼；
- 分隔符或轉義方案；
- 長度前綴編碼；
- Correction Event schema。

`[DEP]` Correction key 最終**必須**與已選定的命名空間方案相容，但其命名空間後綴與編碼方式**未**由本文件核准。具體編碼標記為：

**`DEPENDENT — SPEC-GAP-17`**

`[OD]` Correction 的**身分政策**（來源為已持久化 Correction Event 身分）已由 `OUT-21` 確認，**不得**標記為 `OPEN`；只有其**具體編碼**為 `DEPENDENT`。

---

## F. 與既有已確認政策的相容性

### F.1 `OUT-1` — 唯一三元組

`[EX]` 既有唯一性政策維持為 `UNIQUE(event_type, aggregate_id, notification_key)`。

`[OD]` **不得**恢復已被取代的 `UNIQUE(event_type, aggregate_id, processing_version)`。

`[EX]` `processing_version` 仍為 provenance 資料，**不**獨立加入唯一性元組。Exhausted Alert 的版本維度**在 `notification_key` 字串內**表示。

### F.2 `OUT-19` — Initial Success

`[OD]` Initial Success key 固定為 `success:initial`。

`[OD]` 對同一 Article Lifecycle，該 key 在以下情況**必須**保持完全相同：

- 不同的 Processing Version；
- 不同的 Processing Attempt；
- 不同的 Recovery 執行。

`[OD]` 該 key **不得**由 Processing Version、attempt 次數、Recovery 執行次數或 derived-record identity 派生。

### F.3 D-5 — Exhausted Alert 身分

`[EX]` 邏輯身分維持為 **Article Lifecycle + Processing Version**。

`[EX]` 唯一元組已透過 `aggregate_id` 承載 Lifecycle 身分。

`[OD]` key 透過 `exhausted:v<n>` 承載 Processing Version。

`[OD]` 因此，同一 Lifecycle 與同一 Processing Version 的重複 Recovery 執行**必須**對應到相同的邏輯 key。

`[OD]` 較晚的 Processing Version **必須**對應到不同的 key。

`[OD]` **不得**加入 attempt 次數或 Recovery 執行識別。

### F.4 `OUT-21` — Correction 身分

`[EX]` Correction key 的身分仍為已持久化的 Correction Event 身分；具體編碼延後至 `SPEC-GAP-17`（見 E 節）。

### F.5 P-2 — `aggregate_id`

`[EX]` P-2 仍為權威：SQLite `TEXT`、儲存 `processing_lifecycle.lifecycle_id` 原值、soft reference、禁止外鍵。

`[OD]` P-3 **不得**在 key 內重複 Lifecycle 身分。

### F.6 其他已確認 Outbox 政策

`[EX]` 以下全部維持不變：

| 政策 | 內容 |
| --- | --- |
| `OUT-17` | `aggregate_id` 為 Article Lifecycle 身分 |
| `OUT-18` | soft reference |
| `OUT-24` | 先持久化，後投遞 |
| `OUT-25` | `dead` 的一般事件進入 manual intervention；介入完成不是投遞成功 |
| `OUT-26` | payload 自足 |
| `OUT-4` | at-least-once 投遞仍被接受 |
| `OUT-3` | `sent` 僅代表 provider 接受 |
| `OUT-25` | Outbox 保留獨立於 Lifecycle 保留 |

`[OD]` key **不得**編碼投遞狀態、重試次數、lease 狀態或 manual-intervention 狀態。

---

## G. 命名空間與遷移後果（非規範理由）

`[TO]` 以下為設計理由與後果記錄，**不構成**新的決策：

1. `event_type` 已參與唯一元組，提供資料庫層級的事件型別分離。
2. 因此命名空間**並非**跨事件型別唯一性所必需。
3. Owner 仍選擇命名空間鍵，理由為可讀性與誤用防護。
4. 已選格式**不需要** scheme 版本前綴。
5. key 格式是一份**穩定的邏輯身分契約**；日後變更可能需要資料遷移或 backfill，以避免產生重複的邏輯事件。
6. 同一邏輯事件若以不同的 key 字串表示，**不會**自動與舊 key 衝突（唯一元組不會阻止它）。
7. 資料庫唯一約束**不**保證外部投遞的 exactly-once。
8. at-least-once 仍是已確認的投遞模型。

`[OD]` 本節不建立遷移策略或實作設計，僅記錄上述後果。

---

## H. 明確的已決、依賴與未決狀態

### H.1 P-3 已解決

`[OD]` 以下全部為已確認：

| 項目 | 結果 |
| --- | --- |
| ODQ-1 | SQLite `TEXT` |
| ODQ-2 | 命名空間鍵方案 |
| Initial Success key | `success:initial` |
| Exhausted Alert key 樣式 | `exhausted:v<n>` |
| ODQ-3 | 標準十進位整數正規化 |
| ODQ-4 | Correction 具體編碼延後至 `SPEC-GAP-17` |
| Correction 語意身分來源 | 已持久化 Correction Event 身分（`OUT-21`） |

### H.2 P-3 依賴項

`[DEP]` Correction key 的具體編碼：**`DEPENDENT — SPEC-GAP-17`**。

### H.3 其他未決事項（全部維持 `OPEN`）

`[ODR]` 以下**未**因本文件而解決，**不得**標記為已解決：

| # | 項目 |
| --- | --- |
| 1 | P-1：`event_id` 型別與產生方式 |
| 2 | P-4：status 模型 |
| 3 | P-5：完整 18 欄 envelope |
| 4 | 六個 `CHECK` 約束 |
| 5 | `OUT-11`：payload 欄位與型別 |
| 6 | `SPEC-GAP-10`：投遞通道與機制 |
| 7 | `SPEC-GAP-17`：Correction Event 身分 schema 與產生 |
| 8 | `SPEC-GAP-18`：manual intervention 表示法 |
| 9 | `SPEC-GAP-05`：Processing Version 域與版本建立政策 |
| 10 | `OUT-12`：drain cadence |
| 11 | `OUT-14`：保留期間 |
| 12 | `OUT-15`：cleanup 命令 |
| 13 | `OUT-16`：實體刪除行為 |
| 14 | `L-01`：terminal reason 詞彙與優先序 |
| 15 | `L-02`：abandoned Lifecycle 表示法 |
| 16 | `SPEC-GAP-15`：Processing 狀態儲存結構與 Lifecycle 清理 |
| 17 | `M-4`：治理慣例 |
| 18 | 其他無關的 `SPEC-GAP` 與 Owner `OPEN` 項目 |

`[OD]` 解決 P-3 **不**解決上述任何一項。

---

## I. 實作授權邊界

`[OD]` 本文件僅記錄政策決策，**不授予任何實作授權**。

`[OD]` 本文件**未**授權且不得被解讀為授權：

- 建立 Outbox 資料表；
- 執行資料庫 migration；
- 實作 Outbox repository；
- 實作 Alert 持久化；
- 實作 Correction Event schema 或 repository；
- 實作通知投遞；
- 變更 Processing repository；
- 變更 Lifecycle ID 產生；
- 變更 Processing Version 的產生或驗證；
- 變更原始碼或測試；
- 變更生產資料庫；
- 變更 M7.0 規格或架構文件。

`[OD]` 亦不得據此修改任何原始碼、測試、migration、schema、專案狀態、package 檔案或既有決策備忘錄。

`[TO]` Outbox 表仍無法建立：P-1、P-4、P-5 與六個 `CHECK` 尚未決定；Correction key 的具體編碼仍依賴 `SPEC-GAP-17`。

---

## J. 變更歷史

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | 建立 P-3 決策紀錄。Owner 裁示：ODQ-1 = `TEXT`；ODQ-2 = 命名空間鍵方案（`success:initial`、`exhausted:v<n>`）；ODQ-3 = 以持久化整數的標準十進位格式化（七條規則）；ODQ-4 = Correction 具體編碼延後至 `SPEC-GAP-17`（語意身分來源仍由 `OUT-21` 確認）。未引入 scheme 前綴、未採雜湊方案、未加入 Lifecycle／attempt／Recovery 識別。H.3 所列 18 項維持 `OPEN`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[TO]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md`、S1、S0a、S0b、D-1～D-5、P-2 備忘錄、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema 或 migration。未執行測試、build、typecheck、SQL、資料庫操作或任何 Git 寫入。
