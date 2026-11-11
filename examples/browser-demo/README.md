# Syncky browser demo agent

An agent that runs only in a browser tab: a static page and one bundle, `demo.js`, built from [`src/`](src/). The hosted targets are `https://demo.syncky.app` (Syncky Health / `relay.syncky.app`), `https://demo-dev.syncky.app` (Syncky Dev / `relay-dev.syncky.app`) and `https://demo-staging.syncky.app` (Syncky β / `relay-staging.syncky.app`), where anyone can pair the matching Syncky app with it and watch end-to-end encrypted Health data arrive, without running a server. The protocol code is a browser port of [`examples/minimal-agent/agent.mjs`](../minimal-agent/agent.mjs): the same three pinned `@hpke/*` packages, WebCrypto instead of `node:crypto`, `qrcode` 1.5.4 for the pairing QR and esbuild 0.28.1 for the bundle.

**This demo stores nothing: close or reload the tab and everything is gone.** The keys, the bearer token, the pairing and every decrypted sample live in the tab's memory. The page reads and writes no cookie, `localStorage`, `sessionStorage`, IndexedDB or cache, loads nothing from a third party, has no analytics and talks only to the relay it was built for.

## What it does

1. **Start demo** generates an X25519 key pair and registers with the relay as a demo hub (`POST /v1/agents/register` with `"demo": true`).
2. It shows a version 2 HTTPS pairing link (`https://<site>/pair#v=2&…`, credentials only in the fragment) with a fresh pairing secret, its QR code and the pairing code. The phone scans the code, joins, asks its owner to pick the last group of the code and sends a `pair_proof` control envelope; the page keeps the code on screen until the proof arrives.
3. The page checks the proof against the key the phone joined with, revokes the phone on a mismatch, and otherwise sends `confirmed`.
4. It polls every 5 seconds (the relay's poll floor for demo hubs; 2 seconds while it waits for the proof), opens each `sync` envelope from the confirmed phone, lists its samples (type, time, value; at most 500 rows) and acks the page.
5. **Add 250 mL water** and **Add a 10-minute mindful session** each send one sealed `commands` envelope to the phone; its ack shows `applied` or `rejected` with the reason. The relay allows a burst of up to 60 data envelopes per agent, then about one a minute (about 60 data envelopes per hour per agent sustained), within the per-token limit of 60 requests a minute shared with polling, ACKs and heartbeats. A 429 supplies `Retry-After`; the demo asks the user to wait before trying again.
6. **End demo** leaves the hub (`DELETE /v1/members/me` with `{"purge":true}`), so the phone shows that the agent left. Closing the tab sends the same request with `keepalive`. The relay also ends the demo exactly 1 hour after it starts, regardless of activity: it revokes the agent at the cap and deletes the hub within one 5-second alarm step. A visible "Demo ends in MM:SS" countdown ticks every second. Registration returns `demo_ends_at` and `demo_remaining_s`; the page adds the relay's remaining seconds to response receipt time, so client clock skew does not change the countdown (response transit time can delay the local end). At 0:00 it enters the same ended state as End demo and drops keys, pairing, samples and commands from memory.

Supported browsers: Safari 17 or later and current Chrome, on a page served over HTTPS (WebCrypto needs a secure context). Other browsers that lack it get a "not supported" note.

## Build

```bash
npm ci
node build.mjs --relay https://relay.syncky.app         # production app
node build.mjs --relay https://relay-dev.syncky.app     # Syncky Dev
node build.mjs --relay https://relay-staging.syncky.app # Syncky β
```

`dist/` then holds `index.html`, `demo.css` and `demo.js`. The relay origin is a build constant. Pairing infers `dev.syncky.app` from `relay-dev.syncky.app`, `staging.syncky.app` from `relay-staging.syncky.app`, and `syncky.app` otherwise, including localhost. The fragment is not included in the browser's HTTP request to the pairing page. After installing, tap the link again or scan the QR code; “Open in Syncky” bridges to scheme-only apps. The low-level builder accepts an explicit legacy scheme for vector replay; normal sessions use HTTPS. The relay answers CORS only for the demo origins it is configured with, so serve `dist/` from such an origin, with a Content Security Policy like:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://relay.syncky.app; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

## Tests

`npm test` (Node 22.15 or later): the shared vectors in `protocol/test-vectors/` (`test/vectors.test.mjs`: envelopes of both kinds and the negative cases, pairing codes and proofs, HTTPS pairing links on each supported site and explicit legacy schemes), the session against an in-memory relay with a scripted phone (`test/session.test.mjs`: pairing by proof, a wrong proof, samples, writes and their acks, `Retry-After`, End demo, the hub ending on the relay, the countdown under clock skew and cleanup at 0:00), the pairing view (`test/view.test.mjs`: code visibility and QR/link cleanup across pairing phases) and the build (`test/build.test.mjs`: no storage API, no third-party URL, no inline script or style, the page's notice).

## Unsupported Health access requests

The thin agent offers generic send/inbox for `access_request` / `access_reply`; this example has no access command, decision UI, cooldown storage or scope mutation. It validates `access=request|reply` on control envelopes, mutually exclusive with `diagnostics`, and checks the authenticated inner type before safely skipping it with no reason/type/body output. Unmarked access inners, dual/malformed markers and kind/type mismatches are rejected safely. Both HPKE Auth and payload AEAD bind base AAD followed by optional `|control`, `|diagnostics=<value>` or `|access=<value>` in fixed order, without legacy fallback. The phone requires both request and largest reply to fit 4096 serialized control-envelope bytes; the thin transport bounds each envelope and callers respect the phone's request limits. Unsupported/poison controls do not block cursor advancement, ACK or later ordinary sync processing. The minimal agent's durable cursor survives reopen; the browser demo remains memory-only and reload starts a new session. Use the [thin agent access skill](../../agent/skills/syncky/SKILL.md#access-request) for explicit consent, outcomes and next-sync scope; update old endpoints rather than stripping markers.

The low-level pairing builder accepts optional `requested_scope: {request_ref, read, write}` for protocol build-vector coverage, sorting and deduplicating each list and percent-encoding compact JSON arrays after the existing fields. Both v1 and v2 and explicit legacy schemes preserve the same payload bytes. The browser demo product still pairs without requested scope: no permissions UI or response polling feature is added. Core and the full agent validate catalog/writability and the 4096-byte access envelope bounds; this builder is not a scope validator. Use the [full agent setup](../../agent/SETUP.md#5-pair-the-owners-iphone) for requested access, outcomes, effective scope and older-app fallback. The site's click bridge forwards the encoded fragment unchanged to local scheme navigation without sending it to a server.
