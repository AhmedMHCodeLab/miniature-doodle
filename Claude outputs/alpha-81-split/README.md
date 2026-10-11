# ALPHA-81 split (8 Oct 2026)

Why: Oct 7 standup. Saad: one ticket = one PR = one commit. Naima: finish app
hardening first, split must-have from nice-to-have, edge cases (idempotency)
in a separate low-priority ticket.

Same code as `alpha-81-final.mbox` (11 commits), regrouped:

| Patch | Ticket | Contents |
|---|---|---|
| 1-alpha-81-must-have.patch | ALPHA-81 | item 28 is NOT in the patch (already in the working tree), plus gateway allow-list, XSS escaping, confirm-button removal, shipping webhook validation, scheduler expiry/retention/DB time, inventory DB-clock holds + 409 commit, worker re-hold + cancel email, notification template |
| 2-idempotency-key.patch | new edge-case ticket | order-service Idempotency-Key (idempotency.go + tests, migrate, outbox_test keys), dashboard sends the key |

Checks done 8 Oct: patch 1 `git apply --check` clean on the working tree
(origin/main 90ad23c + item 28 uncommitted); 1 then 2 apply cleanly in a copy.
Order-service suite passes on patch-1-only (21 pass, -race, Auckland TZ) and
with patch 2 (29 pass). Other services unchanged from the tested 11-commit series.
Retention without patch 2: the idempotency_keys rule logs "table missing" and continues.

Apply (repo root):
    git apply "Claude outputs/alpha-81-split/1-alpha-81-must-have.patch"
    # run suites
    git add services/
    git commit -F "Claude outputs/alpha-81-split/1-commit-msg.txt"
    git branch -m alpha-81-must-have && git push -u origin alpha-81-must-have
    git switch -c alpha-NNN-idempotency-key
    git apply "Claude outputs/alpha-81-split/2-idempotency-key.patch"
    git add services/ && git commit -F "Claude outputs/alpha-81-split/2-commit-msg.txt"
    git push -u origin alpha-NNN-idempotency-key   # PR after PR 1 merges

Dev "reserved doesn't update": in the deployed code reserved goes +q on reserve
and -q on commit seconds later, so 0 is expected after a successful order (stock
drops instead). If orders stay pending -> worker/SQS on dev. If confirmed but
reserved stays up -> worker logs "commit stock". Dev was unreachable from Claude 8 Oct.
