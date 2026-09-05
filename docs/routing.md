# Routing

Orrery has two implementation lanes. This page is about choosing between them,
and about what happens when the choice turns out to be wrong.

It is deliberately short. Routing is not a configuration surface — it is one
decision the parent makes per delegation, on evidence it can state.

## The decision

| Signal in the work | Lane |
|---|---|
| Bounded, mechanical, fully specified. The specification already resolves the hard parts. | **Terra** · `gpt-5.6-terra` · `high` |
| Security or authorization logic | **Astra** · `gpt-6-astra` · `xhigh` |
| Concurrency, ordering, or isolation | **Astra** |
| Non-trivial algorithms | **Astra** |
| Difficult debugging, where the cause is not yet known | **Astra** |
| Data or schema migration | **Astra** |
| Wide blast radius — many callers, a public interface, or a shared file set | **Astra** |

One Astra signal is enough. The signals are not weighted against each other and
they are not counted.

## Ties break toward Astra

When the signals genuinely conflict, choose Astra.

The asymmetry is deliberate and it is not about capability. Over-spending
reasoning on a bounded edit costs latency. Under-spending it on a migration costs
correctness. Only the first is recoverable after the fact — you notice a slow lane
immediately, and you may not notice a subtly wrong migration until it has run.

This is also why routing is not a cost control. Selecting the cheaper lane for
work that shows an Astra signal is not a saving; it is an unpriced risk.

## Routing is checked, not requested

The parent selects a lane before spawning. Before it accepts the result, it
observes the actual model and effort the run used — through public spawn/details
metadata first, falling back to the local runtime inspector only for fields the
host omits.

If the parent selected Astra and observes Terra, **the lane stops.** That holds
even when the work looks correct. The selection was made on stated evidence, and
quietly accepting the other lane discards the decision instead of executing it —
which means the next identical task gets routed on a belief that has already been
falsified once.

Missing, inconsistent, unavailable, or unobservable routing stops the lane the
same way. There is no fallback and no substitution.

## When the route was wrong

Misrouting is normal. Work reveals its own difficulty.

- **Terra escalates.** Its role prompt requires it to stop and say so if the work
  turns out to be security-sensitive, concurrent, algorithmically subtle, a
  migration, or wider than its owned file set, rather than absorbing it.
- **The parent re-routes rather than retries.** A corrected specification aimed at
  the same wrong lane fails the same way. Re-delegate to the other lane with the
  corrected specification.
- **Astra-lane work always meets a fresh reviewer.** The lane is selected precisely
  when the blast radius is wide, so a commitment-boundary Sol consult applies
  before the parent accepts it.

## What each lane is asked to produce

Both lanes receive the identical five-part specification: objective, file
ownership, interfaces, constraints, verification. Only the routing differs.

The prompts differ in one place each, and both differences are about failure:

- **Terra** must stop and escalate rather than quietly absorb work above its lane.
- **Astra** must state the invariant it is preserving, the failure mode it is
  preventing, and the ordering or isolation guarantee it is relying on, *before*
  it edits. A confident patch that never named those has not used the reasoning
  budget the lane exists to spend, and should not be accepted as Astra-lane work
  merely because it compiles.

## The other two bodies

Neither is an implementation lane and neither is ever a fallback.

- **Sol** · `gpt-5.6-sol` · `high` · requested read-only — the fresh final review.
  Returns exactly `ship`, `fix-first`, or `rethink`. It never implements its own
  fixes. A Sol-on-Sol review is context-clean, not model-family-independent.
- **Luna** · `gpt-5.6-luna` · `max` — the user-visible Codex app-task lane. It is
  activated only by explicit authorization in the current request, uses app task
  tools rather than a native agent file, and has no custom-agent TOML. If Luna,
  Max, or a required app tool is unavailable, it stops without falling back to a
  native lane.

## See also

- [Role contracts](https://github.com/DivyamTalwar/ORRERY/blob/main/plugins/orrery/skills/orchestration/references/role-contracts.md) — the exact spawn packets and the five-part specification.
- [Luna task lane](https://github.com/DivyamTalwar/ORRERY/blob/main/plugins/orrery/skills/orchestration/references/luna-task-lane.md) — the opt-in app-task contract.
- [Compatibility evidence](compatibility.md) — what each host can actually enforce.
