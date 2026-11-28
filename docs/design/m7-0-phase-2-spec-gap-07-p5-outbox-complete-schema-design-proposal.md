# M7.0 Phase 2 — SPEC-GAP-07 P-5：Outbox 完整 Schema 設計提案（Rev 4）

| 項目 | 內容 |
| --- | --- |
| 文件 | P-5 Outbox Complete Schema Design Proposal |
| 版次 | **Rev 4**（Rev 1：初稿；Rev 2：依 P5-OD 與 RC-1～RC-10 修訂；Rev 3：依第二輪審查 B-1～B-6、SI-1／SI-2 修訂；Rev 4：納入 Owner 凍結之 Payload 決策並記錄 MVP 實作） |
| 狀態 | **`PROPOSED — NOT APPROVED`** |
| 性質 | 設計提案。**不授予任何實作授權，不構成已核准 schema。** |
| 修訂依據 | P5-OD-01～P5-OD-05（Owner Decisions）；第一輪審查 RC-1～RC-10；第二輪審查 B-1～B-6、SI-1／SI-2 |
| 參照 | M7.0 規格（L599 `OUT-1`、L600 `OUT-2`、L604-608、L609-614、L615-624、L784 `SPEC-GAP-07`）；P-1～P-4；MI-1～MI-8；MI-6a–h；OD-A；OD-1／OD-2／OD-3；D-1～D-5；S1 |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |

**標籤圖例。** `[CONFIRMED]` 已核准政策或規範 · `[ADOPTED]` 經授權委託採用、但來源 memo 仍標 `PROPOSED` 者 · `[PROPOSED]` 本提案建議（未核准） · `[INFERENCE]` 由已確認政策推導 · `[OPEN]` 未決

**Rev 2 修訂摘要。** 納入 P5-OD-01～05；修正 RC-1～RC-10。核心變更：Manual Retry 期間 Delivery Status 維持 `dead`（`leased` 專屬自動投遞）；Phase 2／Recovery 交易補齊三表；Abandon 加入手動 lease 前置條件並移除恆真謂詞；CC-6 改寫以排除 SQLite 三值邏輯漏洞；History 改為 soft reference；新增 Transaction Owner 規範。

**Rev 3 修訂摘要。** 依第二輪審查修正 B-1～B-6：
- **B-1**：Rev 2 的 CC-6 **仍有殘餘漏洞**（`finalized_by IS NULL` 使第二分支求值為 NULL 而通過），Rev 3 加入 `finalized_by IS NOT NULL` 並補五組反例驗證表與六條 CHECK 的三值複核。
- **B-2**：新增 §10.1「跨表身分驗證八條件」，套用於 Marker／Phase 2／Recovery，明示不得以 `UNIQUE(lease_token)` 取代。
- **B-3**：新增 §12.5，將 Intervention 資料列建立時機列為 `OPEN — REQUIRES OWNER DECISION`，並標示所有依賴流程為條件式設計。
- **B-4**：新增 §10.2，Phase 2 的三種 Provider 結果各自明列 Event／Intervention／Attempt 的 SET 分支。
- **B-5**：新增 §12.6，將「Marker 未提交時的 Recovery outcome 語意」列為 `OPEN — REQUIRES OWNER DECISION`，不新增第四種 outcome。
- **B-6**：CC-5 加入 `held_at IS NULL`，使 Hold 與有效 Manual Lease 在資料庫層互斥；Hold CAS 同步加 `manual_lease_token IS NULL`。
- **SI-1／SI-2**：確認 Rev 2 已修正，Rev 3 檢查全篇無殘留。
- Readiness：Full P-5 Design 與 Implementation Readiness 均降為 **`NOT READY`**（B-3／B-5／RC-10 未解）。

**Rev 4 修訂摘要。** 納入 Owner 於 2026-11-28 凍結的 Outbox Payload 決策，並記錄其 MVP 實作：
- **Payload 結構凍結**：Common Payload Header（`schema_version`／`event_type`／`lifecycle_id`／`source_url`）＋ Event-Type Discriminated Body，三型 `initial_success`／`exhausted_alert`／`correction`。詳見 **§3.2**。
- **C-4 解除**：`OUT-11` 的 payload 欄位與 schema 由 Owner 決議凍結（不再是本文件的未決項）；`OUT-11` 在 M7.0 規格本文中的 `OPEN` 狀態未由本文件改寫。
- **序列化與上限凍結**：JSON／SQLite `TEXT`／UTF-8 位元組上限（總量 65,536 bytes，逐欄上限見 §3.2.3）；超限拒絕、不截斷。
- **不可變性凍結**：payload 持久化後永不修改；Retry 重用同一持久化字串；可變狀態（Delivery Status／Lease／Intervention）留在 envelope 與既有狀態表。
- **實作落點**：`src/modules/outbox/payload.{constants,types,errors,serializer}.ts`；單元測試 32 項、整合測試 6 項。
- **仍然未解**：本文件其餘項目（B-3、B-5、RC-10、C-5～C-8）不因 Rev 4 而改變；文件整體狀態維持 **`PROPOSED — NOT APPROVED`**。

---

## 1. Scope and Authority（範圍與權威）

`[CONFIRMED]` `OUT-1`（M7.0 L599）固定：Outbox 有 **18 個欄位**、PK `event_id`、`UNIQUE(event_type, aggregate_id, notification_key)`。`OUT-2`（L600）固定 **4 個 status** 與 **6 個 CHECK**（僅數量）。

`[CONFIRMED]` 規格**未列舉** 18 個欄位名稱（L626-628）。因此 §3 的 18 欄清單**全部為 `[PROPOSED]`**，不得引用為已確認要求。

`[CONFIRMED]` 權威來源：M7.0 規範本文、P-1～P-4、MI-1～MI-8、MI-6a–h、OD-A、OD-1／OD-2／OD-3、D-1～D-5，以及 **P5-OD-01～P5-OD-05**。非規範附錄 A 不作為 schema 依據。

`[CONFIRMED]` 本文件只提出設計，**不授權實作**。

---

## 2. Confirmed Policy Baseline（已確認政策基線）

| 領域 | 條文 | 來源 | 狀態 |
| --- | --- | --- | --- |
| Event 身分 | `event_id` TEXT、app UUIDv4 | P-1 | `[CONFIRMED]` |
| Aggregate | `aggregate_id` TEXT = lifecycle id 原值、soft reference、無 FK | P-2 | `[CONFIRMED]` |
| Notification key | `notification_key` TEXT 命名空間（`success:initial`／`exhausted:v<n>`／correction 未決） | P-3 | `[CONFIRMED]` |
| 唯一性 | `(event_type, aggregate_id, notification_key)`；`processing_version` 僅 provenance | `OUT-1`、L655 | `[CONFIRMED]` |
| Delivery Status | 四值 `pending`／`leased`／`sent`／`dead`；`sent` = provider 接受 | P-4、`OUT-3` | `[CONFIRMED]` |
| **`leased` 專屬自動投遞** | Manual Retry 期間 status 維持 `dead`；Manual Lease 僅存於 intervention；自動 lease 欄位只服務自動投遞；Phase 2 驗證 event 為 `dead` + 有效 manual lease/token/attempt/介入狀態/期限 | **P5-OD-01** | `[CONFIRMED]` |
| **History FK** | `event_id` 為 soft reference，無 FK；event 刪除不影響 history；history 可長於 event；append-only 禁任意 UPDATE；DELETE 須依另案核准之 retention 政策 | **P5-OD-02** | `[CONFIRMED]` |
| **Intervention/Attempt FK** | 兩者 → `outbox_event`，`ON DELETE RESTRICT`；不得 CASCADE | **P5-OD-03** | `[CONFIRMED]` |
| **Intervention outcome** | 僅 NULL 或 `abandoned`；與 `completed_at` 成對；hold／release／retry 均不完成介入 | **P5-OD-04** | `[CONFIRMED]` |
| **Abandon 前置** | 有效 manual lease 存在時禁止 abandon（回 Conflict）；須等 Phase 2 完成或 Recovery 處理過期 lease；不得強制清除有效 lease；過期未回收者不得假設已清除 | **P5-OD-05** | `[CONFIRMED]` |
| 介入結構 | 1:1 `outbox_intervention`；`intervention_outcome` + `completed_at` | MI-1、MI-2 | `[CONFIRMED]` |
| Hold | 未完成、不改 status、無自動到期 | MI-4a | `[CONFIRMED]` |
| Release | 只清 hold；不投遞、不完成介入 | MI-4b | `[CONFIRMED]` |
| Abandon | 不可逆、`abandoned`、不改 status | MI-5-α/β/γ/ε | `[CONFIRMED]` |
| Manual Retry | 僅 `dead`；held 須先 release；重用 payload；不呼叫 LLM | MI-3 | `[CONFIRMED]` |
| Retry 完成語意 | retry 不完成介入 | MI-6a | `[CONFIRMED]` |
| Retry 計數 | 以 provider invocation 計；無上限；無獨立計數欄 | MI-6c、MI-6h | `[CONFIRMED]` |
| 兩階段執行 | Phase 1 交易內／Phase 2 交易外 HTTP 30s／Phase 2 不改 history | MI-6d | `[CONFIRMED]` |
| Operation ID | 全域 UUIDv4、唯一索引、replay 回原結果 | MI-6e、MI-8 | `[CONFIRMED]` |
| Actor／Reason | actor 必填未驗證、reason 選填；無 request log | MI-4e、MI-6f、MI-6g | `[CONFIRMED]` |
| Lease fencing | 過期後 Phase 2 不得寫入；`>= now`（P2/Marker）／`< now`（Recovery）；`now` 於取得 `BEGIN IMMEDIATE` 後取得 | OD-1 | `[ADOPTED]` |
| 儲存落點 | envelope 18 欄不變；lease 與介入在 `outbox_intervention`；attempt 在 `provider_attempt`；history 獨立 | OD-2 | `[ADOPTED]` |
| Marker | Phase 1 之後、HTTP 之前的獨立 fenced 交易；0 列則不呼叫 HTTP | OD-3 | `[ADOPTED]` |
| 保守計數 | 跨越 marker 邊界即計一次；`outcome_unknown` 本身不決定計數 | OD-A | `[ADOPTED]` |
| 自動投遞 | backoff 30s 起、6h 上限、full jitter、8 次、耗盡 → `dead`；HTTP 30s；outbox lease 60s | `OUT-6`..`OUT-10` | `[CONFIRMED]` |
| D-1 | 耗盡 job 終止化與 alert 持久化必須原子 | D-1 | `[CONFIRMED]` |

`[CONFIRMED]` **RC-9 修正**：Rev 1 曾宣稱「C-1 是唯一影響結構的未決政策」。此敘述**不成立**。Rev 2 的狀態分類見 §12.1。

---

## 3. Complete 18-Field Envelope Proposal

`[PROPOSED]` 以下 18 欄為本提案配置；**數量 18 符合 `OUT-1`，欄位名稱與型別未經核准**。

| # | 欄位 | SQLite 型別 | NULL | 預設 | 用途 | 依據 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `event_id` | TEXT | NOT NULL | — | 事件列身分（PK） | P-1、`OUT-1` |
| 2 | `event_type` | TEXT | NOT NULL | — | 事件類別，屬唯一鍵 | `OUT-1` |
| 3 | `aggregate_id` | TEXT | NOT NULL | — | Article Lifecycle 身分（soft） | P-2、`OUT-17` |
| 4 | `notification_key` | TEXT | NOT NULL | — | 邏輯通知識別，屬唯一鍵 | P-3、`OUT-19`／`OUT-21`、D-5 |
| 5 | `processing_version` | INTEGER | NOT NULL | — | 產生此事件的版本（provenance） | L655 |
| 6 | `status` | TEXT | NOT NULL | — | Delivery Status（四值） | P-4、`OUT-2` |
| 7 | `payload` | TEXT | NOT NULL | — | 自足 payload（JSON 文字） | `OUT-26` |
| 8 | `attempts` | INTEGER | NOT NULL | 0 | 已消耗的**自動**投遞次數（0–8） | `OUT-6`..`OUT-8` |
| 9 | `next_attempt_at` | INTEGER | NOT NULL | — | 下次自動嘗試時間（epoch ms）；終態事件填 sentinel | `OUT-6`、`OUT-7` |
| 10 | `lease_owner` | TEXT | NULL | — | **自動**投遞 lease 持有者 | `OUT-10`、P5-OD-01 |
| 11 | `lease_token` | TEXT | NULL | — | **自動**投遞 lease 權杖 | `OUT-10`、P5-OD-01 |
| 12 | `lease_expires_at` | INTEGER | NULL | — | **自動** lease 到期（epoch ms） | `OUT-10`（60s） |
| 13 | `last_error_code` | TEXT | NULL | — | 最近失敗分類碼 | `OUT-8`、`A.11` |
| 14 | `last_error_summary` | TEXT | NULL | — | 有界錯誤摘要（**不得**含原文） | `A.11`、`OUT-26` |
| 15 | `created_at` | TEXT | NOT NULL | — | 建立時間（ISO 8601） | 稽核（v5 慣例） |
| 16 | `updated_at` | TEXT | NOT NULL | — | 最後更新（ISO 8601） | 稽核（v5 慣例） |
| 17 | `sent_at` | INTEGER | NULL | — | provider 接受時間（epoch ms） | `OUT-3` |
| 18 | `dead_at` | INTEGER | NULL | — | 進入 `dead` 的時間（epoch ms） | `OUT-8` |

**`[CONFIRMED]` 欄位總數 = 18，與 `OUT-1` 一致。** 未新增第 19 欄。

`[CONFIRMED]` **P5-OD-01 的後果**：第 10–12 欄**只**表達自動投遞 lease。Manual Retry 不使用這三欄，也不改變 `status`（維持 `dead`）。因此 CC-2 的語意不因手動流程而擴張。

`[INFERENCE]` **時間表示混用**：`created_at`／`updated_at` 為 TEXT（沿用 v5 `processing_job`），其餘時序欄位為 INTEGER epoch（沿用 v5 `lease_expires_at INTEGER`）。繼承既有 schema，非本提案新創。

`[OPEN]` `next_attempt_at` 對 `sent`／`dead` 事件的 sentinel 值未定（見 §12 TR-3）。
`[OPEN]` `attempts` 的 0–8 範圍未以 CHECK 強制（六條預算不足），僅能靠應用層（見 §12 TR-2）。
`[CONFIRMED — OWNER 2026-11-28]` `payload` 內部結構已凍結，見 **§3.2**。`OUT-11` 在 M7.0 規格本文中仍標示 `OPEN`，本文件不改寫該規格；凍結來源是本文件的 Owner 決策，而非規格條文。

### 3.1 非規範性 DDL（示意，**未核准**）

```sql
-- [PROPOSED] NON-NORMATIVE — 不得作為 migration 使用
CREATE TABLE outbox_event (
  event_id           TEXT    PRIMARY KEY NOT NULL,
  event_type         TEXT    NOT NULL,
  aggregate_id       TEXT    NOT NULL,
  notification_key   TEXT    NOT NULL,
  processing_version INTEGER NOT NULL,
  status             TEXT    NOT NULL,
  payload            TEXT    NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    INTEGER NOT NULL,
  lease_owner        TEXT        NULL,
  lease_token        TEXT        NULL,
  lease_expires_at   INTEGER     NULL,
  last_error_code    TEXT        NULL,
  last_error_summary TEXT        NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  sent_at            INTEGER     NULL,
  dead_at            INTEGER     NULL,
  CONSTRAINT chk_oe_status      CHECK (/* CC-1 */ 1),
  CONSTRAINT chk_oe_lease       CHECK (/* CC-2 */ 1),
  CONSTRAINT chk_oe_terminal    CHECK (/* CC-3 */ 1)
);
```

### 3.2 Payload Schema（Owner 凍結，2026-11-28）

`[CONFIRMED — OWNER 2026-11-28]` 本節內容為 Owner 凍結的 Payload MVP 決策，並已實作。它是本文件中**唯一**已獲實作授權的區塊（§14 的一般禁止不適用於本節）。

#### 3.2.1 結構

Payload 分兩層，**不是** 18 欄 envelope，也**不是** provider request body：

- **Common Header**（三型共用）：`schema_version`、`event_type`、`lifecycle_id`、`source_url`
- **Body**（依 `event_type` 判別）：

| `event_type` | Body 欄位 |
| --- | --- |
| `initial_success` | `headline`、`summary` |
| `exhausted_alert` | `processing_version`、`terminal_reason`、`failure_category`、`attempts_consumed`、`max_attempts` |
| `correction` | `fact_item`、`previous_value`、`corrected_value`、`evidence_summary` |

`[CONFIRMED — OWNER 2026-11-28]` 所有 JSON key 使用 `snake_case`；不要求 key 固定順序，不要求 canonical JSON。

`[CONFIRMED — OWNER 2026-11-28]` **自足性**（`OUT-26` 的落實）：`correction` 必須內嵌完整證據內容，**不得**只保存 correction record 的 id，也不得於投遞時查詢 article／lifecycle／correction 任何一列。

`[CONFIRMED — OWNER 2026-11-28]` `evidence_summary` 必須是 AI 生成的摘要，不得包含來源文章逐字原文或逐字節錄（`OUT-22`、`OUT-26`）。

#### 3.2.2 範例

```json
{
  "schema_version": 1,
  "event_type": "exhausted_alert",
  "lifecycle_id": "lifecycle-uuid",
  "source_url": "https://example.com/article",
  "body": {
    "processing_version": 2,
    "terminal_reason": "max_attempts_exhausted",
    "failure_category": "extraction_failure",
    "attempts_consumed": 3,
    "max_attempts": 3
  }
}
```

```json
{
  "schema_version": 1,
  "event_type": "initial_success",
  "lifecycle_id": "lifecycle-uuid",
  "source_url": "https://example.com/article",
  "body": { "headline": "AI 模型發布", "summary": "摘要內容" }
}
```

```json
{
  "schema_version": 1,
  "event_type": "correction",
  "lifecycle_id": "lifecycle-uuid",
  "source_url": "https://example.com/article",
  "body": {
    "fact_item": "funding_amount",
    "previous_value": "100M USD",
    "corrected_value": "120M USD",
    "evidence_summary": "AI 生成摘要說明金額已由 100M 更正為 120M USD。"
  }
}
```

#### 3.2.3 大小上限

`[CONFIRMED — OWNER 2026-11-28]` 完整序列化 JSON 最大 **65,536 UTF-8 bytes**，三型共用。超限**拒絕建立**，**不得截斷**。

| 欄位 | 最大 UTF-8 bytes |
| --- | ---: |
| `lifecycle_id` | 128 |
| `source_url` | 4,096 |
| `headline` | 2,048 |
| `summary` | 16,384 |
| `terminal_reason` | 128 |
| `failure_category` | 128 |
| `fact_item` | 1,024 |
| `previous_value` | 4,096 |
| `corrected_value` | 4,096 |
| `evidence_summary` | 8,192 |

`[INFERENCE]` 目前逐欄上限總和約 22.6 KB，因此在欄位上限維持不變的前提下，65,536 bytes 的總量上限**不可達**；它保留為未來放寬逐欄上限時的防護線。讀取路徑同樣套用該上限，故超出上限的既有列會被拒絕解析而非送給 Worker。

#### 3.2.4 驗證規則

`[CONFIRMED — OWNER 2026-11-28]`

- 必填欄位不得缺失；**欄位缺失** 與 **顯式 `null`** 必須區分為不同錯誤。
- Nullable 與 Optional 分開處理（本版所有欄位皆 required 且 non-nullable）。
- 空字串不允許（本版所有字串欄位皆須非空）。
- 已知欄位驗證型別與 UTF-8 長度；數值欄位驗證整數與範圍（`processing_version >= 1`、`attempts_consumed >= 0`、`max_attempts >= 1`）。
- 未知欄位**忽略**（剝除），不視為錯誤。
- 未知 `event_type` 與不支援的 `schema_version` **拒絕解析**。
- `schema_version` 為整數；非整數視為欄位錯誤，整數但不支援視為版本錯誤。

#### 3.2.5 序列化與不可變性

`[CONFIRMED — OWNER 2026-11-28]`

- 格式：JSON；SQLite 儲存型別 `TEXT`。
- 不新增 SHA-256 欄位、不做多層 hash 驗證、不加入數位簽章或防竄改機制。
- Payload 持久化後**永不修改**；Retry 必須重用完全相同的持久化字串；內容變更須建立新事件。
- Delivery Status、Lease、Manual Intervention 等可變狀態**不得**放入 payload（留在 envelope 與既有狀態表）。
- 解析結果為唯讀檢視；持久化字串才是事實來源。

#### 3.2.6 分層邊界

`[INFERENCE]` 三層不可混同：**envelope**（18 欄，含 `status`／`attempts`／lease，可變）／**payload**（本節，凍結）／**provider request body**（每次投遞組裝，不持久化）。`SPEC-GAP-10` 的通道與 provider 格式未定，故 payload 保持通道中立。

#### 3.2.7 本節未決定的事項

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| `failure_category` 值域 | `OPEN` | M7.0 的 `CLM-4` 固定 `LlmErrorKind` 詞彙，但凍結範例使用 `extraction_failure`（不在該詞彙內）。本版只驗證非空與 ≤128 bytes，不建立封閉值域。 |
| `event_type` 字面值 | `OPEN`（`SPEC-GAP-07`） | 本版凍結 `exhausted_alert`；Appendix A.6（非規範）寫 `alert`。兩者不可互換。 |
| `terminal_reason` 詞彙 | `OPEN`（`CLM-9`／L-01） | 本版只驗證非空與 ≤128 bytes。 |
| correction 內容語意細節 | `OPEN`（`SPEC-GAP-17`） | fact taxonomy、正規化、evidence size limits 未定；本節只凍結欄位與上限。 |
| 通道與 provider body | `OPEN`（`SPEC-GAP-10`） | 不影響 payload 結構。 |

#### 3.2.8 實作落點與測試

`src/modules/outbox/payload.constants.ts`（上限與字面值）、`payload.types.ts`（zod schema 與型別）、`payload.errors.ts`（錯誤碼）、`payload.serializer.ts`（`validatePayload`／`serializePayload`／`parsePayload`）。

測試：`tests/unit/modules/outbox/payload.serializer.test.ts`（32 項）、`tests/integration/outbox/payload.persistence.test.ts`（6 項）。整合測試使用 `:memory:` 的臨時 probe 表，**不**建立 Outbox 表（本文件仍未核准其欄位，§14）。

---

## 4. `outbox_intervention` Proposal

`[CONFIRMED]` MI-1：與 `outbox_event` **1:1** 的獨立表。`[PROPOSED]` 欄位：

| 欄位 | 型別 | NULL | 用途 | 依據 |
| --- | --- | --- | --- | --- |
| `event_id` | TEXT | NOT NULL | PK，1:1 對應 `outbox_event` | MI-1 |
| `intervention_outcome` | TEXT | NULL | 最終結果；僅 NULL 或 `abandoned` | MI-2、P5-OD-04 |
| `completed_at` | INTEGER | NULL | 介入完成時間（epoch ms） | MI-2、P5-OD-04 |
| `held_at` | INTEGER | NULL | Active Hold 時間（**名稱僅示例**） | MI-6b |
| `manual_lease_token` | TEXT | NULL | 當前 Manual Lease 權杖 | P5-OD-01、OD-1 |
| `manual_lease_expires_at` | INTEGER | NULL | 當前 Manual Lease 到期 | P5-OD-01、OD-1 |
| `manual_lease_attempt_id` | TEXT | NULL | 當前 lease 綁定的 attempt | P5-OD-01、OD-3 |
| `created_at` | TEXT | NOT NULL | 建立時間 | 稽核 |
| `updated_at` | TEXT | NOT NULL | 更新時間 | 稽核 |

`[CONFIRMED]` **欄位命名說明**：P5-OD-04 以 `outcome` 簡稱本欄；實際名稱沿用 MI-2 已確認的 `intervention_outcome`。兩者指同一欄位，不得視為兩個欄位。

`[CONFIRMED]` **P5-OD-01**：Manual Lease 三欄只存在於此表，且**不**影響 `outbox_event.status`。Manual Retry 期間 event 維持 `dead`。

`[INFERENCE]` **`manual_lease_attempt_id` 的必要性**：Phase 2／Marker／Recovery 需驗證「相符的 Attempt 身分」，僅靠 token 不足以偵測 attempt 與 lease 不一致。

`[CONFIRMED]` **FK**：`event_id REFERENCES outbox_event(event_id) ON DELETE RESTRICT`（P5-OD-03）。

`[OPEN]` `held_at` 的確切名稱與型別（MI-6b 明示為示例）。

### 4.1 Intervention 資料列的建立時機（B-3）

`[OPEN — REQUIRES OWNER DECISION]` **目前未核准 Intervention row 的建立時機。** 本節不得被引用為已定案。

`[INFERENCE]` 後果：Event 建立時**未必**存在對應的 Intervention row。因此 Hold、Release、Abandon、Retry Phase 1 若直接對 `outbox_intervention` 執行 `UPDATE`，在該列不存在時會**影響 0 列**；在不做列數檢查的實作中，這會被誤判為「狀態衝突」或（更糟）被靜默忽略，而操作者的 history 紀錄仍可能寫入。

`[OPEN]` 兩種候選方案（§12.5 詳述，**未選擇**）：

- **方案 A**：建立 Event 時，在同一交易內建立對應的 Intervention row。
- **方案 B**：第一次 Hold／Abandon／Retry 時，以原子方式確保 Intervention row 存在（先 `INSERT … WHERE NOT EXISTS` 或等價機制，再 `UPDATE`）。

`[CONFIRMED]` 在 Owner 決定前，**所有依賴此選擇的交易流程（§10 #6～#13）均為條件式設計**，其期望列數假設「該列已存在」；若採方案 B，這些流程需增加「確保列存在」步驟，期望列數亦隨之改變。**不得宣稱此部分為 READY。**

---

## 5. `provider_attempt` Proposal

`[CONFIRMED]` OD-2：Provider Attempt 獨立成表。`[PROPOSED]` 欄位：

| 欄位 | 型別 | NULL | 用途 | 依據 |
| --- | --- | --- | --- | --- |
| `attempt_id` | TEXT | NOT NULL | PK（app UUIDv4） | 技術必要性 |
| `event_id` | TEXT | NOT NULL | 所屬事件 | OD-2、P5-OD-03 |
| `lease_token` | TEXT | NOT NULL | 對應的 Manual Lease | OD-1、OD-3 |
| `operation_id` | TEXT | NOT NULL | 對應的 Operation History 紀錄 | MI-6e、MI-7 |
| `marker_at` | INTEGER | NULL | OD-A possible-invocation marker 時間 | OD-A、OD-3 |
| `outcome` | TEXT | NULL | `provider_accepted`／`provider_rejected`／`outcome_unknown` | MI-3 |
| `finalized_at` | INTEGER | NULL | 結果最終化時間 | OD-1 |
| `finalized_by` | TEXT | NULL | `phase2`／`recovery` | OD-1 |
| `created_at` | TEXT | NOT NULL | 建立時間（Phase 1） | OD-3 |

`[ADOPTED]` 生命週期：**Phase 1 建立**（`outcome`／`marker_at` 皆 NULL）→ **Marker 交易**寫 `marker_at` → **Phase 2 或 Recovery** 寫 `outcome` + `finalized_at` + `finalized_by`（OD-3）。

`[INFERENCE]` **範圍限定**：此表**只記錄 Manual Retry 的嘗試**。自動投遞的嘗試以 envelope 的 `attempts`／`last_error_*` 表達，**不**寫入此表。

`[INFERENCE]` **一 lease 一 attempt**：`lease_token` 唯一 → Recovery 只能最終化既有列，結構上不可能重複建立（見 §8 #11）。

`[INFERENCE]` **計數推導**：`COUNT(*) WHERE marker_at IS NOT NULL`（OD-A 邊界）。`outcome_unknown` 單獨不決定計數。

`[OPEN]` `attempt_id` 是否改為自然鍵 `(event_id, lease_token)`。

---

## 6. Append-only Operation History Proposal

`[PROPOSED]` 欄位：

| 欄位 | 型別 | NULL | 用途 | 依據 |
| --- | --- | --- | --- | --- |
| `operation_id` | TEXT | NOT NULL | PK；全域唯一 UUIDv4 | MI-6e、MI-8 |
| `event_id` | TEXT | NOT NULL | 所屬事件（**soft reference，無 FK**） | MI-7、P5-OD-02 |
| `operation_type` | TEXT | NOT NULL | `retry`／`hold`／`release`／`abandon` | MI-4、MI-5、MI-6d |
| `actor` | TEXT | NOT NULL | 操作者（**未驗證**） | MI-4e、MI-6f |
| `reason` | TEXT | NULL | 選填理由 | MI-4e |
| `result_state` | TEXT | NOT NULL | 操作後的狀態摘要（供 replay 回傳） | MI-8 |
| `created_at` | TEXT | NOT NULL | 操作時間 | MI-7 |

`[CONFIRMED]` **P5-OD-02**：`event_id` 為 soft reference，**不建立** FK；event 刪除不影響 history；history 可長於原始 event。

`[CONFIRMED]` **append-only 的定義**：禁止任意 UPDATE；Phase 2 不得更新或刪除既有列（MI-6d）。**DELETE 不在「任意禁止」之列**——僅能由未來核准的 retention／cleanup 政策授權（`OUT-14`–`OUT-16` 未決）。

`[CONFIRMED]` 僅被接受且完成有效轉移的操作寫入（MI-5-δ、MI-6g）；state conflict 不寫。

`[INFERENCE]` **replay**：同 `operation_id` 重放時，以 `result_state` 回傳原結果，不重複執行。

`[OPEN]` 同 ID 不同 payload／事件／型別的 mismatch 語意（MI-6e 未定）。
`[OPEN]` 歷史清理後 replay 退化為新操作（需 retention 政策）。
`[OPEN]` `result_state` 的表達力是否足以重建原結果（§12 TR-5）。

### 6.1 append-only 的強制機制（RC-6 修正）

`[PROPOSED]` 以 `BEFORE UPDATE` trigger 拒絕對 history 的更新；**不**建立阻擋 DELETE 的 trigger。

`[CONFIRMED]` 理由：若同時阻擋 DELETE，將使 `OUT-16` 的清理永久不可行，與 P5-OD-02「DELETE 服從 retention 政策」衝突。Rev 1 §6 的「`BEFORE UPDATE`／`BEFORE DELETE` trigger」寫法已作廢。

---

## 7. Exactly Six Logical CHECK Constraints

`[CONFIRMED]` `OUT-2` 固定 **6 個 CHECK**（僅數量）。`[PROPOSED]` 以下為六條邏輯約束。

### CC-1 `chk_outbox_event_status_domain`（`outbox_event`）

```sql
CHECK (status IN ('pending','leased','sent','dead'))
```
- 不變式：Delivery Status 值域封閉。
- 阻止：第五個 status（如 `abandoned`）被寫入。
- 性質：`[CONFIRMED]`（P-4）之技術落實。

### CC-2 `chk_outbox_event_lease_consistency`（`outbox_event`）

```sql
CHECK (
  (status = 'leased'
     AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  OR (status <> 'leased'
     AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
)
```
- 不變式：**自動** lease 三欄 all-or-none，且僅在 `status='leased'` 存在。
- 阻止：`pending`／`dead`／`sent` 卻帶 lease；`leased` 卻無 lease；部分欄位為 NULL。
- 性質：`[CONFIRMED]`（`OUT-10` + P-4 + P5-OD-01）。
- **RC-1 修正說明**：因 P5-OD-01 讓 Manual Retry 維持 `dead`，本約束**不需**為手動流程放寬；手動 lease 完全不在本表，故不衝突。
- NULL 稽核：`status` 為 NOT NULL，其餘皆 `IS NULL`／`IS NOT NULL` 判斷 → 無三值邏輯漏洞。

### CC-3 `chk_outbox_event_terminal_timestamps`（`outbox_event`）

```sql
CHECK (
  ((status = 'sent') = (sent_at IS NOT NULL))
  AND ((status = 'dead') = (dead_at IS NOT NULL))
)
```
- 不變式：`sent` ⟺ `sent_at`；`dead` ⟺ `dead_at`（並因此互斥）。
- **RC-8 相關**：`dead → sent`（手動 retry 被接受）時必須同時清空 `dead_at`，否則本約束拒絕更新。
- NULL 稽核：`status` NOT NULL → 兩側皆為 0/1，無漏洞。

### CC-4 `chk_outbox_intervention_completion`（`outbox_intervention`）

```sql
CHECK (
  ((intervention_outcome IS NULL) = (completed_at IS NULL))
  AND (intervention_outcome IS NULL OR intervention_outcome IN ('abandoned'))
  AND (completed_at IS NULL OR held_at IS NULL)
)
```
- 不變式：結果與完成時間成對；結果僅 NULL 或 `abandoned`；完成時不得仍 held（MI-5-β）。
- 性質：`[CONFIRMED]`（MI-2、P5-OD-04、MI-5-β、MI-5-ε）。
- NULL 稽核：比較兩側皆為由 `IS NULL` 導出的 0/1；第二項在 `intervention_outcome` 非 NULL 且非 `abandoned` 時為 FALSE → 拒絕。無漏洞。

### CC-5 `chk_outbox_intervention_manual_lease`（`outbox_intervention`）

```sql
CHECK (
  (manual_lease_token IS NULL
     AND manual_lease_expires_at IS NULL
     AND manual_lease_attempt_id IS NULL)
  OR (manual_lease_token IS NOT NULL
     AND manual_lease_expires_at IS NOT NULL
     AND manual_lease_attempt_id IS NOT NULL
     AND completed_at IS NULL
     AND held_at IS NULL)
)
```
- 不變式：Manual Lease 三欄 all-or-none；已完成的介入不得持有 lease；**持有 lease 時不得同時 held**（B-6）。
- 與 P5-OD-05 一致：lease 存在 ⟹ 未完成且未 held ⟹ abandon 與 hold 皆會被 CAS 拒絕。
- **B-6 修正說明**：Rev 2 的 CC-5 只要求 lease 存在時 `completed_at IS NULL`，**未禁止 held + lease 並存**。Rev 3 以 `held_at IS NULL` 補足，在不新增第 7 條 CHECK 的前提下於資料庫層排除該組合。
- NULL 稽核：全部為 `IS NULL`／`IS NOT NULL` 判斷，無漏洞。

### CC-6 `chk_provider_attempt_finalization`（`provider_attempt`）— **RC-4 修正；B-1 再修正**

```sql
CHECK (
  (outcome IS NULL
     AND finalized_at IS NULL
     AND finalized_by IS NULL)
  OR (outcome IS NOT NULL
     AND outcome IN ('provider_accepted','provider_rejected','outcome_unknown')
     AND finalized_at IS NOT NULL
     AND finalized_by IS NOT NULL
     AND finalized_by IN ('phase2','recovery'))
)
```
- 不變式：未最終化時**三欄皆 NULL**；已最終化時**三欄皆非 NULL** 且值域封閉。
- Rev 1 缺陷：第三項 `(finalized_at IS NULL OR finalized_by IN (...))` 允許
  (i) `finalized_by` 非 NULL 而 `finalized_at` 為 NULL；
  (ii) `finalized_at` 非 NULL 而 `finalized_by` 為 NULL（`NULL IN (...)` → NULL → CHECK 通過）。
- Rev 2 修正：改為「全 NULL／全非 NULL」互斥分支。
- **Rev 2 殘餘缺陷（B-1）**：第二分支仍缺 `finalized_by IS NOT NULL`。當 `finalized_by IS NULL` 時，`finalized_by IN ('phase2','recovery')` 求值為 **NULL**，使整個第二分支為 NULL；而第一分支為 FALSE → `FALSE OR NULL = NULL` → **SQLite 視為通過**。因此 `(provider_accepted, 123, NULL)` 在 Rev 2 下會被**錯誤接受**。
- **Rev 3 修正**：加入 `finalized_by IS NOT NULL`，使該情形第二分支求值為 FALSE → 整條 CHECK 為 FALSE → 拒絕。不得依賴 `IN (...)` 的 NULL 結果隱含保證非 NULL。

### 7.1 三值邏輯稽核表（RC-4 要求）

| CHECK | 是否可能因 NULL 而誤通過 | 說明 |
| --- | --- | --- |
| CC-1 | 否 | `status` NOT NULL |
| CC-2 | 否 | 全為 `IS NULL`／`IS NOT NULL` |
| CC-3 | 否 | `status` NOT NULL |
| CC-4 | 否 | 比較式兩側皆為 0/1 |
| CC-5 | 否 | 全為 `IS NULL`／`IS NOT NULL` 判斷（含 B-6 新增的 `held_at IS NULL`） |
| CC-6 | 否（**Rev 3 修正後**） | 全 NULL／全非 NULL 互斥，且三個非 NULL 條件皆**顯式**檢查；Rev 2 曾因 `finalized_by IN (...)` 求值為 NULL 而誤通過 |

### 7.2 未納入六個 CHECK 的不變式

| 不變式 | 強制機制 |
| --- | --- |
| Operation History append-only（禁 UPDATE） | `BEFORE UPDATE` trigger（§6.1） |
| 一 lease 一 attempt | UNIQUE index（§8 #11） |
| 1:1 介入 | PK = `event_id` |
| 狀態轉移合法性 | 條件式 UPDATE（CAS） |
| `manual_lease_attempt_id` 指向存在的 attempt | 應用層驗證（SQLite CHECK 不能跨表；§12 TR-4） |
| D-1 終止化與 alert 的原子性 | 交易（§12.2） |
| `attempts` 0–8 | 應用層（§12 TR-2） |

### 7.3 CC-6 反例驗證表（B-1 要求）

`[INFERENCE]` 以下五組為 B-1 指定的反例；Rev 3 的 CC-6 必須逐案符合預期：

| outcome | finalized_at | finalized_by | 預期 | Rev 3 求值 |
| --- | --- | --- | --- | --- |
| `provider_accepted` | 123 | NULL | **REJECT** | 分支一 FALSE；分支二 `finalized_by IS NOT NULL` FALSE → FALSE → 拒絕 |
| `provider_accepted` | NULL | `phase2` | **REJECT** | 分支一 FALSE；分支二 `finalized_at IS NOT NULL` FALSE → 拒絕 |
| NULL | 123 | `phase2` | **REJECT** | 分支一 `finalized_at IS NULL` FALSE；分支二 `outcome IS NOT NULL` FALSE → 拒絕 |
| `provider_accepted` | 123 | `phase2` | **ACCEPT** | 分支二全為 TRUE → 通過 |
| NULL | NULL | NULL | **ACCEPT** | 分支一全為 TRUE → 通過 |

`[INFERENCE]` 補充反例（Rev 3 一併驗證）：`outcome='bogus', 123, 'phase2'` → 分支二 `outcome IN (...)` FALSE → 拒絕；`outcome='provider_accepted', 123, 'bogus'` → `finalized_by IN (...)` FALSE → 拒絕；`NULL, NULL, 'phase2'` → 分支一 `finalized_by IS NULL` FALSE、分支二 FALSE → 拒絕。

`[CONFIRMED]` 六條 CHECK 的其餘五條皆不以 `IN ([可能為 NULL 的欄位])` 作為唯一非 NULL 保證：CC-1／CC-3 的 `status` 為 NOT NULL；CC-2／CC-5 全為 `IS NULL`／`IS NOT NULL` 判斷；CC-4 的比較式兩側皆為由 `IS NULL` 導出的 0/1。因此 B-1 的三值邏輯問題**僅存在於 CC-6**，已修正。

---

## 8. Index and Uniqueness Matrix

| # | 名稱（提案） | 表 | 定義 | 目的 | 來源 |
| ---: | --- | --- | --- | --- | --- |
| 1 | PK | `outbox_event` | `event_id` | 列身分 | `OUT-1` |
| 2 | `uq_outbox_logical` | `outbox_event` | UNIQUE `(event_type, aggregate_id, notification_key)` | 邏輯去重（D-5／`OUT-19`／`OUT-21`） | `OUT-1` |
| 3 | `ix_outbox_claim` | `outbox_event` | `(status, next_attempt_at)` | 自動 worker 取件 | `OUT-6` |
| 4 | `ix_outbox_dead` | `outbox_event` | `(dead_at)` WHERE `status='dead'` | 待介入／已 dead 事件查找 | `OUT-25` |
| 5 | `uq_outbox_lease_token` | `outbox_event` | UNIQUE `(lease_token)` WHERE `lease_token IS NOT NULL` | 一自動權杖一持有者 | v5 先例 |
| 6 | PK | `outbox_intervention` | `event_id` | 1:1 保證 | MI-1 |
| 7 | `uq_intervention_lease` | `outbox_intervention` | UNIQUE `(manual_lease_token)` WHERE `manual_lease_token IS NOT NULL` | 一 Manual Lease 一介入 | OD-1 |
| 8 | `ix_intervention_held` | `outbox_intervention` | `(held_at)` WHERE `held_at IS NOT NULL` | hold 查找 | MI-4 |
| 9 | `ix_intervention_expiry` | `outbox_intervention` | `(manual_lease_expires_at)` WHERE `manual_lease_token IS NOT NULL` | Recovery 選取過期 lease（**驅動索引**） | OD-1 |
| 10 | PK | `provider_attempt` | `attempt_id` | attempt 身分 | OD-2 |
| 11 | `uq_attempt_lease` | `provider_attempt` | UNIQUE `(lease_token)` | 一 lease 一 attempt（Recovery 冪等的結構基礎） | OD-1、OD-3 |
| 12 | `ix_attempt_event` | `provider_attempt` | `(event_id)` | 依事件查詢 | OD-2 |
| 13 | `ix_attempt_marker` | `provider_attempt` | `(marker_at)` WHERE `marker_at IS NOT NULL` | OD-A 計數 | OD-A |
| 14 | PK | `outbox_operation_history` | `operation_id` | 全域唯一 | MI-6e |
| 15 | `ix_history_event` | `outbox_operation_history` | `(event_id, created_at)` | 依事件查詢（soft reference 下仍必要） | MI-7、P5-OD-02 |

`[INFERENCE]` **NULL 與唯一性**：SQLite 唯一索引中 NULL 互不相等，故 token 類欄位必須使用部分索引（`WHERE … IS NOT NULL`）。`notification_key` 為 NOT NULL，#2 不受影響。

`[INFERENCE]` **Exhausted Alert 身分**（D-5）由 #2 承載：`(alert, aggregate_id, exhausted:v<n>)` → 同 lifecycle 同版本至多一列。

`[OPEN]` Correction 的 `notification_key` 編碼（`SPEC-GAP-17`）未定 → #2 對 correction 的去重正確性未驗證。

`[OPEN]` 是否需為「未完成介入」增加 `(completed_at) WHERE completed_at IS NULL` 索引，取決於 cleanup 查詢形態（`OUT-15` 未決）。

---

## 9. Foreign-Key and Retention Design

| 關係 | 決定 | 理由 | 後果 |
| --- | --- | --- | --- |
| `outbox_event` → Article Lifecycle | **soft reference（無 FK）** | P-2、`OUT-18`、`OUT-25` | 事件在 lifecycle 刪除後存活；孤兒 `aggregate_id` 屬預期 |
| `outbox_intervention` → `outbox_event` | **FK `ON DELETE RESTRICT`** | P5-OD-03 | 介入存在時事件不可刪 |
| `provider_attempt` → `outbox_event` | **FK `ON DELETE RESTRICT`** | P5-OD-03 | attempt 存在時事件不可刪 |
| `outbox_operation_history` → `outbox_event` | **soft reference（無 FK）** | P5-OD-02 | history 可長於事件；事件刪除不影響 history |

`[CONFIRMED]` `PRAGMA foreign_keys = ON`（`sqlite.ts:337`）→ RESTRICT 會實際生效。

`[CONFIRMED]` **刪除語意總結**：事件可否刪除取決於 intervention 與 attempt 是否仍存在；history 不阻擋刪除，但自身刪除須依 retention 政策。

`[CONFIRMED]` **RC-6 已解**：append-only 僅禁 UPDATE；DELETE 由 `OUT-16` 政策決定。Rev 1 的「history FK RESTRICT → 事件永久不可刪」張力**已由 P5-OD-02 消除**。

`[OPEN]` `OUT-14`／`OUT-15`／`OUT-16` 未決 → **物理刪除在政策確定前一律阻塞**。

---

## 10. Transaction Matrix（RC-2／RC-5／RC-7／RC-8 已修正）

`[CONFIRMED]` HTTP 一律在交易外；Phase 1／Marker／Phase 2 為三個獨立交易（OD-3）；任一必要更新列數不符即整筆回滾（OD-1）。

`[CONFIRMED]` 本矩陣共 **14 項操作**。Rev 1 的「自動失敗」與「自動重排」原為兩列，實為同一個 `UPDATE`，Rev 2 已合併為 #4；自動投遞的狀態轉移因此為 `leased→pending`（#4）與 `leased→dead`（#5）兩種，涵蓋完整。

`[CONFIRMED]` **B-2／B-3 讀法**：#10／#12／#13 的完整跨表身分驗證見 **§10.1**（八條件）；#12 的三種 Provider 結果 SET 分支見 **§10.2**。所有涉及 `outbox_intervention` 的列（#6～#13）在 B-3 未定案前均假設「該列已存在」，屬**條件式設計**（§4.1、§12.5）。

| # | 操作 | 觸及表 | CAS 條件 | 期望列數 | SET 摘要 | 回滾 | HTTP | 冪等鍵 | history |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 建立事件 | event | 無（INSERT） | 1 | 全部 18 欄；`status='pending'`；lease 三欄 NULL | 全回滾 | 否 | `event_id` | 否 |
| 2 | 自動 claim | event | `status='pending' AND attempts<8 AND next_attempt_at<=now` | 1 | `status='leased'`, `attempts=attempts+1`, `lease_owner/token/expires_at` 填入 | 全回滾 | 否 | — | 否 |
| 3 | 自動成功 | event | `status='leased' AND lease_token=?` | 1 | `status='sent'`, `sent_at=?`, `dead_at=NULL`, **lease 三欄 = NULL** | 全回滾 | 否（已在外完成） | — | 否 |
| 4 | 自動失敗／重排 | event | `status='leased' AND lease_token=?` | 1 | `status='pending'`, `next_attempt_at=?`, `last_error_*=?`, **lease 三欄 = NULL** | 全回滾 | 否 | — | 否 |
| 5 | 自動耗盡 → `dead` | event | `status='leased' AND lease_token=? AND attempts>=8` | 1 | `status='dead'`, `dead_at=?`, **lease 三欄 = NULL** | 全回滾 | 否 | — | 否 |
| 6 | Hold | intervention（event 僅讀） | 子查詢 `event.status='dead'` **AND** `completed_at IS NULL` **AND** `held_at IS NULL` **AND** `manual_lease_token IS NULL`（B-6：不得 hold 有有效 lease 的介入） | 1（intervention）＋1（history） | `held_at=?`, `updated_at=?`；**不更新 event** | 全回滾 | 否 | `operation_id` | **是** |
| 7 | Release | intervention | `held_at IS NOT NULL AND completed_at IS NULL` | 1＋1 | `held_at=NULL`, `updated_at=?` | 全回滾 | 否 | `operation_id` | **是** |
| 8 | Abandon | intervention（event 僅讀） | 子查詢 `event.status='dead'` **AND** `completed_at IS NULL` **AND** `manual_lease_token IS NULL` | 1＋1 | `held_at=NULL`, `intervention_outcome='abandoned'`, `completed_at=?`, `updated_at=?`；**不改 event.status** | 全回滾 | 否 | `operation_id` | **是** |
| 9 | Retry Phase 1 | intervention＋attempt＋history（event 僅讀） | 子查詢 `event.status='dead'` **AND** `held_at IS NULL AND completed_at IS NULL AND manual_lease_token IS NULL` | 1＋1＋1 | intervention：`manual_lease_token/expires_at/attempt_id` 填入；attempt：INSERT；**不更新 event** | 全回滾 | 否 | `operation_id` | **是** |
| 10 | Marker | attempt（intervention／event 僅讀） | **§10.1 全部八條件** + `attempt.marker_at IS NULL` + `manual_lease_expires_at >= now` | 1 | `marker_at=?` | 0 列 → **不呼叫 HTTP**（OD-3） | 否 | `operation_id` | 否 |
| 11 | Provider HTTP | 無 | — | — | — | — | **是** | — | 否 |
| 12 | Phase 2 | event＋intervention＋attempt | **§10.1 全部八條件**（時間邊界 `manual_lease_expires_at >= now`） | **1＋1＋1** | 三分支見 **§10.2** | 任一 0 列 → **全回滾** | 否（已在外完成） | `operation_id` | 否 |
| 13 | Recovery | intervention＋attempt（event 僅讀） | **§10.1 條件 1–3、4、6、8**（時間邊界改為 `manual_lease_expires_at < now`；因 lease 存在，條件 7 由 CC-5 保證） | **1＋1** | intervention：**lease 三欄 = NULL**；attempt：`outcome='outcome_unknown'`, `finalized_at=?`, `finalized_by='recovery'`；**event 維持 `dead`，不更新** | 任一 0 列 → **全回滾** | 否 | — | 否 |
| 14 | 耗盡 job 終止化＋alert | processing_job＋event | job：`state='running' AND attempts>=3 AND terminal_reason IS NULL`；alert：唯一鍵 | 1＋1 | job → `terminal`；event → INSERT alert | 全回滾（D-1） | 否 | — | 否 |

`[CONFIRMED]` **#8 Abandon（RC-3 修正）**：移除 Rev 1 的恆真項 `(held_at IS NOT NULL OR held_at IS NULL)`；加入 `event.status='dead'` 與 `manual_lease_token IS NULL`（P5-OD-05）；同 UPDATE 清除 `held_at`，以避免 CC-5 因「lease 存在 + completed_at 非 NULL」而拒絕。

`[CONFIRMED]` **#9 Phase 1（RC-5 修正）**：只讀取 event 驗證 `status='dead'`，**不更新** event；因此 event 不在期望列數內。

`[CONFIRMED]` **#12 Phase 2（RC-2／RC-8 修正）**：三表同交易。accepted 時 `dead → sent` 必須清 `dead_at`（CC-3）；三表任一 0 列即全回滾。

`[CONFIRMED]` **#13 Recovery（RC-2 修正）**：清除 intervention lease + 最終化 attempt；event 維持 `dead` 且不更新（故為 1＋1）。

`[OPEN]` **Recovery 的 liveness**：若 Recovery 從未執行，過期 lease 的 token 仍存在 → 既不能 retry（#9 要求 token NULL）也不能 abandon（#8 要求 token NULL）→ 事件停滯。此為營運層風險，依賴 D-3 的 Recovery 排程保證。**不是**設計矛盾，但必須在營運文件中明示。

`[INFERENCE]` **#6 Hold**：不更新 event（RC-7）；以子查詢驗證 `status='dead'`。因 `dead` 事件不會被自動 claim，故不需在 claim 謂詞加 JOIN。

`[INFERENCE]` **#14**：見 §12.2 的 Transaction Owner 規範（RC-10）。

### 10.1 跨表身分驗證八條件（B-2）

`[CONFIRMED]` Marker（#10）、Phase 2（#12）與 Recovery（#13）**必須**逐項驗證下列八個條件；任一不成立即 0 列 → 整筆交易 rollback。**不得**以 `provider_attempt.UNIQUE(lease_token)` 取代跨表身分驗證（唯一鍵只保證「一 lease 一 attempt」，不保證 attempt 屬於該 event、或該 intervention 正持有它）。

| # | 條件 | 驗證方式 | Marker | Phase 2 | Recovery |
| ---: | --- | --- | --- | --- | --- |
| 1 | Attempt 的 `event_id` 與目標事件相同 | 三表關聯條件（同一 `event_id`） | 必須 | 必須 | 必須 |
| 2 | `outbox_intervention.manual_lease_attempt_id` = 目標 `attempt_id` | intervention 謂詞 | 必須 | 必須 | 必須 |
| 3 | `outbox_intervention.manual_lease_token` = `provider_attempt.lease_token` | 跨表等值 | 必須 | 必須 | 必須 |
| 4 | Attempt 尚未 finalize（`outcome IS NULL`） | attempt 謂詞 | 必須（另加 `marker_at IS NULL`） | 必須 | 必須 |
| 5 | Event 仍為 `dead` | event 子查詢 | 必須 | 必須 | **僅驗證**（不得改為 `sent`／`pending`） |
| 6 | Intervention 尚未完成（`completed_at IS NULL`） | intervention 謂詞 | 必須 | 必須 | 必須 |
| 7 | Intervention 不處於 held（`held_at IS NULL`） | intervention 謂詞；另由 CC-5 保證「lease 存在時不得 held」 | 必須 | 必須 | 由 CC-5 保證 |
| 8 | Lease 期限符合該操作的時間邊界 | `manual_lease_expires_at >= now`（Marker／Phase 2）／`< now`（Recovery） | `>= now` | `>= now` | `< now` |

`[CONFIRMED]` **交易外框**（三者相同）：

1. `BEGIN IMMEDIATE`；
2. 取得權威 `now`（**必須**在取得寫鎖之後，不得在等待鎖之前取得）；
3. 以 §10.1 條件 + 各操作專屬謂詞執行條件式更新；
4. 檢查每一必要更新的 affected-row count 是否等於預期值；
5. 全部相符 → `COMMIT`；任一不符 → `ROLLBACK`（**不得**部分提交）。

`[ODR]` **OPEN**：條件 2／3 的跨表比較需要 `provider_attempt`、`outbox_intervention`、`outbox_event` 三表在同一交易的同一查詢上下文；此與 §12.2 的 Transaction Owner 要求一致，但落地方式未定。

### 10.2 Phase 2 三分支 SET 定義（B-4）

`[CONFIRMED]` Phase 2 必須依 Provider 結果分三支；三支皆在同一交易內更新 **event ＋ intervention ＋ attempt**（期望 `1＋1＋1`），且皆須通過 CC-3。

| Provider 結果 | `outbox_event` SET | `outbox_intervention` SET | `provider_attempt` SET |
| --- | --- | --- | --- |
| `provider_accepted` | `status='sent'`, `sent_at=<provider 接受時間>`, `dead_at=NULL`, `updated_at=?` | `manual_lease_token=NULL`, `manual_lease_expires_at=NULL`, `manual_lease_attempt_id=NULL`, `updated_at=?` | `outcome='provider_accepted'`, `finalized_at=?`, `finalized_by='phase2'` |
| `provider_rejected` | `status='dead'`（不變）, `sent_at` 保持 NULL, `dead_at` 保留既有值, `updated_at=?` | 同左（清 lease 三欄） | `outcome='provider_rejected'`, `finalized_at=?`, `finalized_by='phase2'` |
| `outcome_unknown` | `status='dead'`（不變）, `sent_at` 保持 NULL, `dead_at` 保留既有值, `updated_at=?` | 同左（清 lease 三欄） | `outcome='outcome_unknown'`, `finalized_at=?`, `finalized_by='phase2'` |

`[PROPOSED]` **`dead_at` 語意**：`dead` 事件必已具備 `dead_at`（CC-3）。Phase 2 的 rejected／unknown 分支**保留**該值，因為它記錄的是「自動投遞流程結束」的時點；僅當其為 NULL（不應發生的資料異常）時，才於本次交易設為 `now`。此為提案，未經核准。

`[INFERENCE]` **CC-3 一致性檢查**：accepted 分支必須**同時**寫 `status='sent'` 與 `sent_at IS NOT NULL` 並清 `dead_at`，否則 CC-3 的 `(status='sent') = (sent_at IS NOT NULL)` 與 `(status='dead') = (dead_at IS NOT NULL)` 會使 UPDATE 被拒；rejected／unknown 分支保持 `dead` 時 `dead_at` 必須仍非 NULL。

`[CONFIRMED]` 本節**不改變** OD-1 的 fencing 政策（過期後 Phase 2 不得寫入）；三支皆須先通過 §10.1 條件 8 的 `>= now`。

---

## 11. State Transition Matrices

### 11.1 Delivery Status（`outbox_event.status`）

| From | To | 觸發 | 允許？ | 依據 |
| --- | --- | --- | --- | --- |
| （無） | `pending` | 事件建立 | 是 | `OUT-1` |
| `pending` | `leased` | 自動 claim | 是 | `OUT-6` |
| `leased` | `pending` | 自動失敗／重排 | 是 | `OUT-7` |
| `leased` | `sent` | provider 接受 | 是 | `OUT-3` |
| `leased` | `dead` | 第 8 次失敗 | 是 | `OUT-8` |
| `dead` | `dead` | **Manual Retry Phase 1**（狀態不變） | 是 | **P5-OD-01** |
| `dead` | `sent` | **Manual Retry 被接受**（Phase 2） | 是 | P5-OD-01、`OUT-3` |
| `dead` | `pending` | **禁止** | 否 | 會落入自動預算（MI-3） |
| `dead` | `leased` | **禁止** | 否 | `leased` 專屬自動投遞（P5-OD-01） |
| `sent` | 任何 | **禁止**（終態） | 否 | `OUT-3` |
| 任何 | `abandoned` | **禁止** | 否 | P-4、P5-OD-04 |

`[CONFIRMED]` **SI-1 修正**：Rev 1 曾將 `dead → leased` 標為「MI-3」。MI-3 從未規定目標狀態；該轉移現已由 P5-OD-01 明確**禁止**。

### 11.2 Intervention

| 狀態 | 表示 | 可執行 |
| --- | --- | --- |
| 未開始 | 無列 | Retry／Hold／Abandon（需 `event.status='dead'`） |
| 未完成、未 held、無 lease | `held_at` NULL、`completed_at` NULL、`manual_lease_token` NULL | Retry／Hold／Abandon |
| 未完成、未 held、**lease 中** | `manual_lease_token` 非 NULL | **僅** Marker／Phase 2／Recovery；Retry／Hold／Abandon 皆 Conflict（P5-OD-05） |
| held | `held_at` 非 NULL、`completed_at` NULL | Release／Abandon（**不得** Retry） |
| 已完成 | `intervention_outcome='abandoned'`、`completed_at` 非 NULL | **無**（終態） |

`[CONFIRMED]` **`sent` 事件的介入永不完成**：手動 retry 被接受後 event 為 `sent`，但介入仍 `completed_at IS NULL`（MI-6a：只有 abandon 完成介入）。此後 Hold／Abandon 皆因 `event.status='dead'` 不成立而不可執行。cleanup 對 `sent` 事件走 **delivery 條件**（`OUT-25`），不要求介入完成。

`[CONFIRMED]` **不存在**「已 release」的獨立狀態：release 清 `held_at` → 回到「未完成、未 held」。

`[CONFIRMED]` **held 與有效 lease 互斥（B-6）**：Rev 2 的狀態表允許「held 且 lease 中」這兩列並存，但未說明其合法性。Rev 3 明確：**該組合不可存在**。CC-5 的 lease 分支已含 `held_at IS NULL`，資料庫層即會拒絕；Hold 的 CAS（§10 #6）亦要求 `manual_lease_token IS NULL`。因此上表的「held」與「lease 中」為**互斥狀態**，不存在重疊列。此與 P5-OD-05 一致：有效 lease 存在時不得 abandon；而 hold 亦須等 lease 結束（Phase 2 完成或 Recovery 清除）後才可施加。

### 11.3 Provider Attempt

| 狀態 | `marker_at` | `outcome` | `finalized_by` | 可轉移至 |
| --- | --- | --- | --- | --- |
| 已建立 | NULL | NULL | NULL | Marker 或 Recovery |
| Marker 已提交 | 非 NULL | NULL | NULL | Phase 2 或 Recovery |
| `provider_accepted` | 非 NULL | 值 | `phase2` | **終態** |
| `provider_rejected` | 非 NULL | 值 | `phase2` | **終態** |
| `outcome_unknown`（Phase 2 判定） | 非 NULL | 值 | `phase2` | **終態** |
| `outcome_unknown`（Recovery 判定） | **可能 NULL** | 值 | `recovery` | **終態** |

`[INFERENCE]` `outcome_unknown` 有兩種來源 → 因此**不能**作為計數依據（OD-A）；計數只看 `marker_at`。

#### 11.3.1 Marker 前後 Recovery 的語意差異（B-5）

`[CONFIRMED]` OD-3 規定：Marker 交易在 Provider HTTP **之前**持久化；Marker 交易 0 列時**不得**呼叫 Provider。因此：

| 情形 | `marker_at` | 依 OD-3／OD-A 的推論 | Recovery 目前寫入的值 |
| --- | --- | --- | --- |
| 崩潰發生在 Marker 之前（含 Marker 交易失敗） | NULL | Provider **不應**已被呼叫；此 retry **不計數**（OD-A） | `outcome_unknown` |
| 崩潰發生在 Marker 之後（含 HTTP 進行中、回應遺失） | 非 NULL | Provider **可能**已被呼叫，結果不可確認；此 retry **計數** | `outcome_unknown` |

`[ODR]` **OPEN — REQUIRES OWNER DECISION（B-5）**：MI-3c 只定義三種 Provider outcome，沒有第四種可表達「依設計確定未曾呼叫」。因此 Recovery 對上述兩種情形**都**寫入 `outcome_unknown`，這在語意上並不完全精確：

- 對 `marker_at IS NULL` 的 attempt 寫 `outcome_unknown`，等於把「確定未曾呼叫」與「可能已呼叫但結果不明」混為一談；
- 但 MI-3c 沒有更精確的值，且 OD-A 的計數**不依賴** `outcome`（只看 `marker_at`），所以**計數正確性不受影響**；受影響的只有 attempt 結果的語意精度。

`[CONFIRMED]` 本文件**不新增第四種 outcome、不改 MI-3c、不改 OD-A 的計數規則**。候選方案與影響見 **§12.6**，**未選擇**。

`[TO]` 實務後果：若未來要以「是否真的送出」做報表或爭議處理，`outcome_unknown` + `marker_at IS NULL` 的組合必須被解釋為「幾乎確定未送出」，而 `outcome_unknown` + `marker_at IS NOT NULL` 才是「可能已送出」。此判讀規則目前僅存在於本文件，尚未成為 Owner 決策。

### 11.4 Manual Lease

| 狀態 | 表示 | 可轉移至 | Abandon 可否 |
| --- | --- | --- | --- |
| 已取得 | token 非 NULL、`expires>=now` | Marker／Phase 2／過期 | **否**（P5-OD-05） |
| Marker 已提交 | token 非 NULL + `attempt.marker_at` 非 NULL | Phase 2／過期 | **否** |
| 已過期、未回收 | `expires<now`、token 仍非 NULL | Recovery（清除） | **否**（不得假設已清除，P5-OD-05） |
| 已清除 | token 為 NULL | 終止 | 是（其他前置成立時） |

`[CONFIRMED]` **lease 過期 ≠ 介入完成**：過期只導致 `outcome_unknown` 與 `dead`，介入仍為未完成（MI-6a）。

---

## 12. Unresolved Requirements and Owner Decisions

### 12.1 狀態分類（RC-9 修正）

| 類別 | 項目 |
| --- | --- |
| **已由 Owner Decision 解決** | C-1 → P5-OD-02；C-2 → P5-OD-04；C-3 → P5-OD-03；manual retry 狀態表示 → P5-OD-01；retry 中 abandon → P5-OD-05；**C-4（payload schema）→ Owner 2026-11-28 凍結（§3.2）** |
| **已完成文件修訂（待審查）** | B-1（CC-6 三值邏輯，§7、§7.3）；B-2（跨表身分驗證八條件，§10.1）；B-4（Phase 2 三分支 SET，§10.2）；B-6（Hold／lease 互斥，§7 CC-5、§10 #6、§11.2）；SI-1／SI-2（Rev 2 已修正，Rev 3 複核無殘留） |
| **仍需 Owner Decision** | **B-3**（Intervention row 建立時機，§4.1、§12.5）；**B-5**（Marker 未提交時的 Recovery outcome 語意，§11.3.1、§12.6）；C-5（`SPEC-GAP-10`）、C-6（`SPEC-GAP-17`）、C-7（`SPEC-GAP-05`）、C-8（`OUT-14`–`OUT-16`） |
| **仍需技術驗證** | §10.1 的跨表等價條件能否在同一交易上下文表達；CC-6 修正後於實際 SQLite 的行為；`dead_at` 語意（§10.2）；時間表示一致性 |
| **尚未完成的技術設計** | Transaction Owner 的落地方式（§12.2）；`manual_lease_attempt_id` 的參照驗證；`next_attempt_at` sentinel；`attempts` 0–8 強制；`result_state` replay |
| **Implementation Blocker** | **RC-10**（§12.2）；B-3 未決使所有介入流程為條件式設計；`SPEC-GAP-10` 使 Phase 2 無法實作 |
| **尚未達 Implementation Readiness** | 見 §13 |

`[CONFIRMED]` **Rev 1 錯誤更正**：「C-1 是唯一影響結構的未決政策」不成立。C-1／C-2／C-3 已由 P5-OD-02／04／03 解決；目前影響結構的未決項為 **C-8（retention 決定 FK 是否可放行刪除）** 與 **DB abstraction（§12.2）**。

### 12.2 Transaction Owner 規範（RC-10）

`[CONFIRMED]` **設計規範**（不授權修改程式碼）：

1. 所有跨表、多 repository 的原子操作**必須**有單一 **Transaction Owner**。
2. Transaction Owner 負責 `BEGIN IMMEDIATE`、`COMMIT`、`ROLLBACK`。
3. 參與的 repository 必須共用**同一個 transaction-scoped database connection / query context**。
4. **不得**在既有交易內重複啟動巢狀交易。
5. 若現有 DB abstraction 無法支援此組合，**必須列為實作阻擋項目**，不得假設已具備能力。

`[REPO]` **現況查證**：`SqliteQueryable = Pick<SqliteDatabase,'query'>`（`sqlite-processing-job.repository.ts:18`）；`immediate()` 為 `private`（`:85-104`）；`transaction()` 具巢狀守衛（`sqlite.ts:363-367`），而 `immediate()` 以 raw `BEGIN IMMEDIATE` 繞過該旗標 → **兩機制不可組合**。

`[OPEN]` **實作阻擋項目（RC-10）**：D-1 的 #14 需同時寫 `processing_job`（processing repository）與 `outbox_event`（outbox repository）。以現行抽象，**無法**由兩個 repository 共同參與同一交易。可行方向（皆未核准）：

- (a) 將 exhaustion 流程實作於**單一** repository（同時擁有兩表）；
- (b) 引入顯式的 transaction context 供多 repository 共享；
- (c) 讓 processing repository 接受一個 outbox 寫入 callback。

`[CONFIRMED]` 在 (a)(b)(c) 任一被核准前，**#14 不得實作**；D-1 的原子性要求因此成為**實作阻擋**，而非設計遺漏。

### 12.3 技術建議（非 Owner Decision）

| # | 項目 | 建議 |
| --- | --- | --- |
| B-1 | `processing_version` 可空性 | NOT NULL（三種已知事件型別皆綁版本）；若出現版本無關事件型別需重新檢視 |
| B-2 | Hold 是否更新 `outbox_event` | **否**；以子查詢驗證 `status='dead'`（§10 #6） |
| B-3 | `attempt_id` 形式 | surrogate UUIDv4 + `UNIQUE(lease_token)` |
| B-4 | `provider_attempt` 是否含自動嘗試 | **否**，僅手動 |
| B-5 | 時間表示 | 沿用 v5 混用（TEXT 稽核／INTEGER 時序） |
| B-6 | append-only 強制 | `BEFORE UPDATE` trigger；**不**阻擋 DELETE（§6.1） |

`[CONFIRMED]` B-1～B-6 為技術建議，**不是** Owner Decision。

### 12.4 仍 OPEN 的 Owner 項目

| # | 問題 | 對本文件的影響 |
| --- | --- | --- |
| ~~C-4~~ | ~~`OUT-11` payload 結構~~ — **RESOLVED**（Owner, 2026-11-28；見 §3.2，已實作） | 已凍結，不再影響本文件 |
| C-5 | `SPEC-GAP-10` provider 通道與能力 | 阻擋 Phase 2 實作，不阻擋 schema |
| C-6 | `SPEC-GAP-17` correction key | 阻擋 correction 事件建立與其去重驗證 |
| C-7 | `SPEC-GAP-05` 版本域 | 阻擋 `exhausted:v<n>` 的合法性驗證 |
| C-8 | `OUT-14`／`OUT-15`／`OUT-16` 保留與清理 | 阻擋任何 DELETE 實作；決定 intervention／attempt FK 是否可放行 |

### 12.5 B-3：Intervention 資料列建立策略 — `OPEN — REQUIRES OWNER DECISION`

`[ODR]` **問題**：`outbox_intervention` 的列應在何時建立？

| 面向 | 方案 A：建立 Event 時同交易建立 | 方案 B：首次 Hold／Abandon／Retry 時原子確保存在 |
| --- | --- | --- |
| Event 建立交易 | 需同時 INSERT 兩表（`1＋1` 列）；交易較重 | 維持單表 INSERT（`1` 列） |
| 1:1 關聯 | 天然成立：每個 event 必有 1 列 | 僅在首次介入操作後才成立；期間為「0 或 1」 |
| FK RESTRICT（P5-OD-03） | 一致：介入列自始存在，事件自始不可刪 | 一致但延後生效：事件在首次介入前仍可被刪 |
| Transaction Matrix（§10 #6～#13） | 現行假設成立（列已存在），期望列數不變 | 每列需先「確保存在」再 UPDATE；期望列數與步驟增加 |
| Idempotency（MI-8） | 簡單：操作只做 UPDATE | 需冪等的 ensure-exists（`INSERT … WHERE NOT EXISTS` 或 `ON CONFLICT DO NOTHING`），且不得吞掉其他約束錯誤 |
| Recovery | 無影響 | 無影響（lease 欄位只在介入開始後才有值） |
| Retention（C-8） | 可能產生大量「從未介入」的空列，增加清理對象 | 只為真正需要介入的事件建立列，資料量較小 |
| 額外風險 | 事件建立路徑增加失敗面（兩表同交易） | 併發首次操作需正確處理 ensure-exists 的競爭 |

`[PROPOSED]` **技術傾向（不代選）**：方案 B 的資料量與「無介入即無列」語意較乾淨，但需一個正確的冪等 ensure-exists；方案 A 的流程較單純但會產生空列。兩者皆可行，選擇屬政策（是否允許「事件存在而介入不存在」）。

`[CONFIRMED]` **在 Owner 決定前**：§10 #6～#13 一律視為**條件式設計**；本文件**不得**被引用為已定案；相關 readiness 不得標為 `READY`。

### 12.6 B-5：Marker 未提交時的 Recovery outcome 語意 — `OPEN — REQUIRES OWNER DECISION`

`[ODR]` **問題**：`marker_at IS NULL` 的過期 attempt，Recovery 應寫入什麼結果？MI-3c 只有三種 outcome，沒有「依設計確定未呼叫」的表達。

| 選項 | 內容 | 影響 | 是否需修改已確認政策 |
| --- | --- | --- | --- |
| **(a) 維持現狀** | 兩種情形都寫 `outcome_unknown`，以 `marker_at` 是否為 NULL 作為判讀依據 | 不新增欄位、不改 MI-3c；語意精度不足，需在營運文件解釋 | 否 |
| **(b) 維持現狀 + 成文判讀規則** | 同 (a)，但把「`outcome_unknown` + `marker_at IS NULL` ＝ 幾乎確定未送出」寫成正式規則 | 與 (a) 相同，但消除解釋歧義 | 否（僅需 Owner 認可判讀規則） |
| **(c) 擴充 MI-3c** | 新增第四種 outcome（例如 `not_invoked`） | 可精確表達；但**修改已確認的 MI-3c**，且牽動 CC-6 值域與 §11.3 狀態機 | **是**（必須由 Owner 修訂 MI-3c） |
| **(d) 不 finalize** | Marker 未提交者保留 `outcome IS NULL` | 與「attempt 必須可最終化」及 Recovery 清除 lease 的模型衝突；會使 attempt 永遠停在未完成，無法區分「仍在飛行」 | 是（且不建議） |

`[PROPOSED]` **技術傾向（不代選）**：(a) 或 (b)。理由：OD-A 的計數只看 `marker_at`，正確性不受影響；(c) 雖精確但需修改已確認政策，成本高於收益。

`[CONFIRMED]` 本文件**未**新增第四種 outcome、**未**修改 MI-3c、**未**修改 OD-A 的計數規則。

---

## 13. Readiness Assessment

| 範圍 | 評級 | 依據 |
| --- | --- | --- |
| 18-field Envelope | **`CONDITIONALLY READY`** | 18 欄符合 `OUT-1`；`leased` 語意已由 P5-OD-01 釐清；仍待 `next_attempt_at` sentinel（TR-3）與 `attempts` 範圍強制（TR-2） |
| Six CHECK Constraints | **`READY`（設計層）** | 六條已定義；CC-6 的 Rev 2 殘餘漏洞已於 Rev 3 修正並以五組反例驗證（§7.3）；CC-5 已於 Rev 3 加入 hold/lease 互斥（B-6）；六條皆通過三值複核 |
| Intervention Schema | **`CONDITIONALLY READY`** | 欄位與 P5-OD-04／05 一致；**B-3（列建立時機）未決** → 表的「恆存在」假設不成立；`held_at` 命名仍為示例 |
| Provider Attempt Schema | **`CONDITIONALLY READY`** | 生命週期、`UNIQUE(lease_token)`、八條件驗證（§10.1）已定義；`attempt_id` 形式與 B-5 的結果語意待定 |
| Operation History Schema | **`CONDITIONALLY READY`** | soft reference（P5-OD-02）已定；`result_state` 表達力（TR-5）與 DELETE 政策（C-8）未定 |
| Index / UNIQUE / FK | **`CONDITIONALLY READY`** | 15 項定義正確；FK 已由 P5-OD-02／03 定案；仍缺 `attempts` 與摘要長度的替代強制；`manual_lease_attempt_id` 無 DB 層參照 |
| Transaction Composition | **`CONDITIONALLY READY`** | 14 項操作已補三表與 SET（RC-2／RC-5／RC-7／RC-8），並新增 §10.1 八條件與 §10.2 三分支（B-2／B-4）；**B-3 未決使 #6～#13 為條件式**；**#14 受 RC-10 阻擋** |
| State Transition Model | **`CONDITIONALLY READY`** | 四組矩陣自洽；hold/lease 互斥已明文（B-6）；`dead→sent` 已明列；但 attempt 的 marker-absent 結果語意（B-5）尚未定案 |
| **Payload Schema（§3.2）** | **`IMPLEMENTED`（MVP）** | Owner 凍結並已實作：三型結構、header 驗證、UTF-8 逐欄上限、64 KiB 上限、不可變與 retry 重用；`failure_category`／`terminal_reason` 值域與 `SPEC-GAP-17`／`SPEC-GAP-10` 仍 `OPEN` |
| **Full P-5 Design** | **`NOT READY`** | **B-3**（結構性：決定 1:1 恆存在性與全部介入交易）、**B-5**（語意）、**RC-10**（實作阻擋）三者未解；另有 C-5～C-8 |
| **Implementation Readiness** | **`NOT READY`** | 上述加上 `SPEC-GAP-10`、retention 與 DB abstraction（payload 已實作，但不構成其他區塊可實作的依據） |

`[CONFIRMED]` **評級原則**：文字補充**不等於**技術問題已通過。Rev 3 完成的是「文件修訂」；B-1／B-2／B-4／B-6 屬**已完成修訂、待審查**，仍須經實作階段的技術驗證（例如 §10.1 的跨表等價條件能否在同一交易上下文表達）。

`[CONFIRMED]` 本文件狀態維持 **`PROPOSED — NOT APPROVED`**。完成修訂**不等於**通過審查，亦不等於可實作。

---

## 14. No Implementation Authorization

`[CONFIRMED]` 本文件**不授予**任何實作授權：不授權建表、migration、repository、CLI、worker、recovery、測試或任何程式碼變更；不授權任何 SQL 或資料庫操作；不授權任何保留或刪除政策；不授權修改 DB abstraction。

`[CONFIRMED]` 所有 DDL 與索引定義均為**非規範性示意**，不得直接作為 migration 使用。

`[CONFIRMED — OWNER 2026-11-28]` **唯一例外：§3.2 Payload Schema。** Owner 已就 payload 作出凍結決策並授權其 MVP 實作，因此 §3.2 及其明列的實作落點（`src/modules/outbox/payload.*`）不受本節禁止。該例外**不擴張**到 payload 以外的任何事項：Outbox 表、欄位、migration、intervention、attempt、history、worker、recovery 仍不在授權範圍內。

---

## 15. Revision History

| 日期 | 版次 | 變更 |
| --- | --- | --- |
| 2026-11-27 | Rev 1 | 建立 P-5 完整 schema 設計提案：18 欄 envelope（全數 `[PROPOSED]`）、`outbox_intervention`、`provider_attempt`、append-only history、6 條 CHECK、15 項索引、FK 與保留分析、15 項交易矩陣、4 組狀態矩陣、8 項未決（C-1..C-8）、8 項 readiness。 |
| 2026-11-27 | Rev 2 | 納入 P5-OD-01～05；修正 RC-1（Manual Retry 維持 `dead`，CC-2 不放寬）、RC-2（Phase 2／Recovery 補 `outbox_intervention`，期望列數改 1＋1＋1／1＋1）、RC-3（Abandon 移除恆真項、加入 `status='dead'` 與 `manual_lease_token IS NULL`、同交易清 hold）、RC-4（CC-6 改寫為「全 NULL／全非 NULL」互斥並加三值稽核表）、RC-5（Phase 1 不更新 event）、RC-6（append-only 僅禁 UPDATE，trigger 不阻擋 DELETE）、RC-7（Hold 不更新 event、期望列數 1）、RC-8（所有離開 `leased` 的轉移明列清除三欄；`dead→sent` 須清 `dead_at`）、RC-9（改寫狀態分類，撤回「C-1 唯一影響結構」）、RC-10（新增 Transaction Owner 規範並列為實作阻擋）。新增 `dead→sent` 轉移與 `sent` 事件介入永不完結的說明；交易矩陣由 15 列整併為 14 項（「自動失敗」與「自動重排」為同一 UPDATE）。狀態維持 `PROPOSED — NOT APPROVED`。 |
| 2026-11-27 | Rev 3 | 依第二輪審查修正：**B-1**（CC-6 加入 `finalized_by IS NOT NULL`，修掉 Rev 2 的殘餘 NULL 漏洞；新增 §7.3 五組反例驗證表；六條 CHECK 三值複核，確認僅 CC-6 受影響）；**B-2**（新增 §10.1 跨表身分驗證八條件，套用於 Marker／Phase 2／Recovery，並明示不得以 `UNIQUE(lease_token)` 取代）；**B-3**（新增 §4.1 與 §12.5，將 Intervention 列建立時機列為 `OPEN — REQUIRES OWNER DECISION`，方案 A／B 對照七個面向，全部介入流程改標為條件式設計）；**B-4**（新增 §10.2，Phase 2 三分支逐欄位 SET，含 `dead→sent` 清 `dead_at`、rejected／unknown 保留 `dead_at`）；**B-5**（新增 §11.3.1 與 §12.6，將 marker 前後的 Recovery 語意差異列為 `OPEN — REQUIRES OWNER DECISION`，不新增第四種 outcome、不改 MI-3c）；**B-6**（CC-5 加入 `held_at IS NULL`、Hold CAS 加入 `manual_lease_token IS NULL`、§11.2 明文 hold/lease 互斥）；**SI-1／SI-2** 複核無殘留。§12.1 改以六類狀態分類（含 Implementation Blocker）；§13 將 Full P-5 Design 與 Implementation Readiness 降為 `NOT READY`。狀態維持 `PROPOSED — NOT APPROVED`。 |
| 2026-11-28 | Rev 4 | 納入 Owner 凍結的 Outbox Payload 決策並記錄其 MVP 實作：新增 **§3.2 Payload Schema**（Common Header `schema_version`／`event_type`／`lifecycle_id`／`source_url` ＋ 三型 Discriminated Body `initial_success`／`exhausted_alert`／`correction`；逐欄 UTF-8 上限；總量 65,536 bytes 上限；超限拒絕不截斷；未知欄位忽略；missing 與 `null` 分離；未知 `event_type`／未支援 `schema_version` 拒絕；payload 持久化後不可變、Retry 重用同一字串；JSON／`TEXT`；不新增 hash／簽章）。**C-4 解除**（§12.1、§12.4），`OUT-11` 在 M7.0 規格本文仍為 `OPEN`，本文件未改寫規格。§3 的 `payload` 內部結構 `[OPEN]` 改指向 §3.2。§13 新增 Payload Schema `IMPLEMENTED`（MVP）並將 Full P-5 Design 的未決項由 C-4～C-8 收斂為 C-5～C-8。§14 加入唯一例外條款（僅 §3.2）。H1 標題由誤植的 `（Rev 2）` 更正為 `（Rev 4）`。實作：`src/modules/outbox/payload.{constants,types,errors,serializer}.ts`；測試：單元 32 項、整合 6 項。文件整體狀態維持 `PROPOSED — NOT APPROVED`。 |
