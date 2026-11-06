# Syncky minimal server

The smallest complete server for the Syncky iPhone app's direct connections ("Server or automation"), written to be read and copied: one file, [`server.mjs`](server.mjs) (at most 400 lines, Node ≥ 22.15, no dependencies, only `node:*` modules). It accepts all four formats (Syncky JSON, Health Auto Export JSON, CSV, InfluxDB line protocol), checks bearer, Basic or custom-header auth and the `X-Syncky-Signature` HMAC, deduplicates samples, answers the app's Check connection, replies with signed Health write commands and records the results the app sends back. Its tests replay the shared vectors in [`protocol/test-vectors/`](../../protocol/test-vectors/). It stores the received health data in clear in its data directory and is a teaching example, not a hardened service; whoever runs it is responsible for that data (see https://syncky.app/privacy for what the app and the relay do).

## Run

```bash
./server.mjs init                                  # ./syncky-data with a token and an hmac secret (files, mode 600)
./server.mjs serve --bind 0.0.0.0                  # listen on port 3000 for the phone on the same network
./server.mjs link --host "$(scutil --get LocalHostName).local"   # the setup link for the iPhone
```

Open the link on the iPhone (Connections › **+** › Paste a setup link) or show it as a QR code with any QR tool, for example `qrencode -t ansiutf8 "<link>"`. The link carries the token and the HMAC secret: share it only with the phone. On a plain `http://` address the app accepts write commands only when they are signed, so keep the `hmac` file.

## Commands and options

| Command | What it does |
| --- | --- |
| `init` | creates the data dir (mode 700) and the files `token` (`srv_…`) and `hmac` (`whsec_…`), mode 600; existing files are kept |
| `serve [--port 3000] [--bind 127.0.0.1]` | accepts `POST` on any path, `GET /health` answers `200` |
| `link [--host <name>.local] [--port 3000] [--format native\|hae\|csv\|influx] [--name <name>] [--url-scheme syncky\|syncky-dev\|syncky-staging]` | prints the setup link for `http://<host>:<port>/syncky`, with signing on when an HMAC secret exists; scheme defaults to `syncky` |
| `write <type> <value> <unit> [--at <rfc3339>]` | queues a HealthKit write (`c_<n>`, version 1) for the next reply, for example `write dietary_water 0.25 L`; a negative value needs `--` before the type: `write -- water_temperature -1 degC` |
| `delete <command_id>` | queues the deletion of what that write created (the same id, version + 1) |
| `status` | prints counts only: stored samples, deletions, inbox files, queued commands, results |

Every command takes `--data <dir>` (default `./syncky-data`). `serve` and `link` take `--auth none|bearer|basic|header` (default `bearer`), `--user <name>` for Basic and `--header <Name>` for a custom header such as `X-Api-Key`. Secrets never come from flags: `SYNCKY_SERVER_TOKEN` and `SYNCKY_SERVER_HMAC` override the `token` and `hmac` files. Without an HMAC secret (no `hmac` file, no variable) requests are not checked for a signature and replies are not signed. Exit codes: 0 ok, 1 runtime error, 2 bad arguments.

For `link` only, choose `syncky` (Syncky), `syncky-dev` (Syncky Dev) or `syncky-staging` (Syncky β). Selection order is `--url-scheme` → `SYNCKY_URL_SCHEME` → optional `<data>/config.json` key `url_scheme` → `syncky`. The receiver hostname never selects an environment. Values must be exactly one of these three bare lowercase schemes. A missing config file, an absent or null key, and an empty environment variable are unset; an empty flag or config string is invalid. Malformed config or an invalid selected value exits 2 with a fixed message. Other commands ignore this environment variable and config file; the flag is accepted only by `link`.

```bash
./server.mjs link --host box.local --url-scheme syncky-dev
SYNCKY_URL_SCHEME=syncky-staging ./server.mjs link --host box.local
```

An optional `syncky-data/config.json` can contain `{"url_scheme":"syncky-dev"}`. The file must contain a JSON object; no config command is needed. The link scheme selects which installed build opens a tap; webhook setup links can be scanned or pasted into any build.

## What it does with a request

1. `GET /health` is `200`, any other `GET` `404`, any method but `POST` `405`. A body above 1,000,000 bytes is `413`.
2. Auth first, then the HMAC: `X-Syncky-Signature` must equal `v1=` and the lowercase hex HMAC-SHA256 of `<X-Syncky-Timestamp>.<raw body>` (the key is the whole `whsec_…` string), compared in constant time, with the timestamp within 300 s of the server clock. A missing or wrong token or signature is `401`.
3. `X-Syncky-Kind: results` appends each new `(command_id, version)` result to `results.jsonl`. A command is done once a result for its latest version arrives.
4. Otherwise by `X-Syncky-Format`. Check-connection probes store nothing: native with `delivery.test: true`, Health Auto Export with only empty arrays, CSV with the header row only, InfluxDB with an empty body. Syncky JSON samples go to `samples.jsonl` (one line each, with the sending `device`), deduplicated by `(device, uuid[, part])`; characteristics and `activity_summary` are replaced by a newer value; `deleted` entries remove the stored sample and go to `deleted.jsonl`. Health Auto Export, CSV and InfluxDB bodies are stored as they came, in `inbox/<X-Syncky-Delivery>.json|csv|lp`.
5. `200`. For a data request the reply carries the queued commands that have no result yet, oldest first, as many as fit in 60,000 bytes: `application/json` `{"v":1,"type":"commands","commands":[…]}`, signed `t=<unix>,v1=<hex HMAC of "<X-Syncky-Delivery>.<t>.<raw reply>">` when an HMAC secret is set. Commands stay queued until their result arrives, so a reply lost on the way is sent again; the app applies a repeated `(command_id, version)` only once. With nothing to send, and for probes and results requests, the reply body is empty.

Native chosen-period resends add `delivery.resend: true`; this receiver accepts the extra metadata and uses the same UUID/part deduplication and mutable-record replacement. Normal deliveries and probes omit the field. Delivery indices/counts cover each delivery call, so one chosen-period resend can have several independent batches. HAE, CSV and Influx have no resend marker; their repeated bodies remain separate inbox files under each request id. See [the delivery contract](../../protocol/server.md#deliveries-and-batching) for failure and cancellation behavior.

The log is one stdout line per request: time, kind (`data`, `test`, `results`, `get`, `other`), format, counts and status. It never shows a secret, a header value, a signature, a body, a sample value or a URL.

`server.mjs` is also a module: `createServer({ dir, port, bind, auth, user, header, token, hmac, now, log })`, `verifySignature`, `signReply` and `buildLink(destination, secrets, urlScheme = "syncky")` are exported, and the CLI runs only when the file is started directly.

## Tests

`npm test` (`node --test 'test/*.test.js'`). The tests read only `../../protocol/test-vectors/`:

- `vectors.test.js`: every request of `webhook-requests.json` is accepted with the vector's auth, secret and clock and stored as its `report` counts; replaying a native resend twice preserves UUID deduplication; every `webhook-signatures.json` case gives its verdict; `signReply` reproduces every valid reply signature of `webhook-exchanges.json`; queued writes, the results request and a delete give the vector reply bodies and signatures byte for byte; Check-connection probes store nothing; `buildLink` gives every vector `link`.
- `server.test.js`: `401`, `413`, `404`, `405` and `400` cases, duplicates and deletions, restarts, signed replies checked with an independent HMAC, a lost reply repeated until its result, a delete replacing an undelivered write, and a backlog of 500 writes drained with no reply above 60,000 bytes.
- `cli.test.js`: `init`, `link`, `write`, `delete`, `status` and argument errors (secret flags are rejected).
- `url-scheme.test.js`: all three builder/CLI schemes, precedence, optional config, fixed errors without input disclosure, and receiver-host independence. Local Dev/Staging cases in `vectors.test.js` replay unchanged requests before those schemes appear in shared vectors.
- `secrecy.test.js`: after a `serve` run its output, `results.jsonl` and `outbox.jsonl` hold no token, secret, signature, body or URL; the secret files are mode 600.
- `size.test.js`: the 400-line cap, the shebang, `node:*` imports only, and tests that read nothing outside the package but the vectors.

Native history may include a separate `summaries` array. This example accepts and ignores it while preserving raw sample handling; it does not store daily quantity summaries. Choose raw history when using this server for complete quantity coverage. A receiver that supports summaries must replace by `(device, type, unit, start, end, stat)`, never add a resent value. See the [summary contract and compatibility rules](../../protocol/server.md#daily-quantity-summaries-in-native-history).

History delivery defaults to two years and may span many calls. A native request's `more`, `delivery.index` and `delivery.count` describe one call, not all days. Raw counts exclude daily summaries; signed body bytes include both. Manual restart after failure uses the last fully completed day and can repeat an unfinished day, so keep UUID/part deduplication and summary replacement keys. The app has finite server background time. Local export instead requires the foreground, shares only a finished document and recreates the whole original file after cancellation or failure. HAE/CSV history always uses raw quantities. See [full-depth periods and local files](../../protocol/server.md#full-depth-periods-and-local-files).
