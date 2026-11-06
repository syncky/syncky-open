export const diagnosticsFixture = () => ({
  "v": 1,
  "type": "diagnostics",
  "archive_ref": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "request_ref": null,
  "generated_at": "2026-11-03T12:00:00Z",
  "window_start": "2026-11-01T12:00:00Z",
  "window_end": "2026-11-03T12:00:00Z",
  "checks": {
    "checked_at": "2026-11-03T12:00:00Z",
    "relay_state": "missing",
    "findings": []
  },
  "app": {
    "version": "1.0",
    "build": "1",
    "os": "26.0",
    "channel": "dev"
  },
  "pairing": {
    "status": "unavailable"
  },
  "connections": [],
  "ledger_counts": {
    "status": "unavailable"
  },
  "events": [],
  "relay_summary": {
    "status": "not_collected",
    "reason": null,
    "http_status": null,
    "is_stale": false,
    "phone_last_contact_source": "unknown",
    "agent_activity": [],
    "pending": null,
    "as_of": null,
    "history_since": null,
    "phone_last_contact_at": null,
    "local_last_relay_exchange_at": null,
    "local_last_run_at": null,
    "local_last_run_source": "unknown",
    "local_last_run_as_of": "2026-11-03T12:00:00Z",
    "push_sends": null
  },
  "truncation": {
    "store_expired": 0,
    "store_evicted": 0,
    "archive_events": 0,
    "archive_expired": 0,
    "connections": 0,
    "findings": 0,
    "push_sends": 0,
    "available_history_start": "2026-11-03T12:00:00Z",
    "history_status": "available"
  }
});
