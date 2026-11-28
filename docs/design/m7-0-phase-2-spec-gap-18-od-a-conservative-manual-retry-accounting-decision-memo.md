# M7.0 Phase 2 — SPEC-GAP-18 OD-A：Conservative Manual Retry Accounting Owner 決策紀錄

| 項目 | 內容 |
| --- | --- |
| 文件 | OD-A Conservative Manual Retry Accounting Owner 決策紀錄 |
| 狀態 | **`OWNER DECISION — CONFIRMED`** |
| Decision Owner | Project Owner |
| 決策日期 | 2026-11-27 |
| 決策識別碼 | `OD-A`（提案識別碼，來自 MI-6c 技術可行性分析） |
| 選項 | **Option A — Conservative Accounting** |
| Implementation Authorization | **`NOT GRANTED`** |
| 參照 | MI-6 備忘錄（`m7-0-phase-2-spec-gap-18-mi-6-owner-decision-memo.md`，SHA256 `b7426b58…606c65`）§3.3（MI-6c）、§3.4（MI-6d）；`SPEC-GAP-18`（M7.0 L795） |
| 階段 | Phase 2 |
| 性質 | 決策紀錄。**不授予任何實作授權，不定義任何 schema。** |
| Baseline | branch `main`，HEAD `5ce56d7f070010b102540a10ba6633246544194a` |

**標籤圖例。** `[OWNER DECISION]` 本文件所記錄的 Owner 已確認決策 · `[SPECIFICATION]` 既有規範或已確認政策（非本文件所創） · `[RECOMMENDATION]` 建議做法（**未經核准**） · `[OPEN]` 未決

---

## 1. Context（背景：MI-6c 與 MI-6d 的原始張力）

`[SPECIFICATION]` MI-6c 原本規定（MI-6 備忘錄 §3.3）：

1. 只有在 **Provider invocation 實際發生**時，才計為一次 Manual Retry。
2. `outcome_unknown` **計入**，因為 Provider invocation 已發生。
3. 已被接受、但在 Provider invocation 之前中斷的 retry **不計入**。

`[SPECIFICATION]` MI-6d 規定（§3.4）：Phase 1（`BEGIN IMMEDIATE`：驗證 → CAS → intent + history → Manual Lease → commit）；Phase 2（交易外 HTTP，30 秒）；**過期且結果不確定的 Manual Lease → `outcome_unknown`**；不得自動重送。

`[SPECIFICATION]` 兩者在「提交後、HTTP 前崩潰」的情境下衝突：該 retry 既「未及 invocation」（MI-6c 第 3 條說不計），又被 MI-6d 強制歸為 `outcome_unknown`，而 MI-6c 第 2 條又說 `outcome_unknown` 計入。

`[SPECIFICATION]` 技術分析已證明：在無 Provider 端冪等或狀態查詢能力的前提下，本地 SQLite 應用**無法**在任意程序崩潰下證明外部 HTTP 呼叫實際發生（時間序上，任何本地證據必然早於或晚於外部副作用，兩者皆產生偏誤）。

`[OWNER DECISION]` 基於上述不可判定性，Owner 選擇以**保守會計**取代「精確 invocation 證明」的要求。

---

## 2. Decision（OD-A Option A）

`[OWNER DECISION]` **Option A — Conservative Accounting.**

`[OWNER DECISION]` 條文：

> 一次 Manual Retry 在其**已持久地進入「可能發生 Provider invocation」的階段**時即計為一次，即使後續程序崩潰導致無法證明實際 HTTP 呼叫是否發生。

`[OWNER DECISION]` 本決策**有意變更**先前的 MI-6c 計數語意。

`[OWNER DECISION]` 本決策只確立**語意邊界**，不確立任何欄位名稱、資料表、schema、約束或交易實作。

---

## 3. Revised Counting Semantics（修訂後的計數語意）

`[OWNER DECISION]` 修訂後的完整規則：

| # | 情境 | 是否計數 |
| --- | --- | --- |
| 1 | Retry 尚未跨越持久 possible-invocation 邊界 | **不計** |
| 2 | Retry 已跨越該邊界 | **計，且恰好一次** |
| 3 | 跨越邊界後，程序在 HTTP client 實際被呼叫前崩潰 | **計** |
| 4 | 請求已呼叫，但無法確認網路傳輸 | **計** |
| 5 | 無法確認 Provider 收到或接受 | **計** |
| 6 | 已收到 Provider 回應，但結果無法持久化 | **計** |
| 7 | 請求被拒絕（state conflict）或未進入邊界 | **不計** |
| 8 | 同一 Operation ID 重放 | **不重複計數**（回原結果） |

`[OWNER DECISION]` 本計數**可能高估**實際 Provider invocation 次數；此為**刻意的**保守設計。

`[OWNER DECISION]` 計數所代表的是「**進入了可能呼叫階段的 retry 次數**」，**不是**已證實的外部 HTTP 呼叫次數，也**不是** Provider 收件證明。

`[OWNER DECISION]` 該計數**不得**被描述為 Provider 投遞證明。

---

## 4. The Durable Possible-Invocation Boundary

`[OWNER DECISION]` 「持久地進入 possible-Provider-invocation 階段」**必須**對應一個客觀可辨識的持久化邊界。

### 4.1 十個事件邊界的區分（不得混淆）

| # | 事件 | 是否為本次核准的邊界 |
| --- | --- | --- |
| 1 | Retry operation accepted | **否**（僅接受，不足以代表進入可能呼叫階段） |
| 2 | Manual Lease acquired | **否**（不得單獨作為計數邊界） |
| 3 | Possible-invocation authorization/marker **durably committed** | **是**（語意邊界所在） |
| 4 | HTTP request constructed | 否（無持久效果） |
| 5 | HTTP client invoked | 否（無持久效果） |
| 6 | Network transmission begins | 否（本地不可持久觀測） |
| 7 | Provider receives the request | 否（僅 Provider 可知） |
| 8 | Provider accepts or rejects | 否（僅 Provider 可知） |
| 9 | Response received | 否（僅記憶體） |
| 10 | Result persisted | 否（屬結果階段，非計數邊界） |

`[OWNER DECISION]` 邊界**不得**被等同於 Phase 1 的 lease 取得（第 2 項）；亦**不得**以記憶體旗標作為持久證據。

### 4.2 候選技術實現

`[RECOMMENDATION]` 以「**pre-invocation durable marker**」實現該邊界（**未經核准**）：

- 在呼叫 HTTP client **之前**，以獨立交易提交一筆 marker。
- marker 提交後、HTTP 呼叫前崩潰 → **計數**。
- marker 提交前崩潰 → **不計數**。
- marker 的存在**不得**被表示為「HTTP 已呼叫」的證明。

`[OPEN]` 以下全部未定，**不得**由本文件推定：
- marker 的欄位名稱、型別、所屬資料表；
- marker 交易的邊界與所屬 repository；
- 約束、索引、唯一性；
- marker 與 Provider Attempt 實體的關係；
- marker 失敗時的錯誤語意。

---

## 5. Crash-Window Table

`[OWNER DECISION]` 以下表格為本決策的直接後果（`[RECOMMENDATION]` 之 marker 設計下）：

| 崩潰窗口 | 持久狀態 | 實際 HTTP 是否發生 | 依 OD-A 是否計數 | 是否可能為 `outcome_unknown` | 允許再次 retry | 可能重複投遞 |
| --- | --- | --- | --- | --- | --- | --- |
| **A. marker 提交前** | `leased` + lease token，無 marker | 未發生 | **不計** | 是（MI-6d 過期規則） | 是（新 operation） | 否 |
| **B. marker 提交後、HTTP 呼叫前** | `leased` + token + marker | 未發生 | **計**（高估） | 是 | 是 | 否 |
| **C. HTTP 進行中** | 同 B | 已發生、結果未知 | **計** | 是 | 是 | **是**（若 Provider 已接受） |
| **D. 回應後、結果持久化前** | 同 B | 已發生、結果已知但遺失 | **計** | 是（結果被覆蓋為 unknown） | 是 | **是** |
| **E. 結果已持久化** | 終態 + attempt 結果 | 已發生、已知 | **計** | 否 | 視狀態（`dead` 可再 retry） | 否（除 at-least-once 既有視窗外） |
| **F. marker 交易本身失敗** | `leased` + token，無 marker | 未發生（推論） | **不計** | 是（過期後） | 是 | 否 |

`[SPECIFICATION]` 表中「可能為 `outcome_unknown`」一欄來自 MI-6d 的過期規則，**與計數無關**：`outcome_unknown` 描述的是結果不確定，不是計數判定。

`[OWNER DECISION]` 視窗 B 的高估是本決策**明知且接受**的代價。

---

## 6. Reconciliation with `outcome_unknown`

`[OWNER DECISION]` OD-A 之後，`outcome_unknown` 的意義**被限定**為：

> 描述一次 Provider 結果不確定的嘗試；**其本身不決定是否計數**。

`[OWNER DECISION]` 明確的三點：

1. 過期且**無** marker 的 Manual Lease，仍依 MI-6d 轉為 `outcome_unknown`，但依 OD-A **不計數**。
2. 過期且**有** marker 的 Manual Lease，**計數**，即使無法證明實際 HTTP 呼叫。
3. **不得**主張所有 `outcome_unknown` 嘗試必然計數。

`[SPECIFICATION]` 不自動重送（MI-6d）維持不變；retry 不完成介入（MI-6a）維持不變。

---

## 7. Conflict with the MI-6 Memo and Supersession Scope

`[OWNER DECISION]` OD-A **取代** MI-6 備忘錄 §3.3 中下列條文，**僅限衝突範圍**：

| MI-6 §3.3 原條文 | OD-A 之後 |
| --- | --- |
| 第 1 條「只有在 Provider invocation 實際發生時，才計為一次 Manual Retry」 | 改為「跨越持久 possible-invocation 邊界即計一次」 |
| 第 2 條「`outcome_unknown` 計入，因為 Provider invocation 已發生」 | `outcome_unknown` **不再自動計入**；取決於該次嘗試是否留下 marker |
| 第 3 條「已被接受、但在 Provider invocation 之前中斷的 retry 不計入」 | 改為「在**邊界之前**中斷者不計；邊界之後中斷者計」 |

`[OWNER DECISION]` MI-6 §3.3 其餘條文（由持久紀錄推導、無 `manual_retry_count` 欄、無固定上限）**維持有效**。

`[OWNER DECISION]` MI-6d 全部條文**維持有效**，且**未**被本決策修改。

`[SPECIFICATION]` 本文件**不修改** MI-6 備忘錄本身；該檔案保持原樣（SHA256 `b7426b58…606c65`）。本文件為其計數語意的補充與局部取代紀錄。

---

## 8. Policies That Remain Unchanged

`[SPECIFICATION]` 以下全部維持不變：

| 政策 | 來源 |
| --- | --- |
| 無固定 Manual Retry 上限 | MI-6h |
| 無獨立 `manual_retry_count` 欄 | MI-6c |
| 計數由 append-only 操作紀錄 **加上** OD-A 要求的持久 possible-invocation 證據推導 | MI-6c + OD-A |
| Manual Retry 不重設、不延長自動 retry budget | MI-3、MI-6d |
| `outcome_unknown` 不觸發自動重送 | MI-3、MI-6d |
| Manual Retry 重用已持久化 self-contained payload；不得 LLM 重生成或額外摘要 | MI-3 |
| Operation ID 為 application-generated UUIDv4、全域唯一 | MI-6e |
| 同一 Operation ID 重放不得造成重複投遞或重複操作紀錄 | MI-8、MI-6e |
| Delivery Status 維持四值 `pending`／`leased`／`sent`／`dead` | P-4 |
| `sent` 僅代表 Provider 接受 | `OUT-3` |
| 介入結果與 Delivery Status 分離 | P-4、`OUT-25` |
| Retry 不完成介入；僅 Abandon 完成 | MI-6a |
| Lifecycle abandonment 與 Outbox 介入 abandonment 為不同概念 | `CLM-18`、MI-5 |
| 未經 `SPEC-GAP-10` 確認的 Provider 能力不得假設 | `SPEC-GAP-10`（`OPEN`） |

---

## 9. Explicitly Out of Scope / Still OPEN

`[OPEN]` OD-A **未**解決以下任何一項：

1. P-5 完整 Outbox schema。
2. Provider Attempt 實體的確切 schema。
3. marker 欄位／資料表名稱與約束。
4. 確切交易邊界與 repository 組合方式。
5. Manual Lease token fencing 的實作。
6. Lease 過期與 Phase 2 fencing 細節。
7. Provider 通道、Provider 冪等、狀態查詢能力（`SPEC-GAP-10`）。
8. Operation ID 保留與清理後的 replay 語意。
9. 介入歷史保留。
10. `OUT-14`／`OUT-15`／`OUT-16` 的保留與清理政策。
11. Actor 認證與驗證。
12. 其他任何未決 `SPEC-GAP`。

`[OPEN]` 本文件**不**建立額外的 Owner 決策，也不代替 Owner 決定上述任何一項。

---

## 10. Scope Limitations and No Implementation Authorization

`[OWNER DECISION]` 本文件**未**授權且不得被解讀為授權：

- Provider Attempt、marker、lease、fencing 或 retry 計數邏輯的實作；
- Outbox 或介入相關資料表、migration；
- CLI、worker、recovery 的任何變更；
- 任何原始碼、測試、manifest、lockfile 的變更；
- 任何既有文件的變更（含 MI-6 備忘錄、P-5、`SPEC-GAP-10`）；
- 任何資料庫或 SQL 操作；
- 任何測試、build、typecheck、lint、format；
- 任何依賴安裝或更新；
- 任何 Git 寫入或 Scheduler 部署。

`[OPEN]` 前置條件仍未滿足：P-5、`SPEC-GAP-10`、`OUT-14`–`OUT-16` 均未決，因此計數相關實作**不得**開始。

---

## 11. Explicit Statement on Conservative Accounting

`[OWNER DECISION]` **保守會計可能高估實際 Provider invocation 次數。**

`[OWNER DECISION]` 此高估是**刻意的、已知的、被接受的**，用以換取一個可從持久證據重建、且不會低估真實呼叫的計數。

`[OWNER DECISION]` 使用該計數時，**必須**同時理解：

- 它不是 HTTP 呼叫的證明；
- 它不是 Provider 收件的證明；
- 它不是投遞成功的證明；
- 它不能用於對外主張「已送出 N 次通知」。

---

## 12. Change History（變更歷史）

| 日期 | 變更 | 授權 |
| --- | --- | --- |
| 2026-11-27 | 建立 OD-A 決策紀錄：Owner 選擇 **Option A — Conservative Accounting**。Manual Retry 於跨越持久 possible-invocation 邊界時計數一次，即使無法證明實際 HTTP 呼叫；`outcome_unknown` 不再自動計入；局部取代 MI-6 §3.3 第 1–3 條；MI-6d 全部維持。marker 僅記錄為建議實現；schema、交易邊界、fencing 全部維持 `OPEN`。未授予任何實作授權。 | Owner 決策，本次授權（僅限文件） |

`[SPECIFICATION]` 本文件為新增檔案，未修改任何既有檔案。建立時，M7.0 規格、`docs/architecture.md`、`PROJECT_STATUS.md`、S1、S0a、S0b、D-1～D-5、P-1～P-4、MI-6 備忘錄、`package.json` 與 `package-lock.json` 均保持原有雜湊；未觸碰任何原始碼、測試、schema 或 migration。未執行測試、build、typecheck、lint、format、SQL、資料庫操作或任何 Git 寫入。
