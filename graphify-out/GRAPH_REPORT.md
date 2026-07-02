# Graph Report - .  (2026-07-02)

## Corpus Check
- 108 files · ~98,658 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 523 nodes · 848 edges · 33 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]

## God Nodes (most connected - your core abstractions)
1. `cfg` - 23 edges
2. `hreq()` - 18 edges
3. `sbSelect()` - 13 edges
4. `extractReceipt()` - 10 edges
5. `extractReceipts()` - 10 edges
6. `assembleExpense()` - 10 edges
7. `expenseFromPhoto()` - 9 edges
8. `detectAnomalies()` - 8 edges
9. `handleUpdate()` - 8 edges
10. `runBatch()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `loadExpenses()` --calls--> `sbSelect()`  [INFERRED]
  lib/agent.js → lib/supabase.js
- `runBatch()` --calls--> `assembleExpense()`  [INFERRED]
  lib/massupload.js → lib/ocr.js
- `runBatch()` --calls--> `extractReceipts()`  [INFERRED]
  lib/massupload.js → lib/ocr.js
- `reqDate()` --calls--> `isISO()`  [EXTRACTED]
  lib/agent.js → lib/reports.js
- `sendExpenseSummary()` --calls--> `fmtMoney()`  [EXTRACTED]
  lib/bot.js → lib/money.js

## Import Cycles
- None detected.

## Communities (33 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (49): loadExpenses(), loadHistory(), { cfg }, { hreq }, qEq(), sbSelect(), sbSoftDelete(), sbUpdate() (+41 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (38): bestPhotoFileId(), { cfg }, { expenseFromPhoto, extractReceipts, assembleExpense }, flushGroup(), { fmtMoney }, formatBatchSummary(), { getFieldSpec }, groups (+30 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (31): { buildReport, toAmount, isISO }, buildToolSpecs(), PERIODS, reqDate(), runAgent(), toolResult(), TOOLS, buildWorkbook() (+23 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (18): msgOf(), runBatch(), { checkDash }, express, ocr, pdf, PDF_ERR_MSG, PDF_ERR_STATUS (+10 more)

### Community 4 - "Community 4"
Cohesion: 0.10
Nodes (24): baseDecision(), buildWatchdogMessages(), CATEGORIES, categorizeLineItems(), { cfg }, effectiveAllow(), groq, itemDesc() (+16 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (20): { cfg }, groqChat(), groqChatTools(), groqVision(), { hreq }, ALLOWED_ROLES, { checkDash }, express (+12 more)

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (20): getCapabilities(), buildPersonalMessages(), { cfg }, dataQualityIssues(), dateIssue(), detectAnomalies(), detectPersonal(), findDuplicate() (+12 more)

### Community 7 - "Community 7"
Cohesion: 0.15
Nodes (13): _cache, { cfg }, convertCurrency(), _fetchRate(), FX_API_URL, _fxHours, getRate(), { hreq } (+5 more)

### Community 8 - "Community 8"
Cohesion: 0.14
Nodes (15): bufferImageMime(), buildInstructionMulti(), { cfg }, { convertCurrency }, { detectAnomalies }, extractReceipts(), { fmtMoney, normaliseDate }, { getFieldSpec } (+7 more)

### Community 9 - "Community 9"
Cohesion: 0.12
Nodes (16): dependencies, dotenv, exceljs, express, @hyzyla/pdfium, description, engines, node (+8 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (14): app, { cfg, assertConfig }, express, mountAgent, mountExcel, mountExpenses, mountMisc, mountReceipt (+6 more)

### Community 11 - "Community 11"
Cohesion: 0.19
Nodes (10): buildInstruction(), coerce(), extractReceipt(), parseModelJson(), parseModelJsonArray(), stripThink(), assert, { extractReceipt, extractReceipts, parseModelJson, parseModelJsonArray, coerce } (+2 more)

### Community 12 - "Community 12"
Cohesion: 0.18
Nodes (8): appReal(), assert, express, FIX, fs, mountUpload, path, { test }

### Community 13 - "Community 13"
Cohesion: 0.20
Nodes (8): appWith(), assert, express, FakePdfError, imgB64, mountUpload, pdfB64, { test }

### Community 14 - "Community 14"
Cohesion: 0.25
Nodes (10): appWith(), appWithGlobalHandler(), assert, b64, { cfg }, express, mountUpload, post() (+2 more)

### Community 15 - "Community 15"
Cohesion: 0.29
Nodes (8): loadMemory(), norm(), recordCorrection(), supabase, assert, { loadMemory, recordCorrection }, supabase, test

### Community 16 - "Community 16"
Cohesion: 0.33
Nodes (8): CUR_SYM, curSym(), fmtMoney(), normaliseDate(), todayISO(), assert, { curSym, fmtMoney, todayISO, normaliseDate }, test

### Community 17 - "Community 17"
Cohesion: 0.24
Nodes (9): assert, callExcel(), ExcelJS, express, FIELD_SPEC, mountExcel, supabase, templates (+1 more)

### Community 18 - "Community 18"
Cohesion: 0.29
Nodes (9): assert, { extractReceipt, extractReceipts }, sentImageUrl(), SPEC, stubGroq(), test, urlFor(), viaReceipt() (+1 more)

### Community 19 - "Community 19"
Cohesion: 0.20
Nodes (8): assert, { cfg }, fs, PNG_SIG, { rasterizePdf }, { rgbaToPng, PdfError }, { test }, zlib

### Community 20 - "Community 20"
Cohesion: 0.22
Nodes (6): assembleExpense(), round2(), { assembleExpense }, assert, FIELDSPEC, test

### Community 21 - "Community 21"
Cohesion: 0.22
Nodes (5): PdfError, assert, { cfg }, { rasterizePdf, PdfError }, { test }

### Community 22 - "Community 22"
Cohesion: 0.22
Nodes (5): assert, FAKE_PAGE, FakePdfError, { handleUpdate }, test

### Community 23 - "Community 23"
Cohesion: 0.28
Nodes (7): appWith(), assert, b64, { cfg }, express, mountUpload, { test }

### Community 24 - "Community 24"
Cohesion: 0.36
Nodes (6): isPresent(), scoreConfidence(), assert, { scoreConfidence, isPresent }, SPEC, test

### Community 25 - "Community 25"
Cohesion: 0.29
Nodes (6): arrOf(), assert, {
  extractReceipt, extractReceipts,
  parseModelJson, parseModelJsonArray,
  assembleExpense, coerce,
}, nReceipts(), SPEC, test

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (5): assertConfig(), cfg, { cfg }, express, { handleUpdate }

### Community 27 - "Community 27"
Cohesion: 0.33
Nodes (5): { cfg }, getLibrary(), rasterizePdf(), rgbaToPng(), zlib

### Community 28 - "Community 28"
Cohesion: 0.29
Nodes (5): { cfg }, express, path, assert, test

### Community 29 - "Community 29"
Cohesion: 0.29
Nodes (5): assert, { cfg }, fs, { rasterizePdf, PdfError }, { test }

### Community 30 - "Community 30"
Cohesion: 0.38
Nodes (6): assert, callReports(), express, mountReports, supabase, test

### Community 31 - "Community 31"
Cohesion: 0.38
Nodes (5): assert, express, mountTemplates, test, withServer()

## Knowledge Gaps
- **255 isolated node(s):** `{ buildReport, toAmount, isISO }`, `PERIODS`, `{ cfg }`, `groq`, `{ getCapabilities }` (+250 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cfg` connect `Community 26` to `Community 0`, `Community 1`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 8`, `Community 10`, `Community 12`, `Community 14`, `Community 19`, `Community 21`, `Community 23`, `Community 27`, `Community 28`, `Community 29`?**
  _High betweenness centrality (0.139) - this node is a cross-community bridge._
- **Why does `runBatch()` connect `Community 3` to `Community 8`, `Community 1`, `Community 20`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `sbSelect()` connect `Community 0` to `Community 8`, `Community 1`, `Community 5`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `{ buildReport, toAmount, isISO }`, `PERIODS`, `{ cfg }` to the rest of the system?**
  _255 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05310734463276836 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.062040816326530614 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06565656565656566 - nodes in this community are weakly interconnected._