# M7.0 Phase 2 — SPEC-GAP-07 P-2：`aggregate_id` Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | P-2 `aggregate_id` Owner 決策紀錄（SPEC-GAP-07 子項） |
| 狀態 | **`OWNER DECISION — CONFIRMED`** |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `P-2`（提案識別碼，來自 SPEC-GAP-07 唯讀分析；非 M7.0 規格中的 `SPEC-GAP` 或 `OUT-*` 識別碼） |
| 參照 | `SPEC-GAP-07`（M7.0 規格 L784）；分析報告 P-2 提案；Owner 選擇 **Option A** |
| 階段 | Phase 2 |
| 性質 | 決策紀錄。**本文件不授予任何實作授權。** |
| 母規格 | `docs/design/m7-0-ai-news-processing-pipeline.md`（M7.0），SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| 相關文件 | D-1、D-2、D-3、D-4、D-5；S1 — `m7-0-phase-2-processing-state-data-model.md`；S0a（L-01）；S0b（M-4） |

**標籤圖例。** `[OD]` 本文件所記錄的 Owner 已確認決策 · `[EX]` 既有已確認政策（非本文件所創） · `[ODR]` 未決、需 Owner 決策 · `[TO]` 技術觀察 · `[RC]` 建議（本文件不含建議）

---

## A. 背景與未決問題

`[EX]` `OUT-1` 固定 Outbox 的 primary key 為 `event_id`，並固定唯一約束 `UNIQUE(event_type, aggregate_id, notification_key)`；`OUT-17` 固定 `aggregate_id` 代表 **Article Lifecycle** 身分；`OUT-18` 固定 `aggregate_id` 為 soft reference，事件得在 article 列不存在時繼續投遞。

`[EX]` `SPEC-GAP-07` 仍為 `OPEN`，其文字明列「包括 `aggregate_id`（Article Lifecycle 身分）的**型別與產生方式**」尚未決定。

**未決問題。** `aggregate_id` 該用何種 SQLite 型別，以及其值從何而來？此問題影響：

1. `UNIQUE(event_type, aggregate_id, notification_key)` 的欄位型別與比較語意；
2. Outbox 是否會被迫建立與 lifecycle 的長期對照或身分記錄（`OUT-18` 明令禁止）；
3. Outbox 能否在 lifecycle 列被移除後仍保持有效（`OUT-18`、`OUT-26`）。

`[OD]` 本文件僅解決此一問題，即分析報告中的 **P-2**。

---

## B. Owner 決策（精確條文）

`[OD]` **`aggregate_id` SHALL use SQLite `TEXT` and SHALL store the exact original value of `processing_lifecycle.lifecycle_id`.**

`[OD]` 本決策包含下列八項條文，全部具約束力：

| # | 條文 |
| --- | --- |
| 1 | `aggregate_id` 代表 **Article Lifecycle 身分**；不代表 Article 身分、URL 身分、Processing Job 身分或 Processing Version 身分。 |
| 2 | 其值**直接複製**自對應的 `processing_lifecycle.lifecycle_id`。 |
| 3 | 本決策**不引入**任何轉換、URL 雜湊、代理身分對照或獨立識別碼派生。 |
| 4 | Outbox 的參照維持為 **soft reference**。 |
| 5 | **不得**自 Outbox 建立指向 `processing_lifecycle` 的外鍵。 |
| 6 | Outbox 記錄必須能獨立保留，**不得**依賴對應 Lifecycle 列的持續存在。 |
| 7 | 本決策與既有唯一性政策 `UNIQUE(event_type, aggregate_id, notification_key)` **相容**。 |
| 8 | D-5 的 Exhausted-job Alert 邏輯身分仍為 **Article Lifecycle + Processing Version**；本決策**不**將 Processing Version 移入 `aggregate_id`。 |

---

## C. `aggregate_id` 語意定義

`[OD]` `aggregate_id` 的語意為：**某一個 Article Lifecycle 的身分**，其生命週期自該 Lifecycle 首次開啟起，至該 Lifecycle 的記錄被移除為止；但 `aggregate_id` 的**值**在 Outbox 事件中的有效性不受該列是否仍存在影響（見 E 節）。

`[OD]` 一個 Lifecycle 的所有 Processing Version 共用同一個 `aggregate_id`；Processing Version 的變更**不改變** `aggregate_id`。

`[OD]` 重新發現（rediscovery）在原始內容刪除後開啟的是**新的** Lifecycle，因此具有**新的** `aggregate_id`；Outbox 事件各自攜帶自己的 `aggregate_id`，不建立長期身分記錄。

`[TO]` 上述語意與 `OUT-17`、`OUT-18` 一致，未新增或修改任何既有政策。

---

## D. TEXT 型別與值來源規則

`[OD]` **型別**：`aggregate_id` 的 SQLite 型別為 `TEXT`。

`[OD]` **值來源規則**：在建立 Outbox 事件時，`aggregate_id` 的值必須等於該事件所屬 Lifecycle 在 `processing_lifecycle.lifecycle_id` 中的**原值**，逐字元相同，不得正規化、不得改寫大小寫、不得加前綴或後綴、不得雜湊。

`[OD]` 本決策只固定**型別**與**值來源**。以下屬於 `[ODR]`，不在本決策範圍：

- 欄位是否 `NOT NULL`；
- 長度或其他 `CHECK` 約束；
- collation 的指定；
- 索引的具體定義與名稱。

`[TO]` 這些項目屬 P-5（envelope 欄位配置）與 `SPEC-GAP-07` 的六個 `CHECK` 範疇。

---

## E. Soft Reference 與禁止外鍵

`[OD]` Outbox 對 Lifecycle 的參照為 **soft reference**：`aggregate_id` 是值，不是參照完整性意義下的鍵。

`[OD]` **禁止**在 Outbox 表上建立指向 `processing_lifecycle` 的外鍵，也禁止任何會使 Lifecycle 列的刪除連帶影響 Outbox 列的機制。

`[OD]` Outbox 事件在對應 Lifecycle 列被移除後**必須**仍然有效、可讀、可投遞（`OUT-18`、`OUT-26`）。

`[TO]` 此禁令有實質後果：`PRAGMA foreign_keys = ON` 已啟用，且既有 schema 存在 cascade 關係，因此一個誤加的外鍵會真正刪除資料，而非僅是形式問題。

---

## F. 未採用的替代方案

`[OD]` 以下方案**未被選用**。它們不是「尚未決定的選項」，而是已排除的方案。

### F.1 Option B — INTEGER 代理身分

`[OD]` **未採用。**

`[OD]` 理由：它需要額外的對照或長期身分記錄，且無法直接保留已確認的 Article Lifecycle 身分語意；後者與 `OUT-18` 的「不建立長期 lifecycle 身分記錄」直接衝突。

### F.2 Option C — URL 雜湊

`[OD]` **未採用。**

`[OD]` 理由：URL 雜湊不是 Article Lifecycle 身分。同一個 URL 在原始內容刪除後被重新發現時，會開啟一個**新的** Lifecycle；若以 URL 派生身分，將使兩個本應不同的 Lifecycle 身分被合併，破壞 `OUT-17` 的語意，並使 D-5 的「每個 Lifecycle + Version 至多一個 Alert」失去意義。

`[TO]` 既有 `articles.id` 為 `"a1:" + sha256(canonicalUrl)`，正因如此不可作為 Lifecycle 身分；`A.1` 已記錄此點。本決策與該觀察一致。

---

## G. 與 D-5 及既有唯一性政策的相容性

`[EX]` 既有唯一性政策：`UNIQUE(event_type, aggregate_id, notification_key)`（`OUT-1`）。

`[OD]` 本決策與該約束相容，且**不要求修改**它：`aggregate_id` 為 `TEXT` 時，該三元組仍可表達「同一 Lifecycle、同一事件型別、同一通知鍵至多一列」。

`[OD]` D-5 的邏輯身分 **Article Lifecycle + Processing Version** 保持不變。由於 `aggregate_id` 只承載 Lifecycle 維度，**Processing Version 維度必須由 `notification_key` 承載**；`notification_key` 的具體編碼仍為 `OPEN`（P-3）。

`[OD]` 本決策**不**將 `processing_version` 移入 `aggregate_id`，也**不**恢復已被取代的 `(event_type, aggregate_id, processing_version)` 舊唯一鍵。

`[EX]` 本決策同時保留：Outbox payload 自足（`OUT-26`）；Outbox 保留獨立於 Article Lifecycle 保留（`OUT-25`）；Outbox 記錄不得經由 Lifecycle 外鍵 cascade 刪除；事件持久化先於投遞（`OUT-24`）；至少一次投遞（`OUT-4`）；`sent` 僅代表 provider 接受（`OUT-3`）。

---

## H. Lifecycle ID 產生邊界

`[OD]` 本決策**不**決定、也**不**授權實作 Lifecycle ID 的產生器。

`[OD]` 以下事項維持獨立，仍為 `[ODR]`：

- UUIDv4 的產生政策與實作（除非另有核准）；
- 除既有 D-2 之外的確切產生時機與整合細節；
- 併發首次 Claim 的衝突處理；
- Lifecycle 清理與保留的實作；
- 對 Processing repository 或 lifecycle-opening API 的任何變更。

`[EX]` D-2 仍為權威：Article Lifecycle 在 Processing 首次 claim 時，透過已核准的原子 claim-or-open 流程開啟。

`[TO]` 目前實作中，`openLifecycle` 由呼叫端傳入 `lifecycleId`（`processing-job.repository.ts:33`），尚未有產生器；本決策不改變此事實，也不推定任何產生格式。

---

## I. 明確未決項目（全部維持 OPEN）

`[ODR]` 本文件僅解決 P-2。以下全部**未**因本文件而解決：

| # | 項目 | 狀態 |
| --- | --- | --- |
| 1 | P-1：`event_id` 型別與產生方式 | **`OPEN`** |
| 2 | P-3：`notification_key` 具體編碼 | **`OPEN`** |
| 3 | P-4：四個 status 名稱與其資料庫不變式 | **`OPEN`** |
| 4 | P-5：完整 18 欄 envelope 配置與型別 | **`OPEN`** |
| 5 | 六個 `CHECK` 約束的定義 | **`OPEN`** |
| 6 | `OUT-11`：事件 payload 欄位與型別 | **`OPEN`** |
| 7 | `SPEC-GAP-10`：投遞通道與機制 | **`OPEN`** |
| 8 | `SPEC-GAP-18`：manual intervention 表示法與操作 | **`OPEN`** |
| 9 | `OUT-12`：drain cadence | **`OPEN`** |
| 10 | `OUT-14`：保留期間 | **`OPEN`** |
| 11 | `OUT-15`：cleanup 命令 | **`OPEN`** |
| 12 | `OUT-16`：實體刪除行為 | **`OPEN`** |
| 13 | `L-01`：terminal reason 詞彙與優先序 | **`OPEN`** |
| 14 | `L-02`：abandoned Lifecycle 表示法 | **`OPEN`** |
| 15 | `SPEC-GAP-15`：Processing 狀態儲存結構與 Lifecycle 清理 | **`OPEN`** |
| 16 | `M-4`：治理慣例 | **`OPEN`** |
| 17 | 其他無關的 `SPEC-GAP` 與 Owner `OPEN` 項目 | **`OPEN`** |

`[OD]` 本決策不縮小上述任何一項的範圍，也不為其提供預設值。

---

## J. 實作授權邊界

`[OD]` **本文件僅記錄一項已確認的 schema 設計政策，不授予任何實作授權。**

`[OD]` 本文件**未**授權且不得被解讀為授權：

- 建立 Outbox 資料表；
- 執行資料庫 migration；
- 實作 Outbox repository；
- 實作 Alert 持久化；
- 修改 Processing repository；
- 實作 Lifecycle ID 產生器；
- 實作 Lifecycle 清理；
- 變更既有 migration 或測試；
- 任何生產資料庫操作。

`[OD]` 亦不得據此修改原始碼、測試、`docs/architecture.md`、M7.0 規格或 `PROJECT_STATUS.md`。

`[TO]` 本決策解除了 SPEC-GAP-07 分析所列 P-2 項；Outbox 表仍無法建立，因為 P-1、P-3、P-4、P-5 與六個 `CHECK` 尚未決定。

---

## K. 變更歷史

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | 建立 P-2 決策紀錄：Owner 選擇 **Option A** — `aggregate_id` 使用 SQLite `TEXT`，儲存 `processing_lifecycle.lifecycle_id` 的原值；維持 soft reference、禁止外鍵、與 `UNIQUE(event_type, aggregate_id, notification_key)` 相容；Option B（INTEGER 代理身分）與 Option C（URL 雜湊）記錄為未採用。I 節所列項目全部維持 `OPEN`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[TO]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md`、S1、S0a、S0b、D-1、D-2、D-3、D-4、D-5 備忘錄、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema 或 migration。未執行測試、build、typecheck、SQL、資料庫操作或任何 Git 寫入。
