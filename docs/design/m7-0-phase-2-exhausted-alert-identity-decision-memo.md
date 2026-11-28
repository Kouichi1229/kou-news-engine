# M7.0 Phase 2 — D-5：Exhausted-job Alert Identity Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | D-5 Exhausted-job Alert Identity Owner 決策紀錄 |
| 狀態 | **`OWNER DECISION — CONFIRMED`** |
| 決策日期 | 2026-11-27 |
| 階段 | Phase 2 |
| 決策組 | Exhausted-job Alert 身分（邏輯唯一性） |
| 性質 | 決策紀錄。**本文件不授予任何實作授權。** |
| 母規格 | `docs/design/m7-0-ai-news-processing-pipeline.md`（M7.0），SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| 前置分析 | Batch 5 — Outbox-Backed Exhausted-Job Handling: Design Readiness Analysis（唯讀） |
| 相關文件 | D-1 — `m7-0-phase-2-d1-exhaustion-sequencing-decision-memo.md`；D-2／D-3／D-4；S0a（L-01）；S0b（M-4）；S1 — `m7-0-phase-2-processing-state-data-model.md` |

**標籤圖例。** `[OD]` 本文件所記錄的 Owner 已確認決策 · `[EX]` 既有已確認政策（非本文件所創） · `[ODR]` 未決、需 Owner 決策 · `[TO]` 技術觀察 · `[RC]` 建議（本文件不含任何建議）

`[TO]` 文件識別碼 `D-5` 僅供追溯與交叉引用，不構成政策內容，也不改變 M7.0 規格中的任何 `SPEC-GAP` 或 `OUT-*` 識別碼。

---

## A. 背景與問題陳述

`[EX]` M7.0 規定：一個 Processing Version 最多三次嘗試；Claim 消耗一次嘗試；嘗試不退還；每個新的 Processing Version 擁有獨立的嘗試預算（`CLM-8`、`SPEC-GAP-09` 已決部分）。

`[EX]` D-1 已裁定：當過期租約且 `attempts >= 3` 時，**延後** job 的終止化，直到 Outbox 能提供可靠的 Alert 持久化能力；不得先終止化、後補 Alert；不得以不完整或非持久機制產生 Alert。

`[EX]` `CLM-8` 要求：耗盡的 job 轉為 failed 並記錄非 NULL 的 `terminal_reason`，保留 attempts 與錯誤資訊，永久排除於自動 Claim 之外，並**需要告警**；`CLM-15` 要求終止化與其自足的 Alert Outbox 事件持久化必須協調一致；`CLM-19` 要求低於 `published_version` 的未完成 job 先被 retired 為 `superseded` 且**不發 alert**。

`[EX]` Outbox 的唯一性政策為 `UNIQUE(event_type, aggregate_id, notification_key)`（`OUT-1`），其中 `aggregate_id` 代表 Article Lifecycle 身分（`OUT-17`），且為 soft reference、不建立外鍵（`OUT-18`、`OUT-26`）。

**問題。** 上述規定固定了「何時必須有 Alert」與「唯一性約束的形狀」，但未決定**一個耗盡事件對應幾個邏輯 Alert**。此空白造成三個具體後果：

1. Recovery 每次執行都會重新遇到同一個耗盡 job（D-3／D-4 的設計即為反覆的一次性掃描）。若每次遇到都產生一個 Alert，操作者將收到無上限的重複告警。
2. 若以「每個 lifecycle 只有一個 Alert」為規則，則第二個 Processing Version 獨立耗盡時將無法告警，或被迫覆寫第一個版本的歷史事件。
3. 缺少此決策，`notification_key` 的產生方式無法設計，`SPEC-GAP-07` 的欄位列舉亦無法完成，Outbox schema 因此無法開始。

`[OD]` 本文件僅解決第 1 與第 2 項所描述的政策空白；第 3 項所指的實作細節仍為 `[ODR]`。

---

## B. Owner 決策（明確條文）

`[OD]` **每個 Article Lifecycle + Processing Version 最多產生一個邏輯 Exhausted-job Alert。**

`[OD]` 邏輯唯一性範圍為 `Article Lifecycle + Processing Version` 兩者的組合；兩者任一不同即為不同的邏輯識別範圍。

`[OD]` 本決策適用於 **Exhausted-job Alert** 這一種事件型別。它不自動延伸至其他事件型別（例如初始成功通知或 correction 通知），也不改變那些型別已確認的身分規則。

`[OD]` 本決策只確立**邏輯唯一性語意**；它不決定 `notification_key` 的具體編碼、產生演算法、字串格式、分隔符、雜湊或欄位型別（見 E 節）。

---

## C. 同版本重複防制語意

`[OD]` 對於同一 Article Lifecycle 與同一 Processing Version：

| 情境 | 允許的邏輯 Alert 數 | 說明 |
| --- | --- | --- |
| 該 job 首次被判定為耗盡 | 1 | 唯一的邏輯 Alert |
| Recovery 再次執行並再次遇到同一 job | 0（新增） | 既有 Alert 不得重複產生 |
| 對同一耗盡 job 進行多次檢視／掃描 | 0（新增） | 檢視行為本身不產生事件 |
| 同一版本內任何後續執行 | 0（新增） | 見下條 |

`[OD]` **Recovery 的執行本身不構成新的耗盡事件。** 耗盡是由「租約過期且嘗試已達上限」這個狀態事實所定義，而不是由「有人再次掃描到它」所定義。因此重複的 Recovery 執行不得產生第二個邏輯 Alert。

`[OD]` 重複防制必須是**語意上的**，而非僅依賴執行順序：即使兩次 Recovery 在時間上重疊，最終也只能存在一個邏輯 Alert（實作方式屬 `[ODR]`，見 E 節）。

---

## D. 不同版本的獨立 Alert 語意

`[OD]` 較晚的 Processing Version 擁有獨立的嘗試預算。若它獨立地耗盡自己的三次嘗試，則：

- **必須**產生一個**新的、獨立的**邏輯 Exhausted-job Alert；
- **不得**重用或覆寫較早版本的 Alert；
- 較早版本的 Alert **維持為獨立的歷史事件**，不因新版本而改變狀態、內容或存在性。

`[OD]` 較早版本的 Alert 與較晚版本的 Alert 之間沒有取代關係：兩者都是真實發生過的耗盡事實，且各自對應不同的 Processing Version。

`[OD]` 範例（Owner 提供）：

| Article Lifecycle | Processing Version | 結果 | 邏輯 Alert |
| --- | ---: | --- | --- |
| L-001 | 1 | 耗盡 | Version 1 的 Alert |
| L-001 | 1 | Recovery 再次執行 | 無額外 Alert |
| L-001 | 2 | 耗盡 | Version 2 的新 Alert |
| L-001 | 3 | 成功 | 無 Exhausted-job Alert |

`[TO]` 上表第 4 列說明：成功不會產生 Exhausted-job Alert，這是 `CLM-8` 的前提，不是本決策新增的規則。若該版本成功，依 `OUT-19` 可能產生初始成功通知，那是**另一種事件型別**，不在本決策範圍內。

---

## E. 邏輯識別範圍

`[OD]` 已確認的邏輯識別範圍：`Article Lifecycle + Processing Version`。

`[OD]` 其中 Article Lifecycle 的部分與 `OUT-17` 一致：`aggregate_id` 代表 Article Lifecycle 身分，同一 lifecycle 的所有 Processing Version 共用它，版本變更不改變它。

`[OD]` 由於 `aggregate_id` 不區分版本，版本維度**必須**由 Alert 事件的 `notification_key` 承載。這是本決策對 `notification_key` 產生方式所構成的**必要條件**，而非對其編碼的決定：

- 同一 lifecycle、同一 Processing Version 的耗盡 Alert，其 `notification_key` 必須相同；
- 同一 lifecycle、不同 Processing Version 的耗盡 Alert，其 `notification_key` 必須不同。

`[ODR]` `notification_key` 的具體編碼與產生演算法**未定**，屬 `SPEC-GAP-07`。本文件不指定字串格式、UUID 派生方式、雜湊格式、分隔符慣例、資料庫欄位型別，也不指定最終的 SQL 唯一性實作。

---

## F. 與 Outbox 唯一性政策的相容性

`[EX]` 既有唯一性政策：`UNIQUE(event_type, aggregate_id, notification_key)`（`OUT-1`）。

`[TO]` 相容性觀察，逐項說明：

1. **本決策不要求修改該約束。** 版本維度由 `notification_key` 承載後，`(event_type, aggregate_id, notification_key)` 恰可表達「同一 lifecycle 的同一版本最多一個耗盡 Alert」。
2. **不同 Processing Version 不會互相衝突**：`aggregate_id` 相同但 `notification_key` 不同，故不違反唯一性。
3. **不同事件型別不會互相衝突**：`OUT-19` 規定初始成功通知的 `notification_key` 是 lifecycle 範圍的常數，且**不得**由 `processing_version`、attempt 或 derived record 身分派生；本決策則要求耗盡 Alert 的 `notification_key` 必須隨版本不同。兩者規則不同，但因唯一性約束包含 `event_type`，兩者不會碰撞。`[TO]` 這是本決策與 `OUT-19` 相容的關鍵，並非需要協調的衝突。
4. **`aggregate_id` 的 soft reference 性質不變**：本決策不引入任何外鍵，也不要求 Alert 事件在投遞時讀取 lifecycle 或 article 列（`OUT-18`、`OUT-26`）。
5. **重複防制不依賴資料庫以外的機制**：語意唯一性最終必須能由持久層表達；具體表達方式（例如是否額外使用唯一索引、如何處理插入衝突）屬 `[ODR]`，本文件不指定。

`[OD]` 若未來 `SPEC-GAP-07` 的決策使上述相容性無法成立，該決策必須連同本文件一併檢視，而不得單方面推翻本決策。

---

## G. 未決實作細節（全部維持未決）

`[ODR]` 以下項目**未**因本文件而解決，仍維持 `OPEN`：

| # | 項目 | 歸屬 | 狀態 |
| --- | --- | --- | --- |
| 1 | `notification_key` 的具體編碼與產生方式 | `SPEC-GAP-07` | **`OPEN`** |
| 2 | Outbox 完整欄位名稱與型別 | `SPEC-GAP-07` | **`OPEN`** |
| 3 | 四個 Outbox status 名稱與六個 CHECK 約束 | `SPEC-GAP-07` | **`OPEN`** |
| 4 | Alert payload 欄位與型別 | `OUT-11` | **`OPEN`** |
| 5 | Terminal reason 詞彙與優先序 | `L-01` | **`OPEN`** |
| 6 | Abandoned lifecycle 的表示法與相關排除細節 | `L-02` | **`OPEN`** |
| 7 | 投遞通道與機制 | `SPEC-GAP-10` | **`OPEN`** |
| 8 | 重試與 manual intervention 的表示法 | `SPEC-GAP-18` | **`OPEN`** |

`[OD]` 本文件不縮小上述任何一項的範圍，也不提供預設值。任何實作若需要這些項目的答案，必須先取得對應的 Owner 決策。

---

## H. 維持不變的政策

`[OD]` 本決策**不改變**以下任一項：

| 政策 | 出處 |
| --- | --- |
| 每個 Processing Version 最多三次嘗試 | `CLM-8` |
| Claim 消耗一次嘗試 | `SPEC-GAP-09` 已決部分 |
| 嘗試不退還 | `SPEC-GAP-09` 已決部分 |
| 每個新的 Processing Version 擁有獨立的嘗試預算 | `SPEC-GAP-09` 已決部分 |
| D-1：耗盡 job 的終止化延後至可靠的 Alert 持久化能力存在為止 | D-1 備忘錄 |
| Job 終止化與對應 Alert 持久化必須落在同一個可靠一致性邊界內 | D-1、`CLM-15` |
| 不得採「先終止化、後補 Alert」的分裂實作 | D-1 |
| Outbox 事件自足，且不依賴 Article Lifecycle 外鍵存在 | `OUT-18`、`OUT-26` |
| `aggregate_id` 代表 Article Lifecycle 身分 | `OUT-17` |
| 至少一次投遞（at-least-once）仍被接受 | `OUT-4` |
| `sent` 僅代表 provider 接受，不代表最終送達 | `OUT-3` |

`[OD]` 亦不改變：`CLM-19` 的 supersession 必須先於一般 recovery 與耗盡處理；被 supersede 的 job 不得產生耗盡 Alert；`CLM-16` 的 alert 重試預算與 manual intervention 政策；`CLM-18` 的 lifecycle 放棄語意。

---

## I. 實作與授權邊界

`[OD]` **本文件不授予任何實作授權。** 它是一份政策紀錄。

`[OD]` 本文件**未**授權且不得被解讀為授權：

- Outbox schema 或 repository 的實作；
- Alert 的建立或投遞；
- 耗盡 job 的終止化；
- `SPEC-GAP-07` 其餘欄位的解決；
- `OUT-11` payload schema 的解決；
- 對任何既有原始碼、測試、架構文件或專案狀態文件的修改。

`[OD]` 實作若要開始，需另有一次明確授權，指名精確的檔案、測試範圍與批次目標。依 Batch 5 分析，最小安全閉環（Outbox schema → Alert 身分與冪等建立 → 終止化與 Alert 持久化同交易）仍取決於 G 節第 1–3 項與第 5–6 項的決策。

`[TO]` 本決策解除了 Batch 5 分析所列 P0 阻擋中的**第 2 項**（alert `notification_key` 的邏輯唯一性規則）。其餘 P0 項目（`SPEC-GAP-07` 欄位列舉、`OUT-11` payload、`L-01`、`L-02`）維持不變。

---

## J. 變更歷史

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | 建立 D-5：Owner 確認「每個 Article Lifecycle + Processing Version 最多一個邏輯 Exhausted-job Alert」；同版本重複執行不產生新 Alert；不同版本獨立產生新 Alert 且不得覆寫較早版本；邏輯識別範圍為 Lifecycle + Version；與 `UNIQUE(event_type, aggregate_id, notification_key)` 相容。G 節八項維持 `OPEN`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[TO]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md`、S1、S0a、S0b、D-1、D-2、D-3、D-4 備忘錄、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema 或 migration。未執行測試、build、typecheck、SQL、資料庫操作或任何 Git 寫入。
