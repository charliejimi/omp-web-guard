# Changelog

## [0.1.0] - 2026-10-13

### Added

- URL guard, before the call: every URL in the `path`/`paths` fields of `read`, `grep`, `ast_grep`, and `ast_edit` (delimited lists, JSON lists in a string, `www.` hosts, collapsed `http:/` schemes, `:selector` suffixes) is checked against the optional domain policy and every address its host resolves to; one internal address blocks the call unless `allowRanges` exempts it; failed or slow lookups block; at most 20 URLs per call; a `read` that names a URL among other paths is blocked.
- URL guard, after a URL `read`: the final URL and every URL in the result's notes (markdown alternate, feed alternate, `llms.txt` fallback, extracted document) are checked the same way; one internal or denied address withholds the whole result, and a later read of the artifact it was saved to is blocked.
- Address classification for IPv4 and IPv6: loopback, private, shared, link-local with cloud metadata addresses named, the IANA special-purpose ranges, IPv6 outside `2000::/3`, and IPv4 carried in IPv4-mapped, IPv4-compatible, NAT64, and 6to4 addresses.
- Content guard, ported from the Day25 article: the same five patterns, block / label / skip, and ledger lines; also for `grep`/`ast_grep` results of URLs and for later reads of a web result's artifact. The label goes into `additionalContext` (the developer channel) on omp 18.4.4 and later and in front of the text on older omp; web text sits in a boundary with a random nonce per result, with look-alike markers removed.
- One JSONL ledger for both guards (`fetch`, `fetched`, `ssrf-block`, `domain-block`, `block`, `label`, `skip`), without query strings.
- `web-guard-report`: maps the URLs a research answer cites to their ledger status and exits 1 when a citation was blocked or not read.
- `~/.config/omp-web-guard/config.json` with `ledger`, `allowRanges`, `domainPolicy`, `labelChannel`, `nonceBoundary`, and `lookupTimeoutMs`; session-start notices; an unusable config makes both guards fail closed.
- Examples: the settings overlay that denies `bash` and `eval`, an nftables egress policy (untested), and a config file with every setting.
- Tests through omp's own extension loader and runner with a fake resolver, run with a temporary HOME by `bun run test`; opt-in live tests on real omp 18.2.8 and 18.10.3 with a scripted test model and local sites.

### Not yet done

- Independent security audit: not run.
- Live runs with a real model: not run.
- The nftables example: never loaded.
- First run of the GitHub Actions workflow; `bun.lock` was produced offline.
- Tests against omp versions other than 18.2.8 and 18.10.3.
