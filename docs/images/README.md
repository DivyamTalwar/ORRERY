# README images

The root `README.md` references three files in this directory. Add them before
announcing the repository, or GitHub renders a broken-image icon in the first screen.

| file | where it appears | what it has to communicate |
|---|---|---|
| `constellation.png` | end of "The four bodies" | four bodies, four jobs, four exact pins — and that the parent is the centre they orbit, not a fifth worker |
| `flow.png` | top of "The flow" | one delegation end to end: route, implement, prove the routing, parent re-verifies, fresh read-only review, accept |
| `refusal.png` | end of "What it will not do" | the difference between an accepted run and a stopped one, in the tool's own output |

Whatever aesthetic you choose, four things must survive it:

1. **Every model id must be legible** at the width GitHub renders, roughly 850px.
   `gpt-6-astra` is a GPT-6 id sitting beside three 5.6 ids; if a reader cannot
   read that difference, the image has lost the one detail most likely to be
   copied wrong.
2. **Astra and Terra must never look concurrent.** They are mutually exclusive per
   delegation. Any layout that puts them side by side as simultaneous workers
   teaches the opposite of what the system does.
3. **The parent must not look like a fourth worker.** It is the centre: it routes,
   it re-runs verification, and it accepts. Work flows out from it and evidence
   flows back to it.
4. **The refusal must read as a deliberate stop, not a crash.** A refused run is
   the product working. If `refusal.png` looks like an error screen, it argues
   against the thing it is there to prove.
