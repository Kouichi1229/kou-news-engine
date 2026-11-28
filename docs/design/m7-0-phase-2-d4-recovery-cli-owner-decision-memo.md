# M7.0 Phase 2 — D-4：Recovery CLI Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | D-4 Recovery CLI Owner 決策紀錄（決策組 D-4a／D-4b／D-4c／D-4d） |
| 狀態 | **`RESOLVED — OWNER DECISION`** |
| 決策 | **D-4a／D-4b／D-4c／D-4d — RESOLVED。** 僅為政策決策。 |
| 階段 | Phase 2 |
| 性質 | 決策紀錄。**本文件不授予任何實作授權。** |
| 母規格 | `docs/design/m7-0-ai-news-processing-pipeline.md`（M7.0），SHA256 `9948c8f1…dede12d5` |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |
| 決策日期 | 2026-11-27 |
| 前置分析 | Batch 4 — Recovery CLI Implementation Readiness Analysis（唯讀） |
| 相關文件 | D-3 — `m7-0-phase-2-d3-recovery-entrypoint-decision-memo.md`；D-1 — `m7-0-phase-2-d1-exhaustion-sequencing-decision-memo.md`；D-2 — `m7-0-phase-2-d2-lifecycle-opening-decision-memo.md`；S1 — `m7-0-phase-2-processing-state-data-model.md`；S0b — `m7-0-phase-2-governance-decision-memo.md` |

**標籤圖例。** `[OD]` Owner 已確認決策 · `[DR]` 文件化需求 · `[IF]` 目前實作事實 · `[TO]` 技術觀察 · `[RC]` 建議（非約束） · `[ODR]` 待 Owner 決策。

---

## A. 決策基本資料

| 項目 | 內容 |
| --- | --- |
| 專案 | Kou News Engine M7.0 |
| 階段 | Phase 2 |
| 決策組 | Recovery CLI |
| 決策編號 | D-4a、D-4b、D-4c、D-4d |
| Owner 決策日期 | 2026-11-27 |
| 狀態 | `RESOLVED` |
| 實作授權 | **NOT GRANTED** |
| 前置分析 | Batch 4 Recovery CLI Implementation Readiness Analysis |

| 編號 | 主題 | Owner 選擇 |
| --- | --- | --- |
| D-4a | 執行授權閘門 | **A3 — 必須明確傳入 `--execute`** |
| D-4b | Dry-run 預覽 | **排除真唯讀預覽** |
| D-4c | 持續性失敗處理 | **C1 — 立即回傳 `EXIT_FAILURE`** |
| D-4d | 訊號處理 | **最小化 — 不新增 Signal Coordinator** |

`[TO]` D-4 是**決策組**，不是單一決策；四項彼此獨立，但共同界定同一個最小 Recovery CLI 的邊界。D-4 **不關閉任何 `SPEC-GAP`**，也不改變 D-1／D-2／D-3 的內容。

`[OD]` 本節區分「Owner 決策」與「實作建議」：B 至 E 節所列者為 Owner 決策；Batch 4 分析報告中的其他建議（例如檔案配置、日誌欄位命名、是否新增 `recovery-exit-codes.ts`）**不因本文件而成為核准政策**。

---

## B. D-4a — 明確執行閘門（A3）

`[OD]` Recovery 的實際執行**必須**明確傳入 `--execute`。

`[OD]` 參數行為如下，全部在**開啟資料庫之前**決定：

| 輸入 | 行為 | 退出碼 | 是否開啟資料庫 |
| --- | --- | --- | --- |
| 無參數 | 用法錯誤 | `2`（`EXIT_USAGE`） | **否** |
| `--dry-run` | 用法錯誤（見 D-4b） | `2`（`EXIT_USAGE`） | **否** |
| `--help`（或 `-h`） | 輸出 usage 並結束 | `0`（`EXIT_SUCCESS`） | **否** |
| 未知參數 | 用法錯誤 | `2`（`EXIT_USAGE`） | **否** |
| `--execute` | 允許執行實際 Recovery | 依執行結果（見 D-4c） | 是 |

`[OD]` 參數驗證必須發生在**環境變數載入之前**與**資料庫開啟之前**。`[IF]` 既有 `src/cli/extract.ts` 已採此順序：先 `parseCliArgs`，僅在非 `help`／`usage-error` 時才動態 import `env.js`、`logger.js` 與 CLI 模組，因此 `--help` 與用法錯誤都不會觸發 `env.ts` 的驗證，也不會建立資料庫檔案。

`[OD]` 退出碼**沿用既有慣例**：`0`／`1`／`2`／`130`／`143`（`src/cli/exit-codes.ts`）。**不得發明新退出碼**，也不得為 Recovery 另立一套數值。

`[TO]` 無參數與 `--dry-run` 在本決策下都被視為「呼叫端沒有要求做任何事」，因此以 `2` 失敗，而不是以 `0` 假裝完成。理由：Recovery 的失敗模式是「什麼都沒做卻回報成功」，外部排程器無法從 `0` 分辨。

`[TO]` 與另兩個既有 CLI 的差異必須被記錄：`ingest`／`extract` 的預設模式是 dry-run 且回傳 `0`；Recovery 明確**不採**該預設。此差異是 D-4a 的內容，不是疏漏。

---

## C. D-4b — 排除真 Dry-run 預覽

`[OD]` 真唯讀的 Recovery 預覽**不在**最小 CLI 範圍內。

`[OD]` **不得**為預覽新增 Repository API 或 SQL。`[IF]` 目前 Processing repository 只有 `reopenExpired` 這個會寫入的入口，以及 `findJob`／`findLifecycle` 這種逐筆查詢；沒有對應於 `countClaimable` 的集合計數能力。

`[OD]` **不得**為預覽新增專用的資料庫存取路徑（例如為 Recovery 開啟唯讀 handle 只為了顯示數量）。

`[OD]` `--dry-run` **不是**受支援的執行模式，其行為依 D-4a 以用法錯誤（退出碼 `2`）處理。

`[OD]` 任何未來的預覽能力都需要**獨立的設計與授權**；本決策不預留實作空間，也不定義預覽的計算方式或輸出格式。

`[TO]` 因此 Recovery CLI **不得**宣稱能預覽「將重新開啟幾筆」。任何輸出數字只能是實際執行後的結果。

---

## D. D-4c — 立即持續性失敗（C1）

`[OD]` SQLite `BUSY` 與其他持續性失敗（persistence failure）**立即**產生既有的 `EXIT_FAILURE`（`1`）。

`[OD]` **不新增**應用層重試迴圈，也不新增有界重試（bounded retry）機制。

`[OD]` 既有 SQLite busy-timeout 行為維持不變。`[IF]` `BUSY_TIMEOUT_MS = 5000`，於每個新連線的第一條語句設定（`src/core/persistence/sqlite.ts:155`、`:333`）。

`[OD]` 外部排程器的重試政策屬**另一項決策**，維持 `OPEN`（見 G 節）。

`[OD]` 本文件**不得**被解讀為外部重試已經被授權或已經設計完成。

`[TO]` 目前 `src/` 內沒有任何程式碼檢查 `errcode`／`errstr`／`SQLITE_BUSY`，因此 Recovery CLI **不需要**、也**不得**自行新增錯誤分類邏輯；所有失敗一律落在 `1`。

---

## E. D-4d — 最小化訊號處理

`[OD]` **不新增** Signal Coordinator。

`[OD]` **不得**僅為了這個一次性、同步的 Recovery 交易而整合既有的 Signal Coordinator。

`[OD]` 既有 SQLite 交易語意必須維持不變：`reopenExpired` 仍以 `BEGIN IMMEDIATE` 包住 CLM-19 退休與重新開啟，成功 `COMMIT`、失敗 `ROLLBACK`。

`[OD]` 交易尚未提交時若程序被中斷，未提交的工作預期由 SQLite 回滾。

`[OD]` 本設計選擇**不主張**所有程序終止情境都已被測試過。

`[OD]` 未來的實作驗證必須涵蓋相關的中斷／回滾行為（見 G 節與 H 節的測試範圍）。

`[TO]` 與 `extract`／`ingest` 的差異在於工作量型態：兩者包含長時間網路 I/O，需要取消機制；Recovery 是單一同步交易，取消機制無法提供額外保證，只會增加表面積。

---

## F. 與既有決策的關係

`[OD]` 以下全部維持不變，並在此重申，避免日後被推論為已變更：

| 決策 | 內容 |
| --- | --- |
| D-1 | 耗盡 attempts 的 job 之終止化，延後至具備可靠的 Outbox-backed Alert 持久化能力為止 |
| D-2 | Article Lifecycle 在 Processing 首次 claim 工作時，與 Job 建立及 Claim 一起原子開啟 |
| D-3 | Recovery 透過專用的一次性 External Scheduler CLI 執行 |

`[OD]` Recovery **不得**在 HTTP Server 啟動時執行。

`[OD]` Recovery **不得**作為內部長駐輪詢程序執行。

`[OD]` Recovery **不得**在每次 Worker Claim 時執行。

`[OD]` Batch 1、Batch 2、Batch 3 的 repository 語意維持不變。

`[OD]` `CLM-19` 的 supersession **必須**維持在一般 Recovery 重新開啟之前。

`[OD]` 在 D-1 之下，`attempts >= 3` 的 job **不得**被此 Recovery 流程重新開啟，也**不得**被其終止化。

---

## G. 未解項目 — 維持 OPEN

`[OD]` 以下項目維持 `OPEN`，本文件不解決、不縮小、也不預判其中任何一項：

| 項目 | 狀態 | 內容 |
| --- | --- | --- |
| `SPEC-GAP-08` | **OPEN** | Recovery 排序與排程細節 |
| `SPEC-GAP-11` | **OPEN** | Lease／Recovery 的設定名稱與預設值 |
| Scheduler 類型 | **OPEN** | cron、systemd timer 或其他 |
| Scheduler cadence | **OPEN** | 實際執行週期 |
| Scheduler 部署與運維設定 | **OPEN** | 部署方式、環境、鎖序列化 |
| External Scheduler 重試政策 | **OPEN** | 是否重試、次數、退避 |
| 未來真 Dry-run 預覽的 API 與 SQL | **OPEN** | 需獨立設計 |
| `SPEC-GAP-04`、`SPEC-GAP-05` | **OPEN** | 衍生產出 schema 與 version 建立條件 |
| `CLM-9` | **OPEN** | 終止原因詞彙 |
| Option E／Processing Run 整合 | **OPEN** | 需獨立 Owner 決策 |
| Outbox-backed 耗盡處理之前提與設計缺口 | **OPEN** | `SPEC-GAP-07`、`OUT-9`～`OUT-16`、`SPEC-GAP-10`、`SPEC-GAP-15` 等 |

`[OD]` **最小 CLI 設計之所以可以推進，並不代表上述任何一項已被解決。** 它們之中有些（例如 `SPEC-GAP-08`、`SPEC-GAP-11`）不阻擋最小 CLI，有些（例如 Scheduler 部署、重試政策、預覽能力、Option E）則明確落在本批次範圍之外。

---

## H. 實作邊界

`[RC]` 以下為**規劃資訊**，列出未來實作可能涉及的檔案。**本文件不授權修改其中任何一個。**

| 檔案 | 預期用途 | 授權狀態 |
| --- | --- | --- |
| `src/cli/recover.ts` | 薄入口；參數解析先於環境載入與資料庫開啟 | **未授權** |
| `src/cli/recovery.cli.ts` | 執行邏輯：開 DB、建 repository、呼叫 `reopenExpired`、記錄結果、關 DB、回傳退出碼 | **未授權** |
| `package.json` | `recover` 與 `recover:prod` script | **未授權** |
| `src/cli/usage.ts` | 僅在確有必要時小幅、向後相容地調整 | **未授權** |
| `tests/unit/cli/recovery-cli.test.ts` | 注入式測試：計數、狀態、退出碼、DB 關閉 | **未授權** |
| `tests/integration/cli/recover.test.ts` | 子程序層級：退出碼、單行 JSON、DB 實際變化、缺 `--execute` 不建立 DB | **未授權** |

`[OD]` **本備忘錄不授予實作授權。** 任何程式碼、測試、`package.json`、usage 文字或排程設定的修改，都需要 Owner 另行明確授權，並指名精確的檔案與測試範圍。

`[OD]` 實作時**不得**為了建立 CLI 而重新設計 Recovery SQL、修改既有 repository 語義，或變更 Processing Lifecycle／Claim／Lease／Attempt 的任何規則。

---

## I. 變更歷史與本文件驗證

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | D-4 決策組正式化。Owner 選定 D-4a = A3（必須明確 `--execute`）、D-4b = 排除真 Dry-run 預覽、D-4c = C1（立即 `EXIT_FAILURE`）、D-4d = 最小化訊號處理。G 節所列項目全部維持 `OPEN`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[TO]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、S1、S0a、S0b、D-1、D-2、D-3 備忘錄、`docs/architecture.md`、`PROJECT_STATUS.md`、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema、migration 或排程設定。未執行測試、build、migration、資料庫操作或任何 Git 寫入。
