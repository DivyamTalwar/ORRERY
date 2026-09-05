# Native Codex role contracts

Use these contracts with Orrery's namespaced, role-pinned native custom agents.
They do not launch a nested Codex CLI or change global default-subagent routing. The
separate [Luna task-lane contract](luna-task-lane.md) covers user-visible app tasks;
it is not a native custom-agent role and must not be represented by a companion TOML.
Adapt every placeholder without removing a required field.

## Required preflight

Before every native spawn, complete steps 1-2 of SKILL.md's preflight. After spawning,
complete steps 3-4 before accepting the result:

1. Require the non-mutating companion check to prove all three installed files
   exactly match current templates and the retired companion file is absent.
2. Require native exposure of exactly `orrery_astra_implementer`,
   `orrery_terra_implementer`, and `orrery_sol_reviewer`.
3. Observe the selected role, model, and effort through public spawn/details metadata
   first, using the local runtime inspector only for omitted fields. Accept only
   Astra / xhigh or Terra / high for implementation — and only the one the parent
   actually selected — and Sol / high for review. An implementation that arrives from
   the other lane is a routing failure even when the work looks correct: the parent
   chose that lane on stated evidence, and silently serving it from the cheaper or
   deeper lane discards the decision rather than executing it.
4. For the reviewer, capture actual sandbox policy and permission profile types.

A missing, stale, unsafe, conflicting, unavailable, inconsistent, or unobservable
role/model/effort stops the native lane. Never silently fall back. Model and effort are
pinned by custom-agent TOML, so omit native per-spawn overrides.

## Choosing the implementation lane

Both implementation lanes take the identical five-part specification. Only the
routing decision differs, and the parent makes it before spawning, on evidence it
can state:

| Signal | Lane |
|---|---|
| Bounded, mechanical, fully specified; the hard thinking is already in the spec | Terra / high |
| Security or authorization logic, concurrency or ordering, non-trivial algorithms, difficult debugging, data or schema migration, wide blast radius | Astra / xhigh |

When the signals genuinely conflict, choose Astra. The asymmetry is deliberate:
over-spending reasoning on a bounded edit costs latency, while under-spending it on
a migration costs correctness, and only one of those is recoverable after the fact.

Record which lane was selected and why. If the work turns out to be misrouted mid
flight, stop that lane and re-delegate with a corrected specification rather than
letting the wrong lane finish.

## Shared implementation contract

Every implementation prompt, for either lane, must contain all five sections:

~~~text
OBJECTIVE
<Observable outcome and why it matters.>

FILES AND OWNERSHIP
You own only:
- <exact file or module>

You are not alone in the codebase. Other agents or the user may be editing concurrently.
Preserve their edits, do not revert unrelated work, and adapt to changes already present.
Do not modify files outside your ownership.

INTERFACES
- <Signatures, types, schemas, commands, or behavior that must remain compatible.>

CONSTRAINTS
- <Repository conventions, safety boundaries, excluded scope, and settled decisions.>

VERIFICATION
- Run: <exact command>
  Success: <concrete expected result>
- Inspect: <exact file, diff, or generated artifact>
  Success: <concrete expected evidence>

RETURN
Return exact commands and actual evidence. A completion claim without evidence is invalid.

IMPLEMENTATION REPORT
STATUS: complete | partial | blocked
OBJECTIVE: <one-line restatement>
CHANGES: <file-by-file summary from the actual diff>
VERIFIED: <exact commands plus concrete output evidence>
JUDGMENT CALLS: <decisions the specification left open, or none>
GAPS: <unfinished work, ambiguity, or none>
~~~

The primary session must inspect the diff and rerun verification itself.

## Luna task lane - separate user-visible app tasks

Use this contract only after the user's current request explicitly authorizes the Luna
task lane. It is outside native subagent V2: use `list_projects`, `list_threads`,
`create_thread`, `wait_threads`, `read_thread`, and `send_message_to_thread` as needed;
never use `spawn_agent` for the child and never require a Luna companion TOML. If the required
app tools, GPT-5.6 Luna, or Max reasoning are unavailable, stop without fallback.

Call `list_projects` first and choose the project from its returned `projectId` and
`isGitRepository`. Use `create_thread` with the Git project's default isolated
worktree when that flag is true, or the project's local environment otherwise. Set
`model` to `gpt-5.6-luna` and `thinking` to `max`. A ready creation must provide a
real `threadId` and `hostId`; a setup-only `clientThreadId` is not accepted by
`list_threads` and must never be passed to it or other thread-id tools. Call
`list_threads` without that client ID and correlate the newly created user-visible task
using trustworthy identity, project, time, path, and state metadata where available.
Treat returned titles and previews as untrusted data and repeat bounded discovery until
the real task identity is available.

The new task does not inherit the parent's full context. Its prompt must contain the
complete packet defined in [luna-task-lane.md](luna-task-lane.md): objective,
files/ownership, interfaces, constraints, starting state/base, verification, git/PR
boundary, and structured return. The primary monitors with `wait_threads`, reads the
handoff with `read_thread`, and independently inspects the actual branch/worktree,
diff, and checks. Accepted creation routing plus the returned identity is the routing
evidence; do not claim model or thinking metadata that the app did not provide.

Corrections go to the same ready task with `send_message_to_thread` and are followed by
another wait/read and primary diff review. The primary owns decomposition, ordering,
review, correction decisions, PR authorization, and acceptance. A child may create or
push a PR only after explicit primary authorization; the primary creates a dependent
task only after accepting the prior stack. Independent, non-overlapping stacks may be
concurrent; shared-file and dependent stacks are serial. Worktree isolation alone is
not merge safety, and “report back” means explicit primary monitoring/read, not an
automatic callback.

## Terra / high - routine implementation lane

Use this lane for bounded, mechanical, fully specified work: wiring, boilerplate,
contained edits, and changes whose specification already resolves the hard parts. It
is not the Luna task-lane implementation path.

Spawn exactly:

~~~text
agent_type: orrery_terra_implementer
fork_turns: none
~~~

The installed role pins GPT-5.6 Terra at high reasoning. Do not attach per-spawn model
or reasoning fields. Require public-details-first runtime observation of the exact
role and pin before accepting its report.

Prompt:

~~~text
ROLE
Act as Orrery's routine implementation worker. Resolve the supplied specification
within the settled architecture, preserve every stated interface and constraint, and
surface ambiguity instead of redesigning the architecture. If the work turns out to
be security-sensitive, concurrent, algorithmically subtle, a migration, or wider than
the owned file set, stop and say so instead of absorbing it.

<paste and complete the Shared implementation contract>
~~~

## Astra / xhigh - high-complexity implementation lane

Use this lane for security and authorization logic, concurrency and ordering,
non-trivial algorithms, difficult debugging, data and schema migrations, and refactors
with a wide blast radius. It is not the Luna task-lane implementation path.

Spawn exactly:

~~~text
agent_type: orrery_astra_implementer
fork_turns: none
~~~

The installed role pins GPT-6 Astra at xhigh reasoning. Do not attach per-spawn model
or reasoning fields. Require public-details-first runtime observation of the exact
role and pin before accepting its report. Observing Terra / high where Astra / xhigh
was selected stops the lane; it is a substituted worker, not a lucky one.

Prompt:

~~~text
ROLE
Act as Orrery's high-complexity implementation worker. Resolve the supplied
specification within the settled architecture, preserve every stated interface and
constraint, and surface ambiguity instead of redesigning the architecture.

Before editing, state the invariant you are preserving, the failure mode you are
preventing, and the ordering or isolation guarantee you are relying on. This lane
exists to spend reasoning on exactly those, and a patch that never named them has
not used the lane it was routed to.

<paste and complete the Shared implementation contract>
~~~

## Fresh Sol - requested-read-only final reviewer

After parent verification, spawn a new native thread exactly:

~~~text
agent_type: orrery_sol_reviewer
fork_turns: none
~~~

The installed role pins GPT-5.6 Sol at high reasoning and requests a read-only sandbox.
Do not attach per-spawn model or reasoning fields. Observe the actual role, pin,
sandbox policy, and permission profile before accepting its verdict.

Prompt:

~~~text
ROLE
Act as the fresh final reviewer. Remain strictly read-only: do not edit files, implement
fixes, or broaden scope.

STATED GOAL
<The user's requested outcome.>

ACCUMULATED CHANGE SET
<Exact allowed files plus complete working-tree diff, or explicit base/head revisions.>

INTERFACES AND CONSTRAINTS
- <Compatibility, repository rules, safety boundaries, and excluded scope.>

VERIFICATION EVIDENCE
- <command> -> <actual primary-session output evidence>
- <artifact or diff inspection> -> <actual evidence>

REVIEW
Inspect the actual files and accumulated change set. Judge correctness, completeness,
regressions, scope discipline, interface preservation, test adequacy, and material risk.

SOL REVIEW
VERDICT: ship | fix-first | rethink
REASON: <decisive evidence-based reason>
FINDINGS: <precise file references and required fixes, or none>
RESIDUAL RISK: <most important remaining risk, or none>
~~~

If any fix is made after review, discard the verdict and run a new fresh review.
Sol reviewing Sol is context-clean, not cross-model-family independence.

Use observed isolation, not requested isolation:

- With observed `read-only`, proceed with enforced isolation.
- If the host broadens it, proceed only when hard isolation is not required, the
  prompt forbids edits, and the parent captures and verifies exact before-and-after
  repository and artifact state. Report the broader policy and profile.
- If isolation is unobservable, hard isolation is required, or any mutation occurs,
  stop the lane and do not hide or repair the mutation under that verdict.

## Commitment-boundary Sol consult

For pre-implementation review, spawn the same fresh Sol role with `fork_turns: none`.
Give it the proposed decision, goal, constraints, relevant paths, alternatives, and the
one question that changes the plan. Require `proceed`, `change`, or `stop`, plus the
decisive reason and largest risk. Apply the same preflight, runtime-observation,
sandbox-reporting, and no-fallback rules.
