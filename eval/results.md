# Results

This file starts in Phase 1, before there's an LLM to evaluate, because
the Phase 1 numbers are half the argument on their own: how much a
purely deterministic pass finds and gets wrong, with zero model calls.
Phase 4 extends this with the LLM node's precision/recall/disagreement
numbers across 10 runs; until then, this section stands as the
deterministic baseline it needs to be compared against.

**Scope note, stated once here rather than repeated under every
number below:** every result in this file comes from one server, with
ten tools, written by the same person who wrote every rule being
scored against it. That's true of the schema numbers as much as the
capability ones. A clean score anywhere in this file is evidence the
rules are internally consistent with what they were built to find —
it is not evidence they generalize to a server neither person built.
Phase 3's "point it at a server I didn't write" step is the first real
test of that; even then, one server isn't a benchmark.

## Phase 1 — deterministic rules, zero model calls

**Headline: 8 findings across 10 tools, 0 model calls.**

| Mechanism | Findings | True positives | False positives | False negatives |
|---|---|---|---|---|
| `schema` | 5 | 1 | 4 | 0 |
| `capability` | 3 | 3 | 0 | 0 |
| **Total** | **8** | **4** | **4** | **0** |

### Schema rule (`rules/schema.ts`) — precision 1/5 (20%)

The rule: flag any string-typed top-level parameter with no enum
constraint, naming it `unconstrained_path` if the parameter name looks
path-like and `unconstrained_string` otherwise. This is deliberately
the naive version — no attempt to judge whether a parameter's job
requires free text.

- **True positive:** `read_document.path` — genuinely unconstrained,
  no length bound, no restriction to a known set of documents or a
  base directory. This is the one tool in the fixture built
  specifically to give this rule something real to catch.
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

### Capability chain detection (`rules/capability.ts`) — 3/3, 0 false positives

`labelTool` labels each tool from schema shape first (a closed-set
destination plus a free-text payload — the sink pattern), then tool
name (verb+noun tokens), and deliberately never from description text
for the trusted label. Chain detection over those labels reproduces
ground truth exactly: `search_notes`, `read_document`, and
`read_config_value` (three genuine sources) each pair with
`send_email_notification` (the one sink) — 3 findings, matching all
three `chain_role: source` entries in `ground-truth.yaml`, zero missed,
zero extra.

See the scope note at the top of this file — it applies to this 3/3
score as much as anywhere else. One caveat specific to this result,
narrower than that: `read_config_value`'s key is locked to four
non-secret settings, so its pair with `send_email_notification` is
"the shape that can exfiltrate data," not "confirmed exfiltration."
The other two pairs (`search_notes`, `read_document`) don't carry that
caveat — both return genuinely open-ended local content. See
`ground-truth.yaml` for the full note.

### What Phase 1 can't show yet

- **Schema rule recall is unmeasured.** One true positive in the whole
  fixture means precision is the only number this rule has produced so
  far; a second, different kind of true unconstrained parameter would
  be needed to say anything about recall.
- **No injection or LLM numbers yet.** That's Phase 2 (classify) and
  Phase 4 (the actual eval loop, 10 runs at temperature 0, compared
  against `ground-truth.yaml`'s `injection` field). This file gets a
  second section once that exists.
