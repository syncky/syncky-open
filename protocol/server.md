# Build a server for Syncky Health

Syncky Health is an iPhone app. It can send Apple Health data straight from the iPhone to an HTTP server you run: a home server, an automation tool or your own code. This guide describes everything that server sees and everything it may answer. It is written for a person and for an AI agent that builds the server.

> **For AI agents.** Build the receiver from sections 3 to 8. Add section 9 if the server should print a setup link, and sections 10 and 11 if it should write data back into Apple Health. Section 14 has recipes for the app's templates, and section 15 is the final checklist. The vector files in [`test-vectors/`](test-vectors/) are the source of truth: [`webhook-requests.json`](test-vectors/webhook-requests.json) (real requests in every format with their headers, secrets and setup link), [`webhook-exchanges.json`](test-vectors/webhook-exchanges.json) (replies, the results request and the Check connection request) and [`webhook-signatures.json`](test-vectors/webhook-signatures.json) (signature checks). Every example below is copied from those files. When this text and a vector disagree, the vector wins. Test your server by replaying the vectors with their secrets and clock.

The quickest start is the example server in [`examples/minimal-server`](../examples/minimal-server/README.md). It is one file with no dependencies, it implements every section of this guide, and its tests replay the same vectors.

For native storage and OAuth-protected remote MCP on Worker or Docker, follow the [own-server recipe](../examples/own-server/README.md).

## 1. What you are building

The app calls your server a **server** (in the data, a destination with an id like `wh_…`). Your server:

1. accepts `POST` requests with a JSON, CSV or InfluxDB line protocol body;
2. checks the token and, if signing is on, an HMAC signature;
3. answers `2xx` quickly;
4. optionally answers with **commands** that the app writes into Apple Health, and then receives a **results** request that says what happened.

Nothing passes through Syncky's own servers on this route. One iPhone can have several servers. Each server belongs to one iPhone; there is no shared account.

What that means for responsibility: the server receives the user's health data in clear. HTTPS protects it in transit with TLS; plain HTTP does not encrypt it, on any network. Whoever runs the server is responsible for it under the data protection law that applies to them. Syncky's privacy policy (https://syncky.app/privacy) covers the app and the relay only. Syncky is a data-transfer tool, not a medical device; what a server does with the data is its operator's choice, and nothing in this guide is medical advice.

## 2. Set up the connection on the iPhone

In the app, open Settings › Connections › **+**. Then choose one of these:

- **Server or automation**, or one of the templates under "Start from a template" (Home Assistant, InfluxDB, n8n, Node-RED, Health Auto Export server). A template fills in the format and the URL path. You add the address and the token.
- **Paste a setup link**. Your server prints a webhook setup link (default `syncky://webhook?…`) or a QR code, and the app fills in everything for review and confirmation (section 9).

Then tap **Check connection**. The app sends one test request with every header, auth and signature included, and no health data. There is no handshake or challenge step: this test is an ordinary request. Setting up and checking is free. **Free during launch; plans are coming later.** See [launch access and pricing](https://syncky.app/pricing).

The server screen also has these settings:

- **Authentication**: None, Bearer, Basic or Header. The token, password or header value stays in the iPhone Keychain.
- **Sign requests (HMAC)**: the app generates a secret and shows it once. Copy it to your server.
- **Format** and **Data types**.
- **Send deletions**: on by default.
- **Accept writes to Health**: off by default. Your server's replies can add records.

## 3. The request

Every request is a `POST` to the URL you entered. Here are the headers of a native request with Bearer auth and signing on:

<!-- vector: webhook-requests.json native_bearer_signed_every_kind request 0 headers -->
```http
Content-Type: application/json
User-Agent: Syncky/1.0
X-Syncky-Format: native
X-Syncky-Delivery: <a new UUIDv7 for every request>
X-Syncky-Destination: wh_hmf4Hk2wv-D-TUbXkl-UCA
X-Syncky-Timestamp: <unix seconds>
X-Syncky-Signature: v1=<64 lowercase hex digits>
Authorization: Bearer <token>
```

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` for native and Health Auto Export, `text/csv; charset=utf-8` for CSV, `text/plain; charset=utf-8` for InfluxDB |
| `User-Agent` | `Syncky/<app version>` |
| `X-Syncky-Format` | `native`, `hae`, `csv` or `influx`. Read the body by this header. |
| `X-Syncky-Delivery` | a new UUIDv7 for every request. Use it as a request id. |
| `X-Syncky-Destination` | the server's id in the app (`wh_…`). It names the server entry, not the iPhone. |
| `X-Syncky-Timestamp`, `X-Syncky-Signature` | only when signing is on (section 6) |
| auth | `Authorization: Bearer <token>`, `Authorization: Basic <base64(user:password)>` or your own header, for example `X-Api-Key: <value>` |

The results request (section 10) has `X-Syncky-Kind: results` instead of `X-Syncky-Format`. Header names are not case-sensitive; many servers see them in lower case.

The Health Auto Export format adds the headers that Health Auto Export servers expect. `automation-id` is the server id, and `session-id` is one id for all requests of one delivery:

<!-- vector: webhook-requests.json hae_bearer_signed_every_shape request 0 headers -->
```http
automation-name: Vector hae-every-shape
automation-id: wh_xG_XgGsxv7V7zu5FlJxMVQ
automation-aggregation: false
automation-period: Since Last Sync
session-id: <one UUIDv7 per delivery>
```

No header names the iPhone. In the native format the body's `device` field is the app's install id (`d_…`). In the other formats, give each iPhone its own server entry or its own URL path.

Rules for your URL:

- It is absolute and starts with `https://` or `http://`. It has no user name, no password and no `#` fragment. A query string is allowed. All syntactically valid HTTP hosts are accepted; URL, port, length and credential validation still applies.
- HTTP has no warning for `localhost`, `*.local`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fe80::/10`, `fc00::/7`, `100.64.0.0/10` and `*.ts.net`. Every other HTTP host shows: "Health data will travel unencrypted over the internet. Use https:// if your server supports it." HTTPS never shows this warning. An exemption does not mean HTTP encrypts data.
- The warning stays under the URL field and on the saved server's detail screen. A new or changed public-HTTP URL needs one explicit confirmation before saving, testing or syncing, including when Check connection or Sync now saves the draft. An unchanged saved URL does not ask again; changing the scheme, port, path or query can require a new confirmation. Setup-link import uses the same warning and confirmation. Cancelling leaves it unsaved and sends nothing.
- The app does not follow redirects. Answer at the URL itself.
- Use a certificate the iPhone trusts. Self-signed and private certificates are not covered by this guide.

Bodies are never compressed.

### Deliveries and batching

A normal sync uses one **delivery** to your server. A large delivery is split into several requests. Each body is at most 1,000,000 bytes. Requests are sent one after another, and the first failure stops the delivery. During normal syncing, data that did not get a `2xx` is sent again next time.

A chosen-period resend is a one-off upload using the saved format and normal packing, without changing incremental sync anchors. It can span several deliveries; `delivery.index`, `delivery.count` and `more` describe only one delivery call, not the whole period. Cancellation takes effect between batches after an in-flight delivery finishes; failure stops further batches and keeps normal backoff. Already accepted data stays delivered. A failed, cancelled or interrupted resend does not automatically retry the whole chosen period; normal incremental syncing continues separately.

Only native bodies identify this operation with `delivery.resend: true`, included in byte limits before packing and in the signed body. Normal deliveries and Check connection omit it. HAE, CSV and Influx bodies and headers are unchanged, so receivers of those formats cannot identify a resend from a special marker. Export files have no `delivery` metadata.

Delivery is **at least once**. You will see repeats, so store samples by key:

- a sample: `(device, uuid)`;
- a part of a workout route or heartbeat series: `(device, uuid, part)`;
- a characteristic (`characteristic:<name>`) and an `activity_summary` day: replace the stored value.

### Daily quantity summaries in native history

Native history requests may add a top-level `summaries` array. Each object contains `type`, `unit`, `start`, `end`, `stat` and `value`. The type is a known quantity and the unit is its canonical unit in [types.json](types.json), including its percent convention. `stat` is `sum` for cumulative quantities or `avg` for discrete quantities; HealthKit computes the daily sum or average. A reported zero is retained; empty days produce no record. The start and end are UTC instants for calendar-day boundaries in the user's captured time zone, so a day can span 23 or 25 hours.

For example, `native_history_summary_only_signed` in [webhook-requests.json](test-vectors/webhook-requests.json) carries this summary:

<!-- vector: webhook-requests.json native_history_summary_only_signed request 0 excerpt -->
```json
{"type":"steps","unit":"count","start":"2024-01-01T00:00:00Z","end":"2024-01-02T00:00:00Z","stat":"sum","value":100}
```

Replace summaries by `(device, type, unit, start, end, stat)` on receipt. A repeated summary replaces the prior value; never add its value to the stored one. Summaries have no UUID or source and are distinct from raw samples and raw `activity_summary` objects. Syncky JSON files use the same array without a device field; consumers supply file/device provenance externally.

Each summary is packed and signed with the body under the same byte limit. A request can have empty `samples` and nonempty `summaries`. Raw sample counts exclude summaries; accepted-summary counts are separate and include only successful requests. `delivery.index`, `delivery.count` and `more` still describe the requests in one delivery call, including summary-only requests, rather than remaining days. Normal sync and Check connection omit the array. HAE, CSV and Influx history use raw quantities only; summaries are native-only and never travel through relay or agent sync.

Older receivers may ignore this additive field and continue handling raw samples, but then lose the older quantity coverage represented by summaries. Choose raw history for those receivers. There is no capability negotiation; the example server currently ignores summaries and keeps its existing raw store.

### Full-depth periods and local files

The direct-server and file pickers default to two calendar years and allow an earlier From without an app history-depth floor. **Free during launch; plans are coming later.** See [launch access and pricing](https://syncky.app/pricing). Agent replay and incremental sync keep their history-window limits. Full history never goes through relay or agents.

Mixed native history keeps the last 90 calendar days raw, relative to confirmation time in the captured time zone. Older complete quantity days use summaries; partial boundary days and quantities crossing the summary-span boundary stay whole and raw without overlapping summary coverage. Workouts, sleep, other categories, characteristics, raw activity summaries and series retain their raw forms across the whole period. HAE, CSV and Influx always collect quantities raw. An empty readable day advances progress without inventing zero summaries; an empty query does not prove read permission.

Server progress counts accepted raw objects, separate accepted summaries, attempted requests and actual body bytes. Unmappable Health data and invalid daily quantity values are skipped and counted as dropped; file exports count them as left out. These omissions and reported omissions for unsupported non-native kinds allow later days. Collection/query, delivery validation, conversion, packing and command-result failures stop the operation. Days and current-day batches are distinct. After failure/cancellation/relaunch, a user may manually restart at the last fully completed day after the existing one-hour end-based cool-down. Original end, time zone, cutoff and collection bounds remain fixed. An unfinished day may be delivered twice, including after a receiver accepted data just before interruption, so replacement/deduplication keys remain essential. There is no automatic history scheduler. Server background time is finite; keep Syncky open for a long period.

Local files use the same native summary semantics, or raw HAE/CSV. They preserve metric grouping and complete series, contain no device/delivery/deletions, and CSV contains one header with escaped/formula-protected CRLF rows. CSV rows may appear in day-stream order rather than global type order; compare parsed row multisets. Raw-object counts exclude native summary records and framed series parts are not extra logical raw objects. File counts describe rendered content, rather than receiver acceptance. Native/HAE content type is `application/json`; CSV is `text/csv; charset=utf-8`.

Files are read and rendered one calendar day at a time into protected streams, then assembled and atomically made available for sharing only when complete. Large exports have no 16 MiB import-size restriction. The working set includes one raw day and complete routes/series, so a dense day or route can still be large. Keep the app in the foreground: leaving it cancels local export. Failure/cancellation discards the working output; Retry recreates the whole original period, since no completed prefix was shared. Working files are removed on every exit and at relaunch, and finished share copies are removed when sharing closes.

## 4. Body formats

### Syncky JSON (native, recommended)

The body is one JSON object:

- `v` is `1` and `type` is `"sync"`;
- `device` is the install id;
- `samples` holds the new samples, and `deleted` the deleted ones (section 7);
- `acks` is always empty;
- `more` is `true` on every request of a delivery except the last;
- `delivery` has `destination`, `id` (equal to `X-Syncky-Delivery`), `index`, `count` and `sent_at`, plus `"test": true` on the Check connection request or `"resend": true` on every request of a native chosen-period resend. Both flags are omitted when false and never appear together.

Times are RFC 3339 in UTC. A quantity value is in the type's unit from [`types.json`](types.json). Percent types are fractions from 0 to 1 with the unit `%`. These samples come from one real request:

<!-- vector: webhook-requests.json native_bearer_signed_every_kind request 0 excerpt -->
```json
{"uuid": "5E1D0000-0000-4000-8000-000000000001", "type": "steps", "value": 412, "unit": "count",
 "start": "2026-10-14T07:01:00Z", "end": "2026-10-14T07:01:59Z",
 "source": {"app": "com.apple.Health", "device": "Apple Watch"}}
```

A category sample carries the value's name:

<!-- vector: webhook-requests.json native_bearer_signed_every_kind request 0 excerpt -->
```json
{"uuid": "51EE0000-0000-4000-8000-000000000001", "type": "sleep_analysis", "value": "asleep_core",
 "start": "2026-10-13T23:10:00Z", "end": "2026-10-14T00:40:00Z",
 "source": {"app": "com.apple.Health", "device": "Apple Watch"}}
```

A workout:

<!-- vector: webhook-requests.json native_bearer_signed_every_kind request 0 excerpt -->
```json
{"uuid": "0B6F0000-0000-4000-8000-000000000001", "type": "workout", "activity": "running",
 "start": "2026-10-14T05:00:00Z", "end": "2026-10-14T05:31:10Z", "duration_s": 1870,
 "energy_kcal": 312.4, "distance_m": 5020, "location": "unknown",
 "metadata": {}, "events": [], "activities": [], "statistics": [],
 "source": {"app": "com.apple.Health", "device": "Apple Watch"}}
```

A characteristic has a fixed uuid, so a new value replaces the old one:

<!-- vector: webhook-requests.json native_bearer_signed_every_kind request 0 excerpt -->
```json
{"uuid": "characteristic:blood_type", "type": "characteristic", "name": "blood_type", "value": "a_positive"}
```

The other kinds are `state_of_mind`, `gad7_assessment`, `phq9_assessment`, `audiogram`, `activity_summary`, `workout_route` and `heartbeat_series`. Routes and heartbeat series can be large, so they come in parts. Each part has `part` (from 0) and `parts`. A set is complete when every part is there and the joined points match `count`:

<!-- vector: webhook-requests.json native_all_kinds request 0 excerpt -->
```json
{"uuid": "0E0B0000-0000-4000-8000-000000000001", "type": "heartbeat_series",
 "start": "2026-10-14T06:00:00Z", "end": "2026-10-14T06:01:00Z", "count": 6, "part": 0, "parts": 1,
 "beats": [[0, 0], [842, 0], [1677, 0], [2519, 1], [3350, 0], [4188, 0]],
 "source": {"app": "com.apple.Health", "device": "Apple Watch"}}
```

The parts of one set can arrive in different requests. [`series-parts.json`](test-vectors/series-parts.json) shows how to join them. The schema of the whole body is `$defs/sync` in [`schemas/inner-sync.schema.json`](schemas/inner-sync.schema.json). The `native_*` cases of [`webhook-requests.json`](test-vectors/webhook-requests.json) hold complete bodies of every kind.

### Health Auto Export JSON

This is the body of Health Auto Export's "REST API" automation, so a server written for that app can take it: `{"data":{"metrics":[…],"workouts":[…]}}`. The arrays `stateOfMind` and `symptoms` appear only when they are not empty. Metric names follow Health Auto Export, not the Syncky type names (`steps` becomes `step_count`). Dates look like `2026-10-14 09:01:03 +0200`. Percent values are multiplied by 100. One metric:

<!-- vector: webhook-requests.json hae_bearer_signed_every_shape request 0 excerpt -->
```json
{"name": "heart_rate", "units": "count/min",
 "data": [{"date": "2026-10-14 09:01:03 +0200", "Min": 64, "Avg": 64, "Max": 64, "source": "Apple Watch"}]}
```

One workout:

<!-- vector: webhook-requests.json hae_bearer_signed_every_shape request 0 excerpt -->
```json
{"id": "0B6F0000-0000-4000-8000-000000000001", "name": "Running",
 "start": "2026-10-14 07:00:00 +0200", "end": "2026-10-14 07:31:10 +0200", "duration": 1870,
 "activeEnergyBurned": {"qty": 312.4, "units": "kcal"}, "distance": {"qty": 5.02, "units": "km"}}
```

This format has no deletions, no characteristics and no `delivery` object. Types without a Health Auto Export name are not sent. A workout can come again later with its `route`, so store workouts by `id`. The `hae_*` cases of [`webhook-requests.json`](test-vectors/webhook-requests.json) show every shape and name. This format has not been checked against a live Health Auto Export receiver.

### CSV

RFC 4180 with CRLF line ends. Every request starts with the same header row. A field with a comma, a quote or a line break is quoted. A time is RFC 3339 in the sample's own time zone when the iPhone knows it, else in UTC. These lines come from one real body:

<!-- vector: webhook-requests.json csv_basic_signed_every_kind request 0 excerpt -->
```csv
type,uuid,start,end,value,unit,value_name,source,device,user_entered
steps,5E1D0000-0000-4000-8000-000000000001,2026-10-14T09:01:00+02:00,2026-10-14T09:01:59+02:00,412,count,,com.apple.Health,Apple Watch,false
sleep_analysis,51EE0000-0000-4000-8000-000000000001,2026-10-14T01:10:00+02:00,2026-10-14T02:40:00+02:00,3,,asleep_core,com.apple.Health,Apple Watch,false
workout,0B6F0000-0000-4000-8000-000000000001,2026-10-14T07:00:00+02:00,2026-10-14T07:31:10+02:00,1870,s,running,com.apple.Health,Apple Watch,false
characteristic,characteristic:blood_type,,,1,,a_positive,,,
steps,5E1D0000-0000-4000-8000-000000000099,,,,,deleted,,,
```

- A quantity row has `value` and `unit`.
- A category row has the numeric HealthKit value in `value` and its name in `value_name`.
- A workout row has the duration in seconds in `value`, the unit `s` and the activity in `value_name`.
- A characteristic row has no times. `value` is the numeric value and `value_name` its name; a date characteristic puts the date in `value`.
- A deletion row has only `type`, `uuid` and `value_name` `deleted`.
- `source` is the app that saved the sample and `device` the device. When either starts with `=`, `+`, `-`, `@`, a tab or a CR, it gets a leading `'`, so a spreadsheet does not run it as a formula.
- `user_entered` is `true` or `false`.

State of mind, assessments, audiograms, activity summaries, routes and heartbeat series are not sent in CSV.

### InfluxDB line protocol

One line per sample, each ending in LF. The measurement is the type name. The tags are `unit`, `source` and `device`, sorted, and empty tags are left out. The timestamp is the sample's start in nanoseconds. These lines come from one real body:

<!-- vector: webhook-requests.json influx_bearer_signed_every_kind request 0 excerpt -->
```text
steps,device=Apple\ Watch,source=com.apple.Health,unit=count value=412 1791961260000000000
sleep_analysis,device=Apple\ Watch,source=com.apple.Health value=3,value_name="asleep_core" 1791933000000000000
workout,activity=running,device=Apple\ Watch,source=com.apple.Health duration_s=1870,energy_kcal=312.4,distance_m=5020 1791954000000000000
```

- A quantity has the field `value`.
- A category has `value` (the numeric HealthKit value) and the string field `value_name`.
- A workout has the tag `activity` and the fields `duration_s` and, when known, `energy_kcal` and `distance_m`.
- Spaces, commas and `=` in tags are escaped with `\`. Tabs and line breaks become spaces.

Deletions, characteristics and the other kinds are not sent in line protocol.

### The Check connection request

**Check connection** sends the format's body with no data. Your server should answer it like any request: check the auth and the signature, store nothing, answer `2xx`. The app does not read the reply. This is the complete native request:

<!-- vector: webhook-exchanges.json test_native headers -->
```http
Content-Type: application/json
User-Agent: Syncky/1.0
X-Syncky-Format: native
X-Syncky-Delivery: 01a1393a-8960-7b26-8ec7-5d0493cc3337
X-Syncky-Destination: wh_hmf4Hk2wv-D-TUbXkl-UCA
X-Syncky-Timestamp: 1791961500
X-Syncky-Signature: v1=b5d4f350a4455a39d6e89cfb3e24d4b96fa4a47b7437b985fd8e8ad26c1baf3c
Authorization: Bearer vec_token_N_2Y13AA1iajwMKegGliR7uA-JPcykkrnx_oquTiDU0
```

<!-- vector: webhook-exchanges.json test_native body -->
```json
{"v":1,"type":"sync","device":"d_zsOZnTQUz_juWFVljuOOBQ","samples":[],"deleted":[],"acks":[],"more":false,"delivery":{"destination":"wh_hmf4Hk2wv-D-TUbXkl-UCA","id":"01a1393a-8960-7b26-8ec7-5d0493cc3337","index":0,"count":1,"sent_at":"2026-10-14T07:05:00Z","test":true}}
```

Health Auto Export:

<!-- vector: webhook-exchanges.json test_hae body -->
```json
{"data":{"metrics":[],"workouts":[]}}
```

CSV, the header row alone (one line ending in CRLF):

<!-- vector: webhook-exchanges.json test_csv body -->
```csv
type,uuid,start,end,value,unit,value_name,source,device,user_entered
```

InfluxDB line protocol, an empty body:

<!-- vector: webhook-exchanges.json test_influx body -->
```text
```

## 5. Data types and units

Type names are short snake-case names, for example `steps`, `heart_rate`, `dietary_water` and `body_mass`. They match `^[a-z][a-z0-9_]{1,63}$`. The HealthKit identifier of each type is in `types.json` as `hk`.

- [`types.json`](types.json) lists every type: its kind, its HealthKit identifier, its unit, whether it can be written, its bounds and its category values. It also lists the workout activities and the characteristics.
- [`units.json`](units.json) lists the unit families and how to convert between units.
- [`healthkit-inventory.md`](healthkit-inventory.md) describes every HealthKit data kind in plain words.

The lists grow with new app versions. Do not hard-code them, and accept type names you do not know yet.

## 6. Authentication and signatures

The app supports four kinds of auth: none, Bearer, Basic and a custom header. Compare the token in constant time.

Turn on **Sign requests (HMAC)** for any server that can be reached from the internet. The app generates the secret: `whsec_` followed by 43 base64url characters. You can also put your own secret in the setup link (section 9).

Check every signed request like this:

1. Take the raw body bytes, before any JSON parsing.
2. Compute HMAC-SHA256 with the key = the whole `whsec_…` string as UTF-8, over `X-Syncky-Timestamp` + `.` + the raw body.
3. Write it as `v1=` and 64 lowercase hex digits.
4. Compare it with the whole `X-Syncky-Signature` value in constant time.
5. Accept only if the timestamp is within 300 seconds of your clock.

Uppercase hex, a `v0=` prefix, a missing `v1=` and a body changed by one byte must all fail. There is no nonce, and `X-Syncky-Delivery` is not covered by the signature. If you need replay protection inside the 300-second window, keep the `X-Syncky-Signature` values of the last 300 seconds and reject a repeat: every attempt, retries included, is signed again with a new timestamp.

A worked example: the Check connection request in section 4 was signed with the secret `whsec_mgHtkTuuLB_wsJa221vi031K8GmN9QbtPNq_RV8uD8c`. Your check must accept it with the clock at `1791961500` and reject it when one byte changes.

The same check in Node, with the reply signer of section 10:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const hmacHex = (secret, prefix, body) => createHmac("sha256", Buffer.from(secret, "utf8")).update(prefix).update(body).digest("hex");

export function verifyRequest(headers, rawBody, secret, now = Math.floor(Date.now() / 1000)) {
  const timestamp = headers["x-syncky-timestamp"];
  const signature = headers["x-syncky-signature"];
  if (typeof timestamp !== "string" || !/^[0-9]{1,15}$/.test(timestamp) || typeof signature !== "string") return false;
  const expected = Buffer.from(`v1=${hmacHex(secret, `${timestamp}.`, rawBody)}`, "utf8");
  const given = Buffer.from(signature, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected) && Math.abs(now - Number(timestamp)) <= 300;
}

export function signReply(secret, delivery, t, replyBody) {
  return `t=${t},v1=${hmacHex(secret, `${delivery}.${t}.`, replyBody)}`;
}
```

`rawBody` is a `Buffer` with the exact bytes you received. In Express, for example, use `express.raw({ type: "*/*" })` instead of `express.json()` on this route. [`webhook-signatures.json`](test-vectors/webhook-signatures.json) has a case for every rule above.

## 7. Deletions

When a sample is deleted in Apple Health, the app tells your server, unless **Send deletions** is off.

- Native: an entry in `deleted` with the sample's `uuid` and `type`. Remove what you stored under `(device, uuid)`, all parts included.
- CSV: a row with `value_name` `deleted`.
- Health Auto Export and InfluxDB line protocol: deletions are not sent.

<!-- vector: webhook-requests.json native_bearer_signed_every_kind request 0 excerpt -->
```json
{"uuid": "5E1D0000-0000-4000-8000-000000000099", "type": "steps"}
```

A deletion can name a sample you never stored, for example one deleted before it was sent. Ignore it.

## 8. Responses, retries and limits

| Your answer | Code | What the app does |
| --- | --- | --- |
| `2xx` | none | The request counts as delivered. The body is read only for write-back (section 10). |
| `3xx` | `redirect` | Failure. Redirects are never followed. |
| `401` or `403` | `auth_failed` | Failure. |
| `413` | `payload_too_large` | Failure. The app halves the body limit for this server, down to 65,536 bytes, and the next attempt uses it. |
| `429` | `rate_limited` | Failure. |
| any other `4xx` | `http_4xx` | Failure. |
| `5xx` | `http_5xx` | Failure. |
| no answer in time | `timeout` | Failure. |
| no connection (DNS, TCP, TLS) | `network` | Failure. |

After a failure the app waits before it tries again. **Sync now** ignores the wait. A success resets it. The app shows the server as *Retrying* with the last error. Answer `2xx` as soon as the body is stored, and do slow work later.

| Limit | Value |
| --- | --- |
| Servers per iPhone | 50 |
| Server name | 64 characters |
| URL | 2048 characters |
| Token, password or header value | 4096 bytes |
| Custom header name | 256 characters |
| Basic user | 256 characters, printable ASCII, no colon |
| Request body | 1,000,000 bytes at first; each `413` halves it, down to 65,536 bytes |
| Request timeout | 30 s |
| Reply the app reads | 65,536 bytes; a longer reply is ignored |
| Signature window | 300 s each way, for requests and for replies |
| Backoff after a failure | 30 s, 2 min, 10 min, 1 h, then every hour |

A custom header cannot be `Host`, `Content-Type`, `Content-Length`, `User-Agent`, `Authorization`, `Transfer-Encoding`, `Upgrade`, `Connection`, `Keep-Alive`, `TE`, `Trailer` or any name starting with `X-Syncky-`.

## 9. Setup links

A setup link fills in the whole server entry. Your server prints it, and the user pastes it or scans it as a QR code in Settings › Connections › **+** › **Paste a setup link**.

The supported schemes are exactly `syncky` (Syncky), `syncky-dev` (Syncky Dev) and `syncky-staging` (Syncky β). Link builders default to `syncky`. In the app, paste and scan accept webhook setup links with all three schemes. For pair links to relay agents, the app refuses a link for another build. A tapped webhook setup link opens the build registered for its own scheme and shows the import review and confirmation; no server is added before you confirm.

```text
syncky://webhook?v=1&name=<pct>&url=<pct>&format=native|hae|csv|influx&auth=none|bearer|header|basic
                [&header=<name>][&user=<pct>][&token=<pct>][&hmac=<whsec_…>][&types=<a,b>]
```

- `<pct>`: percent-encode every byte outside `A-Z a-z 0-9 - . _ ~` of the UTF-8 text as `%XX`.
- `token` is the Bearer token, the header value or the Basic password. It is present exactly when `auth` is not `none`.
- `header` only with `auth=header`, `user` only with `auth=basic`.
- `hmac` turns signing on with that secret, so your server can make the secret and the app adopts it.
- `types` limits the data types, as a comma-separated list of type names.
- Unknown or repeated parameters, a fragment or a `v` other than `1` make the link invalid.
- A link cannot turn on **Accept writes to Health** or change **Send deletions**. The user sets those in the app.

A link for a custom header and two types:

`syncky://webhook?v=1&name=Vector%20header&url=https%3A%2F%2Freceiver.example%2Fhook%2Fheader&format=native&auth=header&header=X-Api-Key&token=vec_key_x9VHBdwKQo-KwlcOB9v4cwlAawCa0nF2NWQRO1qLDlI&types=heart_rate,steps`

Every case of [`webhook-requests.json`](test-vectors/webhook-requests.json) carries the `link` for its server, so you can test your encoder against them. Optional case-level `url_scheme` supplies the link builder's scheme; absent means `syncky`. It does not change request bodies or headers.

The link carries secrets and is not signed. Show it only to the iPhone's owner, best as a QR code on a local screen. The app shows the name, the host and the format for explicit confirmation before it imports. After the import it runs **Check connection** by itself.

To print a QR code in a terminal, pipe the link into a QR tool, for example with the example server:

```sh
./server.mjs link --host myserver.local | qrencode -t ansiutf8
```

## 10. Write-back: commands and results

Your server can add records to Apple Health. The app reads a reply only when:

- **Accept writes to Health** is on for the server, and the iPhone has the **Sync** plan;
- the reply answers a **data** request with `2xx`. Replies to Check connection and to the results request are not read;
- the reply is at most 65,536 bytes, has `Content-Type: application/json` and is exactly a commands message.

Commands reach the iPhone only in the reply to a data request. When the iPhone has nothing new to send, it makes no data request, and your commands wait for the next one. An empty body means no commands. A reply the app cannot use is ignored; the delivery still counts as delivered, and the server's status keeps the reason (`reply_ignored:` and `too_large`, `not_json`, `not_commands`, `unsigned` or `bad_signature`).

**Over plain HTTP the reply must be signed**, and signing must be on for the server. The reply signature differs from the request signature: it has its own time and covers the request's delivery id.

```text
X-Syncky-Signature: t=<unix seconds>,v1=<64 lowercase hex digits of HMAC-SHA256(secret, X-Syncky-Delivery + "." + t + "." + raw reply body)>
```

The time must be within 300 seconds of the iPhone's clock. Over HTTPS the reply signature is not checked.

An example. The app sent a native request with these headers:

<!-- vector: webhook-requests.json native_bearer_signed_every_kind request 0 headers -->
```http
X-Syncky-Delivery: 01a13940-fe30-7630-9d7f-9da6e6de1e3d
X-Syncky-Timestamp: 1791961923
```

The server is at `http://receiver.local/hook/every-kind`, with the secret `whsec_mgHtkTuuLB_wsJa221vi031K8GmN9QbtPNq_RV8uD8c`. It answers with two writes:

<!-- vector: webhook-exchanges.json signed_http headers -->
```http
Content-Type: application/json
X-Syncky-Signature: t=1791961923,v1=73d9d986299402060d48ffe640a17e657067e1a9e853ccdd3136c5e74a5163f5
```

<!-- vector: webhook-exchanges.json signed_http body -->
```json
{"v":1,"type":"commands","commands":[{"command_id":"c_1","version":1,"op":"write","type":"dietary_water","value":0.25,"unit":"L","start":"2026-10-14T07:00:00Z","end":"2026-10-14T07:00:00Z"},{"command_id":"c_2","version":1,"op":"write","type":"apple_exercise_time","value":30,"unit":"min","start":"2026-10-14T07:00:00Z","end":"2026-10-14T07:00:00Z"}]}
```

The same two commands, one per line for reading:

<!-- vector: webhook-exchanges.json signed_http excerpt -->
```json
{"command_id": "c_1", "version": 1, "op": "write", "type": "dietary_water", "value": 0.25, "unit": "L",
 "start": "2026-10-14T07:00:00Z", "end": "2026-10-14T07:00:00Z"}
```

<!-- vector: webhook-exchanges.json signed_http excerpt -->
```json
{"command_id": "c_2", "version": 1, "op": "write", "type": "apple_exercise_time", "value": 30, "unit": "min",
 "start": "2026-10-14T07:00:00Z", "end": "2026-10-14T07:00:00Z"}
```

Rules for commands (schema: [`schemas/inner-commands.schema.json`](schemas/inner-commands.schema.json)):

- `command_id` matches `^[A-Za-z0-9_.:-]{1,64}$`, and `version` starts at 1.
- A quantity write has a number `value` and a `unit` from the type's unit family in [`units.json`](units.json). A category write has the value's name and no unit.
- Only quantity and category types with `"write": true` in [`types.json`](types.json) can be written, and only within the type's bounds. The user must also allow the type in the Health permission sheet.
- The same `command_id` with a higher `version` replaces the earlier command. The same or a lower version is never applied twice; when the command already has a result, the app sends that result again.
- `op: delete` with the `command_id`, a higher `version` and the `type` removes what that command wrote.
- The app writes each record with the HealthKit sync identifier `syncky:wh_<id>:<command_id>`.

`apple_exercise_time` cannot be written, so the app rejects `c_2` at once and writes `c_1`.

### Results

After it handles your commands, the app posts a results request to the same URL. It has `X-Syncky-Kind: results` and no `X-Syncky-Format`:

<!-- vector: webhook-exchanges.json results_after_signed_http headers -->
```http
Content-Type: application/json
User-Agent: Syncky/1.0
X-Syncky-Kind: results
X-Syncky-Delivery: 01a13941-7360-7ee0-91c5-e3ae2be0fb4e
X-Syncky-Destination: wh_hmf4Hk2wv-D-TUbXkl-UCA
X-Syncky-Timestamp: 1791961953
X-Syncky-Signature: v1=faf090fb6106803f7435919ab1383d8b52256a0d4b86e99d22b110a9d6e32132
Authorization: Bearer vec_token_N_2Y13AA1iajwMKegGliR7uA-JPcykkrnx_oquTiDU0
```

<!-- vector: webhook-exchanges.json results_after_signed_http body -->
```json
{"v":1,"type":"results","results":[{"command_id":"c_1","version":1,"status":"applied"},{"command_id":"c_2","version":1,"status":"rejected","reason":"type_not_allowed"}]}
```

- `status` is `applied` or `rejected`. A rejection has a `reason`: `type_not_allowed`, `value_out_of_range`, `healthkit_denied` or `invalid`.
- Check the auth and the signature as for any request, and answer `2xx`. A failure is retried on the backoff schedule of section 8.
- The results of one reply can come in one request or in several. Rejections the app decides at once come right after the delivery; writes come after Health has stored them.
- A command is done when a result for its latest version arrives. Keep sending the command until then; the app applies each version only once.
- Servers are not told when the user later deletes a record in Health.

### Deleting a written record

To remove the water entry, answer a later data request with a delete. This reply answers a data request whose `X-Syncky-Delivery` was `01a13977-ecb0-7fbd-bd2a-03d2ebe40d71`:

<!-- vector: webhook-exchanges.json signed_http_delete headers -->
```http
Content-Type: application/json
X-Syncky-Signature: t=1791965523,v1=42e6daf6d840b6ffbbb1b9e81c2f94c525743082b26f4eca1a7cec1034e68c40
```

<!-- vector: webhook-exchanges.json signed_http_delete body -->
```json
{"v":1,"type":"commands","commands":[{"command_id":"c_1","version":2,"op":"delete","type":"dietary_water"}]}
```

Its result is `c_1` with `version` 2.

Your own writes come back to you as new samples in later deliveries, like any other Health data. There is no filter for them. This has not been checked end to end.

## 11. Write-back walkthrough with the example server

This uses [`examples/minimal-server`](../examples/minimal-server/README.md) on a computer on the same Wi-Fi as the iPhone. It needs Node 22.15 or later.

1. Create the token and the signing secret, start the server, and in a second terminal print the link as a QR code:

   ```sh
   ./server.mjs init
   ./server.mjs serve --bind 0.0.0.0
   ./server.mjs link | qrencode -t ansiutf8
   ```

   `link` uses this computer's name with `.local`. Pass `--host <name>.local` to change it.
2. On the iPhone: Settings › Connections › **+** › **Paste a setup link**, scan the code and confirm. The app runs **Check connection**. The server logs a `test` request.
3. Open the new server and turn on **Accept writes to Health**.
4. Queue the two writes of section 10:

   ```sh
   ./server.mjs write dietary_water 0.25 L --at 2026-10-14T07:00:00Z
   ./server.mjs write apple_exercise_time 30 min --at 2026-10-14T07:00:00Z
   ```

5. Tap **Sync now**. The first delivery sends the history window, and the server answers it with the reply of section 10, signed over that request's delivery id. If the history was already sent, add new data first (see step 7).
6. The app rejects `c_2` and writes `c_1`, then sends the results. `./server.mjs status` now shows two results and no command waiting. The water entry is in the Health app.
7. Run `./server.mjs delete c_1` and send new data, for example by logging a glass of water in the Health app. The next reply carries the delete of section 10, and the entry is gone.

The server keeps every command until a result for its latest version arrives, so a reply lost on the way is sent again.

## 12. When data arrives

The app sends:

- when Health reports new data, collected for 2 seconds;
- on Background App Refresh;
- from a Shortcuts automation or a widget;
- when the app opens, at most once a minute;
- when the user taps **Sync now**.

Everything except **Sync now** needs the Sync plan. iOS decides when a locked iPhone wakes up, so expect bursts, not a fixed schedule. The first delivery to a new server sends the history window, the last 30 days by default.

## 13. Local network and remote access

A server at home can use plain HTTP on a local address. HTTPS is recommended for remote access; HTTP remains available for any valid host under the warning and confirmation rules in section 3.

- Names ending in `.local` are found over Bonjour on the same Wi-Fi.
- Listen on the computer's network address, not only on `127.0.0.1`, and allow the port in its firewall.
- The app checks local-network access only for LAN addresses: RFC 1918, IPv4/IPv6 link-local, `*.local` and ULA outside the Tailscale range. This applies to LAN HTTPS too. The first enabled save/import and explicit Check connection or Sync now can prompt. The iOS prompt says: "Syncky sends Health data to servers on your local network that you add."
- Loopback, overlay and public hosts skip the probe. Overlay means CGNAT `100.64.0.0/10`, `*.ts.net` and Tailscale IPv6 `fd7a:115c:a1e0::/48`. Other ULA addresses use the LAN probe. IPv4-mapped IPv6 follows its embedded IPv4 address. Classification uses the address text without a DNS lookup; a normal domain resolving to a private address is still classified as public.
- If the user said no, the app shows: "Local network access is off. Allow Syncky in Settings › Privacy & Security › Local Network." This denial stops the action and is not reported as a timeout. Check again after changing Settings. An unreachable LAN check leaves a saved server saved; Check connection stops, while Sync now proceeds to normal delivery diagnostics. Background runs do not probe and cannot distinguish a permission denial from a transport timeout.
- Away from that Wi-Fi, a LAN address needs a working route such as a VPN. Deliveries fail with `network` when unreachable and retry later. No data is lost: the app sends it again when the server answers. For Home Assistant, use the recommended Tailscale Serve setup below with the iPhone connected to the tailnet.
- On every plain-HTTP write-back path, including VPN hosts, the app requires signed replies (section 10).

## 14. Recipes

Each template in the app links to its recipe here. The details of the products below come from their documentation and are not verified by Syncky.

<a id="home-assistant"></a>
### Home Assistant

Template: format native, URL `http://homeassistant.local:8123/api/webhook/syncky-health`, auth None.

Add this automation. It logs the number of samples and skips the Check connection request:

```yaml
alias: Syncky Health
triggers:
  - trigger: webhook
    webhook_id: syncky-health
    allowed_methods: [POST]
    local_only: true
conditions:
  - condition: template
    value_template: "{{ not (trigger.json.delivery.test | default(false)) }}"
actions:
  - action: logbook.log
    data:
      name: Syncky Health
      message: "{{ trigger.json.samples | length }} samples, {{ trigger.json.deleted | length }} deletions"
```

- `trigger.json` is the parsed body (section 4). Each sample has `type`, `value` and `unit`.
- The webhook id is the only secret. A webhook trigger cannot check a token or the HMAC signature. Replace `syncky-health` with a long unpredictable webhook id in Home Assistant and the app URL. Do not publicly expose an unauthenticated Home Assistant webhook.
- For remote access, the recommended setup is Tailscale Serve on the Home Assistant host. Enable HTTPS certificates in the tailnet's DNS settings, then run:

  ```sh
  tailscale serve --bg 8123
  ```

  Keep the iPhone connected to the tailnet and enter `https://<host>.<tailnet>.ts.net/api/webhook/<id>` in Syncky. Home Assistant sees the local proxy, so keep the default `local_only` (`true`); the explicit `local_only: true` above is also suitable.
- The plain-HTTP alternative is direct access to a tailnet address in `100.64.0.0/10`, for example `http://100.119.70.126:8123/api/webhook/<id>`; only this direct-tailnet alternative needs `local_only: false`. Home Assistant does not count this direct tailnet request as local. Keep the iPhone on the tailnet and restrict access there. The absence of an HTTP warning for this address does not make HTTP itself encrypted.
- Home Assistant answers a webhook without a body, so this recipe does not write back.

Not verified by Syncky: the trigger options and the reply of Home Assistant.

<a id="influxdb"></a>
### InfluxDB

Template: format influx, URL `http://influxdb.local:8086/api/v2/write?org=home&bucket=health&precision=ns`, auth Bearer.

1. In InfluxDB 2, create the bucket `health` in the organization `home`, or change `org` and `bucket` in the URL.
2. Create an API token that can write to the bucket, and enter it as the token in the app.
3. Keep `precision=ns`: the timestamps are in nanoseconds.

- InfluxDB documents `Authorization: Token <token>`. The app sends `Authorization: Bearer <token>`, and `Authorization` cannot be set as a custom header. Whether your InfluxDB accepts `Bearer` is not verified by Syncky. If it answers `401`, put a small proxy in front that rewrites the header.
- InfluxDB does not check `X-Syncky-Signature`, so signing adds nothing here.
- Check connection sends an empty body. How InfluxDB answers it is not verified by Syncky.
- Deletions, characteristics and the other kinds are not sent (section 4).

<a id="n8n"></a>
### n8n

Template: format native, URL `https://n8n.example.net/webhook/syncky-health`, auth Header `X-Api-Key`.

1. Add a **Webhook** node: HTTP method `POST`, path `syncky-health`.
2. Set Authentication to **Header Auth**. Create a credential with the name `X-Api-Key` and a long random value. Enter the same value in the app.
3. Use the production URL (`/webhook/…`). The test URL (`/webhook-test/…`) works only while the editor listens.
4. Read the body from the node's output: `body.samples`, `body.deleted` and `body.delivery.test`.

For write-back, set the Webhook node to respond with a **Respond to Webhook** node. Respond with JSON: a commands message (section 10) with `Content-Type: application/json`. Over HTTPS the reply needs no signature. If the node answers with its default message instead, the app ignores it.

Not verified by Syncky: the n8n node names and options, and how n8n keeps the raw body for an HMAC check.

<a id="node-red"></a>
### Node-RED

Template: format native, URL `http://nodered.local:1880/syncky-health`, auth None.

Build the flow **http in** (method `POST`, URL `/syncky-health`) → **function** → **http response**. Give the function two outputs:

```js
const sync = msg.payload ?? {};
const samples = msg.req?.headers?.["x-syncky-kind"] === "results" || sync.delivery?.test || !Array.isArray(sync.samples) ? [] : sync.samples;
return [{ ...msg, statusCode: 200, payload: "" }, samples.length > 0 ? { payload: samples, device: sync.device } : null];
```

The first output answers the iPhone with an empty body. The second carries the samples to the rest of your flow.

- The **http in** node parses the JSON and does not keep the raw bytes by default. An HMAC check needs the raw bytes (section 6), so leave signing off on a trusted home network.
- Over plain HTTP, write-back needs signing on and a signed reply. The function can sign with Node's `crypto` module if your Node-RED allows modules in function nodes.

Not verified by Syncky: the Node-RED node options and the raw body.

<a id="health-auto-export"></a>
### Health Auto Export server

Template: format hae, URL `http://hae.local:3001/api/data`, auth Bearer.

Use this for a server built for Health Auto Export's "REST API" automation, for example HealthyApps' own server.

- The body and the `automation-*` and `session-id` headers follow that app (sections 3 and 4).
- If your receiver expects its key in another header, set Authentication to Header and enter that header's name.
- There are no deletions in this format.
- A workout can come again with its route later; your receiver should replace workouts by `id`.

Not verified by Syncky: this format against a live Health Auto Export receiver, and the receiver's auth.

## 15. Receiver checklist

- [ ] Accept `POST`, read `X-Syncky-Format` and parse the body by it.
- [ ] Check the token in constant time. Check the HMAC over the raw body in constant time, within 300 s.
- [ ] Answer the Check connection request with `2xx` and store nothing.
- [ ] Store samples by `(device, uuid)` and parts by `(device, uuid, part)`. Replace characteristics and activity summaries. Apply deletions.
- [ ] Answer `2xx` within a few seconds. Never redirect. Answer `413` only when the body is really too large.
- [ ] Optional: reply with commands (JSON, signed over plain HTTP), accept the results request, and keep each command until its result arrives.
- [ ] Optional: print a webhook setup link or a QR code with your URL, token and `hmac` secret; default to `syncky`, or select `syncky-dev` / `syncky-staging` (section 9).
- [ ] Replay [`webhook-requests.json`](test-vectors/webhook-requests.json), [`webhook-signatures.json`](test-vectors/webhook-signatures.json) and [`webhook-exchanges.json`](test-vectors/webhook-exchanges.json) against your server.
