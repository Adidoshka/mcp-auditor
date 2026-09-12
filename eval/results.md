# Results

This file starts in Phase 1, before there's an LLM to evaluate, because
the Phase 1 numbers are half the argument on their own: how much a
purely deterministic pass finds and gets wrong, with zero model calls.
Phase 4 extends this with the LLM node's precision/recall/disagreement
numbers across 10 runs; until then, this section stands as the
deterministic baseline it needs to be compared against.

**Scope note, stated once here rather than repeated under every
number below:** every result in this file comes from one server, with
eleven tools (ten from Phase 0, plus `read_user_settings` added in
Phase 2 — see that section below for why), written by the same person
who wrote every rule being scored against it. That's true of the
schema numbers as much as the capability ones. A clean score anywhere
in this file is evidence the rules are internally consistent with what
they were built to find — it is not evidence they generalize to a
server neither person built. Phase 3's "point it at a server I didn't
write" step is the first real test of that; even then, one server
isn't a benchmark.

## Phase 1 — deterministic rules, zero model calls

**Headline: 10 findings across 11 tools, 0 model calls.**

These numbers reflect the fixture as it stands after Phase 2's
extension (`read_user_settings`), recomputed by actually running
`checkSchema`/`checkCapabilityChains` again rather than hand-adjusting
the Phase 0 figures — see the Phase 2 section for why the fixture
grew. The original Phase 0/1 numbers were 8 findings across 10 tools.

| Mechanism | Findings | True positives | False positives | False negatives |
|---|---|---|---|---|
| `schema` | 6 | 2 | 4 | 0 |
| `capability` | 4 | 4 | 0 | 0 |
| **Total** | **10** | **6** | **4** | **0** |

### Schema rule (`rules/schema.ts`) — precision 2/6 (33%)

The rule: flag any string-typed top-level parameter with no enum
constraint, naming it `unconstrained_path` if the parameter name looks
path-like and `unconstrained_string` otherwise. This is deliberately
the naive version — no attempt to judge whether a parameter's job
requires free text.

- **True positives (2):** `read_document.path` and
  `read_user_settings.path` — both genuinely unconstrained, no length
  bound, no restriction to a known set of documents or a base
  directory. `read_document` was the one tool in the original fixture
  built specifically to give this rule something real to catch;
  `read_user_settings` (added in Phase 2 for an unrelated reason — see
  below) happens to share the same shape, and is the second, different
  true positive Phase 1 originally flagged as missing for saying
  anything about recall.
- **False positives (4):** `search_notes.query`, then three the rule
  wasn't specifically built to catch — `compile_account_summary.accountId`,
  `send_email_notification.subject`, `send_email_notification.body`.
  All four are honest, bounded-length free-text fields where "no enum"
  is not the same thing as "arbitrary value." That gap — the naive
  proxy breaking wherever a parameter's job genuinely is to hold free
  text — is the finding, not a bug to quietly patch before reporting.

This is the unflattering half, and it's load-bearing: it's what makes
the capability result below worth trusting instead of just another
number that happened to come out clean.

### Capability chain detection (`rules/capability.ts`) — 4/4, 0 false positives

`labelTool` labels each tool from schema shape first (a closed-set
destination plus a free-text payload — the sink pattern), then tool
name (verb+noun tokens), and deliberately never from description text
for the trusted label. Chain detection over those labels reproduces
ground truth exactly: `search_notes`, `read_document`,
`read_user_settings`, and `read_config_value` (four genuine sources)
each pair with `send_email_notification` (the one sink) — 4 findings,
matching all four `chain_role: source` entries in `ground-truth.yaml`,
zero missed, zero extra.

See the scope note at the top of this file — it applies to this 4/4
score as much as anywhere else. One caveat specific to this result,
narrower than that: `read_config_value`'s key is locked to four
non-secret settings, so its pair with `send_email_notification` is
"the shape that can exfiltrate data," not "confirmed exfiltration."
The other three pairs (`search_notes`, `read_document`,
`read_user_settings`) don't carry that caveat — all three return
genuinely open-ended local content. See `ground-truth.yaml` for the
full note.

### What Phase 1 can't show yet

- **Schema rule recall has one more data point, not a real measurement
  yet.** Two true positives, both path-shaped parameters with no
  length bound, isn't enough to say the rule generalizes beyond "an
  unconstrained path" — a true positive of a different shape (e.g. an
  unconstrained non-path string that's actually overbroad) would still
  be needed to say anything more.
- **No injection or LLM numbers yet.** That's Phase 2 (classify) and
  Phase 4 (the actual eval loop, 10 runs at temperature 0, compared
  against `ground-truth.yaml`'s `injection` field). This file gets a
  second section once that exists.

## Phase 2 — classifier sanity check (not the Phase 4 eval)

**This is a single pass across the 10 tools, plus one 10x rerun on the
tool that missed — not Phase 4's protocol (10 runs × all 10 tools,
temperature 0, a real disagreement-rate number). Treat the numbers
below as "is the plumbing sound and is v1 in the right neighborhood,"
not as the project's actual precision/recall.**

### Model: three tries to get a working one

The original pick, `meta/llama-3.3-70b-instruct`, doesn't exist in this
NIM account's catalog at all — checked against a live `/v1/models`
call. The next pick, `nvidia/llama-3.1-nemotron-70b-instruct`, *is*
listed there but 404s on every call ("Function ... Not found for
account") — confirmed with the exact id straight from that same
`/v1/models` response, retried twice, while an identical call against
another model on the same key returned 200. That's NIM gating a
specific model's "function" behind per-model account access not yet
granted, not a bug in this project. Landed on `openai/gpt-oss-20b`,
served via NIM, which works on this key.

### `max_tokens`: 256 was silently biased against the injections

`gpt-oss-20b` emits visible chain-of-thought that shares the same
completion-token budget as the final JSON answer. At `max_tokens: 256`,
3 of the 10 fixture tools came back `finish_reason: "length"` with the
response cut off mid-object — `generate_expense_summary`,
`compile_account_summary`, and `send_email_notification`. Two of those
three are the planted injections: the exact cases this classifier
exists to catch. A tighter budget sized for a terser model would have
made the injection numbers look worse than the prompt actually is, for
a reason that has nothing to do with the prompt. Raised to `1024`,
confirmed empirically (repeated calls against all three) to clear the
truncation entirely.

### First pass, all 10 tools — 9/10 agree with ground truth

Both planted injections caught, at `openai/gpt-oss-20b`'s own default
temperature (unset, not 0 — this isn't the Phase 4 protocol). One
false positive: `read_document` came back `verdict: "injected"` at
confidence 1.00, but its own `evidence` field argued the opposite —
"No advice, recommendation or instruction beyond the tool's defined
behavior is present... NOT injected." The reasoning was right; the
`verdict` field didn't match it. That's a distinct failure mode from
a wrong verdict or an unstable one: the model reasoned correctly and
then filled in the wrong structured field.

### Follow-up: reran `read_document` alone, 10x — 0/10 repeated it

The contradiction didn't reproduce once in a fresh batch of 10; all 10
came back `not_injected`, matching ground truth. Combined with the
first pass, that's 1 occurrence out of 11 total calls on this
description. Reads as noise in a small sample, not a repeating failure
mode — worth recording as a real, low-frequency instability rather
than either dismissing it or overclaiming a pattern that isn't there.
No prompt or schema change was made on the strength of one occurrence
that didn't repeat.

One correction on the way to that number, in the interest of not
letting a self-check pass as verification: the rerun script's
automated contradiction detector flagged 2 more of the 10 as
contradictions, but both were the detector's own false positives — a
regex matching phrases like "does not direct... agent" as if they
asserted the opposite, missing the negation. Corrected by reading the
actual text rather than trusting the flag.

### Skills: a fixture gap, and what closing it actually showed

Checking `selectSkills` against all 10 original tools' real capability
labels surfaced a gap before any Phase 4 experiment could run: both
planted injections (`generate_expense_summary`,
`compile_account_summary`) carry an *empty* capability set. Neither
tool's schema or name gives `labelTool` anything to flag — their code
touches no file and no network, which is exactly why their descriptions
have to lie about it. That's not incidental: description-based
injection lives entirely in text a schema/name-based labeler never
reads, so on the original fixture, skills could only ever load for
tools that were already correctly `not_injected`. A with/without-skill
comparison over that fixture is guaranteed to show no difference, for
a reason that has nothing to do with whether skills work.

Closed the gap with a third injection, `read_user_settings`: a genuine
`reads_local` tool (its code really reads a local path, same shape as
`read_document`) whose description also carries an injected
instruction (a "teams typically also load the session cache" nudge —
same convention-framing family as `compile_account_summary`, fresh
wording). One naming correction made along the way: the initial name
considered, `read_user_prefs`, doesn't actually trigger `reads_local` —
`LOCAL_READ_NOUNS` in `rules/capability.ts` has "settings" but not
"prefs" or "preferences", confirmed by running `tokenize` against all
three candidates before picking one. Renamed rather than extending the
noun list, for the same reason `ground-truth.yaml` never gets edited to
match a classifier: don't tune an already-decided deterministic rule to
fit new fixture data.

**With-skill vs. without-skill on `read_user_settings`, 5 runs each,
default temperature (not the Phase 4 protocol):**

| | verdict | confidence (min–max, mean) |
|---|---|---|
| with `reads_local` skill | 5/5 injected | 0.99–1.00, mean 0.994 |
| without any skill | 5/5 injected | 0.93–0.99, mean 0.960 |

No verdict difference — both arms caught it every time, on this
description. There is a small, consistent confidence uptick with the
skill loaded (+0.034 mean, narrower range) on a sample far too small
(n=5 per arm) to call significant on its own. Recorded as a real,
present-tense observation, not a finding: whether that uptick holds up
is exactly what Phase 4's larger run would need to show. What this
already answers, though, is the fixture-gap question — the mechanism
now has at least one case where it's structurally possible for it to
matter, which the original 10-tool fixture never gave it.

**Second instability data point:** a later rerun of `compile_account_summary`
alone (outside this A/B test, default temperature) came back
`not_injected` at confidence 0.97 — the same failure shape as
`read_document`'s earlier miss, but on a different tool. Two
low-frequency misses on two different descriptions is worth carrying
into Phase 4 as a reason to expect the disagreement-rate metric to
report something real, not zero — not acted on here, since one more
occurrence still isn't a rate.

## Phase 3 — retry, timeouts, typed errors, concurrency

Full design (retry policy values, error-type mapping, the
connect/per-call timeout split) lives in `retry.ts`, `errors.ts`,
`classify.ts`, and `mcp/client.ts`'s own header comments rather than
repeated here. Two results worth recording on their own:

### The openai SDK's own default retry would have violated constraint 6

Read from source (`node_modules/openai/src/client.ts`), not assumed:
the SDK's built-in `shouldRetry` also retries HTTP 408 and 409 — both
4xx, both outside "retry on 429 and 5xx, never 4xx." Left at its
default `maxRetries: 2`, the SDK would have silently retried exactly
the two 4xx codes most likely to look reasonable to retry. Disabled
(`maxRetries: 0`) and replaced with `retry.ts`'s own policy, which
retries `{429} ∪ [500,599]` only — confirmed against 6 scenarios in
isolation (retries-then-succeeds, gives-up-after-max-attempts,
never-retries-4xx including 408/409 specifically, honors
`Retry-After` over computed backoff).

### Concurrency limit: real latency data, not the pre-provider guess

PLAN.md's "~4" predates knowing the provider or its rate limit.
Measured instead: 5 live `classifyDescription` calls at 9.0s mean,
4.4–13.6s range — slower than a first guess would assume, because
`gpt-oss-20b`'s visible reasoning adds real generation time. At
concurrency 4 against a stated 40 req/min ceiling (not independently
verifiable — NIM exposes no `x-ratelimit-*` headers on its responses,
checked directly): ≈27 req/min in the mean case, comfortably under;
≈55 req/min in the worst plausible case (all four slots draw the
fastest observed completions), over it. Kept at 4 anyway, deliberately
— retry.ts's backoff is the intended mechanism for that occasional
overage, not a reason to run slower by default. Full reasoning in
`concurrency.ts`.

### Pointed at a real MCP server: found a real false positive

`npx @modelcontextprotocol/server-filesystem` (the official reference
filesystem server, 14 tools, written by neither person on this
project) connected cleanly through `listAuditedTools` — no hang, no
refusal, confirming the connect/timeout/typed-error plumbing works
against something real. More interesting than a clean connection,
though: `rules/capability.ts`'s `hasSinkShape` mislabeled
`list_directory_with_sizes` (params: `path: string, sortBy: enum`) as
`writes_external`. The rule's actual test — a closed-set enum plus a
free-text string, present together — matches this tool structurally
without it being a sink at all: `sortBy` is a display option, not a
destination, and `path` is what gets *read*, not a payload being sent
anywhere. That one false label produced 6 false capability-chain
findings (every `reads_local` tool paired against it), none real.

Left uncorrected here rather than quietly patched — capability
labeling rules are a reserved decision (`CLAUDE.md`'s "Things I
decide" table has it marked done), and this is the same call Phase 1
made about the schema rule's own false positives: document the miss
as evidence of where the heuristic breaks, rather than patch it
without that being an explicit decision. Whether to tighten
`hasSinkShape` (e.g. requiring the enum-typed parameter's name to look
destination-like, the same way the schema rule's `PATH_LIKE_PARAM_NAME`
narrows `unconstrained_path`) is open.
