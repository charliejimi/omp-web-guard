# omp-web-guard

給 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）用的兩支網頁守門擴充，用一次 `-e` 一起載入：

- **網址守門員**：不讓 `read`、`grep`、`ast_grep`、`ast_edit` 連到內網位址（loopback、私有網段、link-local、雲端 metadata 與其他非公開網段）。呼叫前檢查一次，呼叫後再檢查一次，因為 omp 會自己跟著轉址、改抓 markdown 替代版。
- **內容守門員**：網頁文字裡有已知的注入句型就整段扣下，其餘的貼上「不可信的資料」標籤。omp 18.4.4 以上，標籤不放進工具結果，改走 developer 通道。

兩支共用一份紀錄；`web-guard-report` 拿研究結果引用的網址去對這份紀錄。

[English](README.md)

> **沒有用真的模型測過。** live 測試用腳本模型驅動真的 omp（18.2.8；標籤通道另外在 18.10.3 測），網站是本機假站。測得出什麼被擋、被扣、被貼標籤，測不出真的模型看到之後會怎麼做。

## 為什麼

omp 用 `read <網址>` 讀網頁，`grep`、`ast_grep` 的路徑也可以填網址。在 omp 18.2.8（302 與 markdown 替代版兩項在 18.10.3 也重測過）：

- 讀網址會跟著 `302` 連到任何主機；頁面宣告的 markdown 替代版、加上 `.md` 的版本、內容協商的版本、feed、`llms.txt`，不管在哪台主機都會去抓。所以一個公開頁面就能讓 agent 讀到 `http://169.254.169.254/` 或 `http://10.0.0.1/`，而 `tool_call` 只看得到原本要讀的公開網址。
- 網頁文字原封不動交給模型。寫給 agent 看的句子（「忽略先前的指示……」）看起來跟其他內容一樣。

Day25 的文章把這兩件事都測過；它的整合時序圖加上了網址守門員、網路層出站政策，以及事後拿研究出處去對紀錄。這個套件就是圖上 omp 的那一段。

## 做什麼

| 部分 | 時機 | 做什麼 |
|---|---|---|
| 網址守門員：事前檢查 | `read`、`grep`、`ast_grep`、`ast_edit` 的 `tool_call` | 找出 `path`、`paths` 欄位裡的每個網址（包括 `src; https://…` 的第二個、字串裡的 JSON 清單、`www.` 開頭的主機、少一個斜線的 `http:/`）。先套可選的網域政策，再查 DNS；只要**有一個**位址在內網就擋下，除非 `allowRanges` 有列。查不到或超過 `lookupTimeoutMs` 也擋。一次呼叫最多 20 個網址。`read` 的路徑如果把網址跟其他路徑寫在一起也擋：omp 會拆開來讀，拆開後的那幾次不經過擴充，兩支守門員都看不到結果。 |
| 網址守門員：事後檢查 | 讀網址的 `tool_result` | 用同樣的方法檢查轉址後的最終網址，以及結果 notes 裡的每個網址（markdown 替代版、feed 替代版、`llms.txt`、轉出的文件）。只要一個落在內網或被網域政策拒絕，整段結果就換成通知（`isError: true`），omp 存下的那份 artifact 之後也讀不到。每次讀網址都記一行 `fetched`：原本要讀的網址、最終網址、`via`。 |
| 內容守門員 | `web_search`、讀網址、路徑有網址的 `grep`／`ast_grep`，以及之後讀它們的 artifact | **扣下：** 命中五個句型之一（英文 3 類、中文 2 類，照 Day25 文章）就整段換成通知，寫明來源和句型。**貼標籤：** 沒命中就加上 `[UNTRUSTED WEB CONTENT from …]` 標籤，原文包在每次都不同的 `<<untrusted-web-content-隨機碼>>` 邊界裡；頁面裡長得像邊界的字串先拿掉。**放行：** 錯誤結果原樣放行，記一筆。 |
| 標籤通道 | 內容守門員 | 預設 `auto`：從擴充 API 讀 omp 版本，18.4.4 以上用 `additionalContext` 回傳標籤，omp 會以 developer 訊息送到工具結果外面；更舊的版本把標籤放在原文前面。 |
| 開場通知 | `session_start` | 兩支各說明自己管哪些工具、有哪些例外和網域政策、標籤走哪裡、紀錄在哪。設定檔有錯會說明，並讓守門員改成全擋。 |
| `web-guard-report` | 事後 | 研究結果引用的每個網址，對到它在紀錄裡的狀態；有引用被扣或根本沒讀過，就 exit 1。 |

順序由套件的 manifest 固定：網址守門員在前。被擋下的呼叫不會到內容守門員那裡，被扣下的結果到那裡時是錯誤結果。

## 需求

- omp 18.2.8（完整測過）。omp 18.10.3 測過標籤通道與轉址的事後檢查。
- [Bun](https://bun.sh) 1.3.14 以上（用 1.4.2 測）。

## 安裝

放在 agent 會動到的每個專案**外面**，agent 才改不到守門員本身。執行時不需要任何相依套件；`bun install` 只是為了跑測試。

```bash
git clone <這個 repo> ~/omp-web-guard
cd ~/omp-web-guard && bun install
```

照 Day25 時序圖第 8 步，明確列出擴充、套用 `examples/` 的設定疊加檔，只開研究需要的工具：

```bash
omp --no-extensions -e ~/omp-web-guard --config ~/omp-web-guard/examples/overlay.yml --tools read,web_search,task
```

`-e ~/omp-web-guard` 會照正確順序載入兩支。要每次都載入，就在 `~/.omp/agent/config.yml` 列出：

```yaml
extensions:
  - ~/omp-web-guard
```

其他擴充可能讓守門員失效一部分：`tool_call` 的輸入如果被改寫，omp 採用最後一次改寫，網址守門員的事前檢查看不到（事後檢查仍會檢查 `read` 最後連到哪）；排在內容守門員後面的 `tool_result` handler 也可以把標籤拿掉。建議用 `--no-extensions` 加明確的 `-e` 清單，也不要載入會改寫 `read` 輸入的擴充。

用 `-e` 載入的擴充也會套到 subagent（Day25 實測過），派出去讀的網頁一樣會被檢查。

## 設定

可選，放在 `~/.config/omp-web-guard/config.json`。不讀環境變數，也不讀專案裡的東西：Bun 會把專案的 `.env` 載進 omp 的環境變數。範例見 `examples/config.example.json`。

| 設定 | 預設 | 意思 |
|---|---|---|
| `ledger` | `~/.omp/web-guard-ledger.jsonl` | 兩支守門員寫入的 JSONL 紀錄；絕對路徑或 `~/` 開頭。 |
| `allowRanges` | `[]` | 不擋的 CIDR，例如內部文件伺服器 `["10.20.30.40/32"]`。不接受 `/0`，也不接受前綴後面還有位元的寫法。IPv4 網段也會放行它的 IPv4-mapped 形式。 |
| `domainPolicy.allow` | `[]` | 不是空的時候，只能讀這些主機和它們的子網域。 |
| `domainPolicy.deny` | `[]` | 不能讀這些主機和它們的子網域；deny 優先。 |
| `labelChannel` | `"auto"` | `"content"`：標籤一律放在原文前面。`"additionalContext"`：一律走 developer 通道（omp 18.4.4 以前標籤會不見，開場通知會警告）。 |
| `nonceBoundary` | `true` | `false` 就不包隨機碼邊界。 |
| `lookupTimeoutMs` | `5000` | 100 到 20000。同一次檢查的 DNS 查詢同時進行，所以最多花這麼久，遠低於 omp 的 30 秒 handler 逾時；超過那個時間，omp 會把工具結果原樣放行。 |

設定檔不能用時，開場會說明；修好以前，網址守門員擋下所有讀網址，內容守門員扣下所有網頁結果。

### 哪些算內網

IPv4：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`（其中 `169.254.169.254` 標為雲端 metadata）、`172.16.0.0/12`、`192.0.0.0/24`、`192.0.2.0/24`、`192.88.99.0/24`、`192.168.0.0/16`、`198.18.0.0/15`、`198.51.100.0/24`、`203.0.113.0/24`、`224.0.0.0/4`、`240.0.0.0/4`，以及 metadata 位址 `100.100.100.200`、`168.63.129.16`。

IPv6：`::`、`::1`、`64:ff9b:1::/48`、`100::/64`、`2001::/23`、`2001:db8::/32`、`3fff::/20`、`fc00::/7`（其中 `fd00:ec2::254` 標為 metadata）、`fe80::/10`、`fec0::/10`、`ff00::/8`，以及 `2000::/3` 以外的其他位址。IPv4-mapped（`::ffff:a.b.c.d`）、NAT64（`64:ff9b::/96`）、6to4（`2002::/16`）看它帶的 IPv4 位址判斷；IPv4-compatible（`::a.b.c.d`）一律擋。

主機的各種寫法照 omp 的讀法：Bun 的網址解析會把 `2130706433`、`0x7f.1`、`127.1`、`%31%32%37.0.0.1` 都轉成 `127.0.0.1`，守門員和 omp 看到的一樣。`localhost` 和 `*.localhost` 算 `127.0.0.1` 加 `::1`，所以只放行 `127.0.0.1/32` 不會放行 `localhost`。

## 紀錄

一行一個 JSON，帶 `ts`、`event`、`session`、`call`（tool call id）、`tool`。網址只記主機和路徑，不記查詢字串（`hasQuery` 記有沒有），因為查詢字串可能就是 agent 被要求送出去的東西。

| `event` | 誰寫 | 欄位 |
|---|---|---|
| `fetch` | 內容守門員，呼叫前 | `url`、`hasQuery` |
| `ssrf-block` | 網址守門員 | `phase`（`pre`／`post`）、`reason`（`internal`、`lookup-failed`、`lookup-timeout`、`unparseable`、`delimited-read`、`too-many-urls`、`withheld-artifact`、`config-error`、`guard-error`）、`source`、`host`、`address`、`category`、`range`、`requested`（事後） |
| `domain-block` | 網址守門員 | `phase`、`rule`（`deny`／`allow`）、`source`、`host` |
| `fetched` | 網址守門員，讀完網址後 | `requested`、`finalUrl`、`via`（`[{ kind, source }]`）、`method`、`withheld` |
| `block` | 內容守門員 | `source`、`pattern`、`chars` |
| `label` | 內容守門員 | `source`、`chars`、`channel`、`nonce` |
| `skip` | 內容守門員 | `source`、`reason` |

## 對帳研究結果

Day25 時序圖最後一段（D 段），是人拿每句的出處去對紀錄。`web-guard-report` 做這件事：

```bash
bun ~/omp-web-guard/bin/web-guard-report.ts --session <session id> --answer answer.md
```

| 狀態 | 意思 | exit |
|---|---|---|
| `labelled` | 讀過，內容守門員只貼了標籤 | 0 |
| `redirected` | 讀過，但內容來自別的主機 | 0，警告 |
| `via-alternate` | 讀過，但內容來自替代版網址 | 0，警告 |
| `read` | 抓過，但沒有內容守門員的紀錄 | 0，警告 |
| `blocked` | 被內容守門員扣下 | 1 |
| `ssrf-blocked`／`domain-blocked` | 被網址守門員擋下或扣下 | 1 |
| `not-read` | 紀錄裡沒有，或只有失敗的讀取 | 1 |

不給 `--answer` 時，列出紀錄裡每個來源的狀態。`--json` 輸出 JSON；`--ledger` 讀別的檔案。正當的頁面被扣下時，換一個一手來源，或自己讀那一頁、貼上需要的部分；不要叫 agent 改抓原始 HTML。

## 範例

- `examples/overlay.yml`：`bash`、`eval` 設 `deny`，因為它們可以自己抓網址，兩支守門員都看不到；`task` 設 `allow`；subagent 在前景跑完。測試裡用 omp 自己的設定載入器讀它。
- `examples/egress.nft`：給跑 omp 的容器或 VM 用的 nftables 出站政策。擋的網段跟守門員一樣，加上這些 IPv4 網段的 NAT64、6to4 形式，以及 `2000::/3` 以外的 IPv6；放行連到指定 DNS 伺服器，以及 TCP 80、443。**未測：** 從來沒有載入過（打包這台機器沒有 root，也不能用 user namespace）；測試只檢查它的網段清單跟守門員一致。擴充擋不住的部分要靠這一層（見「限制」）。
- `examples/config.example.json`：所有設定。

## 測試

```bash
bun run test
```

`bun run test` 會用暫時的 `HOME` 和 `TMPDIR` 啟動 Bun；直接跑 `bun test` 會拒絕執行，因為測試會在家目錄底下寫紀錄和 omp 的狀態，而 Bun 在啟動時就固定了家目錄。測試透過 omp 自己的擴充 loader 和 runner，DNS 用假的解析器，不需要網路。

live 測試用只供測試的腳本模型（`test/scripted-provider.ts`）驅動真的 omp，網站是兩個本機假站（`test/sites.ts`）：`127.0.0.1` 當公開站（每次執行的設定都放行它），`127.0.0.2` 當內網服務。

```bash
WEB_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
WEB_GUARD_LIVE_OUT=/tmp/web-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` 改用已安裝的 omp。omp 18.2.8：沒有守門員時，`302` 和 markdown 替代版都會把內網服務的標記送到模型眼前。有守門員時，直接讀和 `grep` 內網服務都被擋，內網服務收不到任何請求；`302` 和替代版那兩次被扣下，紀錄寫出內網的最終網址和替代版網址；同一主機的替代版放行；明寫的餌被扣下，改寫過措辭的餌只貼標籤，SearXNG 搜尋摘要裡的餌被扣下；疊加設定讓 `bash` 直接失敗、沒有執行。omp 18.4.4 以上：標籤以 developer 訊息送到模型，工具結果裡留著包在隨機碼邊界內的原文，`302` 被扣下。

## 公開發布前要做

- **安全稽核：** 還沒做。實作前做過威脅建模（OWASP LLM Top 10 與 OWASP Agentic，共 20 類），但程式碼沒有經過獨立的攻擊式審查。
- **真模型實測：** 還沒做。
- **出站政策範例：** 從來沒有載入過，見「範例」。
- **第一次 CI：** GitHub Actions workflow 還沒跑過；`bun.lock` 是離線產生的。
- **其他 omp 版本：** 只測過 18.2.8 和 18.10.3；網址的處理照 omp 18.2.8 的規則。

## 限制

- **轉址的每一跳沒有檢查。** omp 在一次抓取裡自己跟著轉址；守門員只看得到之前的網址和最後的網址。轉進內網的那一跳仍然會連到內網服務（live 測試記錄了那個請求），被扣下的只是結果。有副作用的請求（`GET /admin/delete`）照樣會發生。只有網路層，或修改 omp 的抓取程式，才擋得住那一跳。
- **檢查和實際連線之間，DNS 可能變了**（DNS rebinding）。守門員查一次，omp 連線時再查一次。這要靠網路層。
- **替代版自己再轉址，看不到。** omp 只在 notes 寫替代版的網址，不寫那個請求又被轉到哪；`.md` 版本和內容協商也一樣。
- **`grep`、`ast_grep` 只有事前檢查。** 它們的結果沒有最終網址。
- **關鍵字句型只是絆線。** 改寫過措辭的餌只會被貼標籤，照不照做看模型。正當頁面只要引用了注入句型，整頁都會被扣下。
- **標籤只是提醒。** 它把內容標成資料，沒辦法讓模型一定忽略。
- **只檢查這幾個工具。** `bash`、`eval`、瀏覽器、MCP 工具都能抓網頁內容而不經過守門員；疊加設定擋掉了 `bash` 和 `eval`，瀏覽器和 MCP 不在範圍內。
- **預設不擋把資料送到公開主機。** 沒設 `domainPolicy.allow` 時，照著餌做的模型可以把資料塞進任何公開網址的查詢字串；紀錄只會記 `hasQuery`。
- **artifact 的追蹤只在同一個 omp 行程內有效。** 被扣下的結果和網頁結果的 artifact，在 omp 執行期間依 session 記住。
- **紀錄沒有防竄改。** 放在專案外面。
- **有 proxy 時，名稱由 proxy 自己解析。** omp 設了 HTTP proxy 時，守門員查到的位址可能跟 proxy 查到的不同。

## 背景

這個套件實作 Day25 整合時序圖（網頁內容進模型前後的每一道關卡）中 omp 的部分：C 段的網址守門員與內容守門員、D 段的紀錄與對帳，以及第 4 項的出站政策。設定名稱沿用 [pi-web-access](https://github.com/nicobailon/pi-web-access)（`allowRanges`、`domainPolicy`）；隨機碼邊界參考 [pi-injection-guard](https://github.com/drg407/pi-injection-guard)；developer 通道的標籤用的是上游 [PR 13267](https://github.com/can1357/oh-my-pi/pull/13267) 的 `additionalContext`。上游 [PR 6945](https://github.com/can1357/oh-my-pi/pull/6945) 曾想在 omp 的抓取程式裡逐跳檢查轉址，沒有合併就關閉了。

## 授權

[MIT](LICENSE)
