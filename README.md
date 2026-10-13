# omp-web-guard

Two [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extensions for web reads, loaded together with one `-e`:

- a **URL guard** that keeps `read`, `grep`, `ast_grep`, and `ast_edit` away from internal addresses (loopback, private networks, link-local, cloud metadata, and other non-public ranges), checked before the call and again after it, because omp follows redirects and markdown alternates by itself;
- a **content guard** that withholds web text containing known injection phrases and labels the rest as untrusted data. On omp 18.4.4 and later the label travels outside the tool result, in the developer channel.

Both write one ledger, and `web-guard-report` checks a research answer's citations against it.

[中文說明](README.zh-TW.md)

> **Not tested with a real model.** The live tests run real omp (18.2.8, and 18.10.3 for the label channel) end to end with a scripted test model against local sites. They show what is blocked, withheld, and labelled; they do not show how a real model reacts to that.

## Why

omp reads a web page with `read <url>` (and `grep`/`ast_grep` accept URLs too). In omp 18.2.8 (and, for the `302` and the markdown alternate, measured again on 18.10.3):

- the reader follows a `302` to any host, and fetches a page's markdown alternate, its `.md` twin, a content-negotiated version, a feed, or `llms.txt` on any host the page names. A public page can therefore make the agent read `http://169.254.169.254/` or `http://10.0.0.1/`, while the `tool_call` hook only sees the public URL that was asked for;
- the page text goes to the model as it is. Text written for the agent ("ignore your previous instructions…") arrives looking like everything else.

The Day25 article measured both, and its integrated sequence diagram adds a URL guard, a network-layer egress policy, and a ledger check of research sources. This package is the omp part of that diagram.

## What it does

| Part | When | What it does |
|---|---|---|
| URL guard, pre-check | `tool_call` of `read`, `grep`, `ast_grep`, `ast_edit` | Finds every URL in the `path`/`paths` fields (also the second URL of `src; https://…`, a JSON list in a string, `www.` hosts, a collapsed `http:/` scheme). Applies the optional domain policy, then resolves the host and blocks the call when **any** address is internal, unless `allowRanges` exempts it. A lookup that fails or takes longer than `lookupTimeoutMs` blocks too. At most 20 URLs per call. A `read` that names a URL among other paths is blocked: omp reads those parts without the extension hooks, so neither guard would see the result. |
| URL guard, post-check | `tool_result` of a URL `read` | Checks the final URL after redirects and every URL in the result's notes (markdown alternate, feed alternate, `llms.txt` fallback, extracted document) the same way. One internal or denied address replaces the whole result with a notice (`isError: true`), and a later read of the artifact omp saved it to is blocked. Every URL read gets a `fetched` ledger line with the requested URL, the final URL, and `via`. |
| Content guard | `tool_result` of `web_search`, a URL `read`, `grep`/`ast_grep` with a URL, and a later read of their artifacts | **Block:** text matching one of five patterns (3 English, 2 Chinese, from the Day25 article) is replaced by a notice naming the source and pattern. **Label:** otherwise the text passes behind an `[UNTRUSTED WEB CONTENT from …]` label, inside a `<<untrusted-web-content-NONCE>>` boundary with a random nonce per result; boundary look-alikes in the page are removed first. **Skip:** error results pass unchanged and are recorded. |
| Label channel | content guard | `auto` (default) reads omp's version from the extension API: 18.4.4 or later returns the label as `additionalContext`, which omp delivers as a developer message outside the tool output; older omp gets the label in front of the text. |
| Notices | `session_start` | Each guard says what it covers, which exceptions and domain policy are active, where the label goes, and where the ledger is. A config error is reported and makes the guards fail closed. |
| `web-guard-report` | after a run | Maps every URL an answer cites to what its read left in the ledger; exits 1 when a citation was blocked or never read. |

Ordering matters and is fixed by the package manifest: the URL guard runs first, so a blocked call never reaches the content guard, and a withheld result reaches it as an error.

## Requirements

- omp 18.2.8 (tested end to end). omp 18.10.3 was tested for the label channel and the redirect post-check.
- [Bun](https://bun.sh) 1.3.14 or newer (tested with 1.4.2).

## Install

Clone it **outside** every project the agent works on, so the agent cannot change the guard. The extensions need no dependencies at run time; `bun install` is for the tests.

```bash
git clone <this repository> ~/omp-web-guard
cd ~/omp-web-guard && bun install
```

Run omp with an explicit extension list, the settings overlay from `examples/`, and only the tools a research run needs (Day25 diagram, step 8):

```bash
omp --no-extensions -e ~/omp-web-guard --config ~/omp-web-guard/examples/overlay.yml --tools read,web_search,task
```

`-e ~/omp-web-guard` loads both guards in the right order. To load them in every session, list the package in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/omp-web-guard
```

Other extensions can undo parts of the guards: omp keeps the last `tool_call` input revision, which the URL guard's pre-check never sees (its post-check still checks where a `read` ended), and a `tool_result` handler that runs after the content guard can remove its label. Prefer `--no-extensions` with an explicit `-e` list, and do not load extensions that rewrite `read` input.

Subagents get the same `-e` extensions (the Day25 runs measured this), so delegated reads are checked too.

## Configuration

Optional, in `~/.config/omp-web-guard/config.json`. Nothing is read from environment variables or from the project: Bun loads a project's `.env` into omp's environment. See `examples/config.example.json`.

| Setting | Default | Meaning |
|---|---|---|
| `ledger` | `~/.omp/web-guard-ledger.jsonl` | The JSONL file both guards append to; absolute or starting with `~/`. |
| `allowRanges` | `[]` | CIDRs exempt from the internal-address block, e.g. `["10.20.30.40/32"]` for an internal docs server. `/0` and CIDRs with bits after the prefix are refused. An IPv4 range also exempts the IPv4-mapped form. |
| `domainPolicy.allow` | `[]` | When not empty, web reads may reach only these hosts and their subdomains. |
| `domainPolicy.deny` | `[]` | Web reads may not reach these hosts or their subdomains; deny wins. |
| `labelChannel` | `"auto"` | `"content"` always puts the label in front of the text; `"additionalContext"` always uses the developer channel (on omp before 18.4.4 the label is then lost, and the session notice warns). |
| `nonceBoundary` | `true` | `false` drops the nonce boundary. |
| `lookupTimeoutMs` | `5000` | 100 to 20000. All lookups of one check run at once, so a check takes at most this long, well inside omp's 30 s handler timeout, after which omp passes a tool result through unchecked. |

A config file that cannot be used is reported at session start; the URL guard then blocks every URL read and the content guard withholds every web result until it is fixed.

### What counts as internal

IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (with `169.254.169.254` named as cloud metadata), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, and the metadata addresses `100.100.100.200` and `168.63.129.16`.

IPv6: `::`, `::1`, `64:ff9b:1::/48`, `100::/64`, `2001::/23`, `2001:db8::/32`, `3fff::/20`, `fc00::/7` (with `fd00:ec2::254` named as metadata), `fe80::/10`, `fec0::/10`, `ff00::/8`, and anything else outside `2000::/3`. IPv4-mapped (`::ffff:a.b.c.d`), NAT64 (`64:ff9b::/96`), and 6to4 (`2002::/16`) addresses are judged by the IPv4 address they carry; IPv4-compatible addresses (`::a.b.c.d`) are always blocked.

Host spellings are read the way omp reads them: Bun's URL parser turns `2130706433`, `0x7f.1`, `127.1`, and `%31%32%37.0.0.1` into `127.0.0.1` for both. `localhost` and `*.localhost` count as `127.0.0.1` and `::1`, so exempting `127.0.0.1/32` alone does not exempt `localhost`.

## The ledger

One JSON object per line, with `ts`, `event`, `session`, `call` (the tool call id), and `tool`. URLs are written as host and path; the query string never is (`hasQuery` says whether there was one), because a query can carry whatever the agent was told to send.

| `event` | Written by | Fields |
|---|---|---|
| `fetch` | content guard, before a call | `url`, `hasQuery` |
| `ssrf-block` | URL guard | `phase` (`pre`/`post`), `reason` (`internal`, `lookup-failed`, `lookup-timeout`, `unparseable`, `delimited-read`, `too-many-urls`, `withheld-artifact`, `config-error`, `guard-error`), `source`, `host`, `address`, `category`, `range`, `requested` (post) |
| `domain-block` | URL guard | `phase`, `rule` (`deny`/`allow`), `source`, `host` |
| `fetched` | URL guard, after a URL read | `requested`, `finalUrl`, `via` (`[{ kind, source }]`), `method`, `withheld` |
| `block` | content guard | `source`, `pattern`, `chars` |
| `label` | content guard | `source`, `chars`, `channel`, `nonce` |
| `skip` | content guard | `source`, `reason` |

## Checking a research answer

The Day25 diagram ends with a person checking every cited source against the ledger (section D). `web-guard-report` does that:

```bash
bun ~/omp-web-guard/bin/web-guard-report.ts --session <session id> --answer answer.md
```

| Status | Meaning | Exit |
|---|---|---|
| `labelled` | read; the content guard only labelled it | 0 |
| `redirected` | read, but the content came from another host | 0, warning |
| `via-alternate` | read, but the content came from an alternate URL | 0, warning |
| `read` | fetched, with no content-guard line | 0, warning |
| `blocked` | the content guard withheld it | 1 |
| `ssrf-blocked` / `domain-blocked` | the URL guard blocked or withheld it | 1 |
| `not-read` | not in the ledger, or only a failed read | 1 |

Without `--answer` it lists every source in the ledger with its status. `--json` prints the same as JSON; `--ledger` reads another file. When a legitimate page was withheld, switch to another primary source, or read the page yourself and paste what you need; do not ask the agent to fetch the raw HTML.

## Examples

- `examples/overlay.yml`: denies `bash` and `eval`, which can fetch URLs without either guard seeing it; allows `task`; runs subagents in the foreground. omp's own settings loader reads it in the tests.
- `examples/egress.nft`: an nftables egress policy for the container or VM that runs omp. It drops the same ranges as the guard, the NAT64 and 6to4 forms of the IPv4 ranges, and IPv6 outside `2000::/3`; allows DNS to one resolver and TCP 80/443. **Untested:** it has never been loaded (no root and no user namespaces on the build machine); a test only checks that its sets match the guard's tables. This is the layer that closes what an extension cannot (see Limits).
- `examples/config.example.json`: every setting.

## Tests

```bash
bun run test
```

`bun run test` starts Bun with a temporary `HOME` and `TMPDIR`; plain `bun test` refuses to run, because the suite writes ledgers and omp state under the home directory and Bun fixes the home directory when it starts. The suite goes through omp's own extension loader and runner, uses a fake resolver, and needs no network.

The live tests run real omp with a scripted test-only model (`test/scripted-provider.ts`) against two local sites (`test/sites.ts`): `127.0.0.1` as the public site, exempted by each run's config, and `127.0.0.2` as the internal service.

```bash
WEB_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
WEB_GUARD_LIVE_OUT=/tmp/web-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` runs an installed omp instead. On omp 18.2.8: without the guards, a `302` and a markdown alternate put the internal service's marker in front of the model. With them, a direct read and a `grep` of the internal service are blocked and the service receives no request; the `302` and the alternate are withheld, and the ledger names the internal final URL and the alternate; a same-host alternate passes; the plain bait is blocked, the reworded bait is only labelled, the bait in a SearXNG search snippet is blocked; and the overlay makes `bash` fail without running it. On omp 18.4.4 and later: the label reaches the model as a developer message, the tool result keeps the original text inside the nonce boundary, and the `302` is withheld.

## To do before a public release

- **Security audit.** Not run. The threat model (OWASP LLM Top 10 and OWASP Agentic, 20 categories) was done before implementation; an independent adversarial review of the code was not.
- **Real-model runs.** Not run.
- **The egress example.** Never loaded; see Examples.
- **First CI run.** The GitHub Actions workflow has not run yet; `bun.lock` was produced offline.
- **Other omp versions.** Tested on 18.2.8 and 18.10.3 only; URL handling follows omp 18.2.8's rules.

## Limits

- **Each hop of a redirect is not checked.** omp follows redirects inside one fetch; the guard sees the URL before and the final URL after. A redirect hop into the internal service still reaches it, the live test shows that request, and only the result is withheld. A request with side effects (`GET /admin/delete`) still happens. Only the network layer, or a change to omp's fetch, stops the hop.
- **DNS can change between the check and the fetch** (DNS rebinding). The guard resolves the name, then omp resolves it again. The network layer closes this.
- **An alternate that redirects is not seen.** omp records an alternate's address in the notes, not where that request was redirected; the same holds for the `.md` twin and content negotiation.
- **`grep` and `ast_grep` get the pre-check only.** Their results carry no final URL.
- **Keyword patterns are a tripwire.** Reworded bait is only labelled; whether the model follows it depends on the model. A legitimate page that quotes an injection phrase is withheld whole.
- **The label is advice.** It marks the text as data; it cannot make a model ignore it.
- **Only these tools are inspected.** `bash`, `eval`, the browser, and MCP tools can fetch web content without either guard seeing it; the overlay denies `bash` and `eval`, and the browser and MCP are not covered.
- **Exfiltration to a public host is not blocked by default.** Without a `domainPolicy.allow` list, a model that follows an injection can put data in the query string of any public URL; the ledger records `hasQuery`.
- **Artifact tracking lasts for one omp process.** Artifacts of withheld or web results are remembered per session while omp runs.
- **The ledger is not tamper-evident.** Keep it outside the project.
- **A proxy resolves names itself.** With an HTTP proxy configured for omp, the guard's lookup and the proxy's can differ.

## Background

This package implements the omp side of the Day25 integrated sequence diagram (web content on its way to the model): the URL guard and the content guard of section C, the ledger and its check of section D, and the egress policy of item 4. Configuration names follow [pi-web-access](https://github.com/nicobailon/pi-web-access) (`allowRanges`, `domainPolicy`); the nonce boundary follows [pi-injection-guard](https://github.com/drg407/pi-injection-guard); the developer-channel label uses `additionalContext` from upstream [PR 13267](https://github.com/can1357/oh-my-pi/pull/13267). Upstream [PR 6945](https://github.com/can1357/oh-my-pi/pull/6945), a per-hop redirect check in omp's fetch, was closed without merging.

## License

[MIT](LICENSE)
