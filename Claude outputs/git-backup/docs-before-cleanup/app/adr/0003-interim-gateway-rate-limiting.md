# ADR 0003: Rate limiting lives in the gateway for now

**Status:** Accepted on 24 Sep (ALPHA-73, PR #25). Reviewed on 8 Oct (ALPHA-119): the gateway limits stay, bad tokens are now counted per client IP, see "Revisit when".
**Decision in one line:** api-gateway limits requests per logged-in user and per real client IP, with a fixed 60 second window in Redis, and lets requests through if Redis is down.

## Context

The client assumptions (24 Sep) describe an ecommerce platform that has to survive bursts: evenings, weekends, Black Friday. The limiter already in `api-gateway` didn't work:

- It counted by IP and port. Every new connection gets a new port, so every connection got a fresh allowance. 150 separate requests all returned 200.
- It believed `X-Forwarded-For` from anyone, so a client could claim any IP.
- Login and register weren't limited at all.
- Counting and expiry were two separate Redis calls. A crash between them left a counter that never reset.
- If Redis was down when the gateway started, limiting stayed off until a restart.

Traefik is the planned edge but isn't running yet. Saad called rate limiting "nice to have" as long as the app works, so the fix had to be small.

## Options

| Question | Options | Chosen | Why |
|---|---|---|---|
| Where | Gateway only; Traefik at the edge | Gateway only, for now | Traefik doesn't exist yet. Per-user limits need the token, and only the gateway reads it. |
| How to count | Fixed window; token bucket | Fixed window | Simple for a first version. A token bucket would only be used if it was easy with our current libraries. |
| Redis down | Let requests through; block them | Let them through, with logs and a metric | A Redis blip shouldn't stop all orders. |

## Decision

- **Who you are:**
  - Logged in: counted by the user ID in the token, 120 per window.
  - Not logged in: counted by IP, 60 per window.
  - Login, register and the shipping webhook: counted by IP, 20 per window.
- **Real client IP:** the connecting address without the port. Forwarding headers are believed only from `TRUSTED_PROXY_CIDRS`.
- **One Redis step:** a small Lua script counts and sets the expiry together, and it also fixes counters left without an expiry. IDs are hashed, so no emails or IPs are stored in Redis.
- **Over the limit:** 429 with `Retry-After`.
- **Redis slow or down:** after 100 ms the request goes through. Logs are throttled to one line every 10 seconds, and the metric `gateway_rate_limit_decisions_total` counts every decision.
- **Settings:** every limit and the trusted proxy list come from environment variables.

## Consequences

- A fixed window allows up to double the limit in a burst that straddles the window edge.
- Many shoppers behind one office or mobile carrier IP share the login limit of 20. Watch the "limited" count before changing it.
- Every dashboard tab uses the same admin login, so they share one bucket. For now the dashboard refreshes every 30 seconds instead of 10.
- Load tests from one machine need a higher login limit in the test environment. Don't turn the limiter off.
- Small gaps are left for hardening:
  - the gateway still sets `X-Forwarded-For` to `ip:port` when forwarding;
  - requests with an invalid token aren't counted;

## How we know it works

- 10 tests, one or more per requirement, run with the race detector against real Redis.
- 22 logins from one client: 20 got 200 and 2 got 429. Before the fix, all 22 got 200.
- The metric showed 20 allowed and 2 limited.

## Revisit when

Reviewed on 8 Oct, with Traefik running on EKS behind an NLB:

- The NLB keeps the client IP (`preserve_client_ip.enabled=true`) and Traefik passes it on. `TRUSTED_PROXY_CIDRS` is the VPC range, so the gateway limits on the real client IP.
- Traefik does not limit. A Traefik limit would count per pod in memory (2 pods, so about double the number), add a second set of numbers next to the gateway's, and the Redis-backed version would make a Redis problem hit the edge as well. The gateway already limits on the real client IP, so it was left out.
- Missing or bad tokens on protected routes are counted per client IP (scope `badtoken`, 20 a minute). Only failures are counted, so real users sharing the IP are not blocked.
- Per-user limits stay in the gateway, because only it reads the token.
- The dashboard still shares one admin identity (ADR 0009). Separate staff accounts come with a user store.

Look again if the gateway itself struggles under load, or a second public entry point appears that doesn't go through the gateway.

## References

[NLB client IP preservation](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html), [AWS Well-Architected REL05-BP02, throttle requests](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_throttle_requests.html).
