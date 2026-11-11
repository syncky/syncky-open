import { qrSvg } from "./qr.mjs";
import { DemoSession, WRITES } from "./session.mjs";
import { pairView } from "./view.mjs";

const RELAY = __SYNCKY_RELAY__;

const $ = (id) => document.getElementById(id);
const text = (id, value) => {
  $(id).textContent = value;
};
const show = (id, visible) => {
  $(id).hidden = !visible;
};

function supported(scope = globalThis) {
  return !!(scope.isSecureContext && scope.crypto?.subtle && typeof scope.crypto.getRandomValues === "function" && typeof Object.hasOwn === "function" && typeof Array.prototype.at === "function");
}

const PHASES = {
  idle: "Not started",
  starting: "Registering with the relay…",
  pairing: "Waiting for an iPhone to scan the code",
  joined: "iPhone joined. Pick the code shown below on the iPhone.",
  confirmed: "Paired: data shows below as the iPhone syncs",
  expired: "The pairing code expired",
  phone_left: "The iPhone left",
  ending: "Leaving the demo hub…",
  leave_failed: "Could not leave the demo hub",
  ended: "Ended",
  error: "Stopped",
};

const COMMAND_STATES = { pending: "sending…", sent: "sent, waiting for the iPhone", uncertain: "delivery unconfirmed, waiting for the iPhone", applied: "applied", rejected: "rejected", expired: "expired on the relay", not_sent: "not sent" };

let lastUri = null;

function render(state) {
  const pair = pairView(state);
  text("countdown", state.countdown ?? "");
  text("phase", PHASES[state.phase] ?? state.phase);
  text("hub", state.hubId ?? "none yet");
  text("hub-state", state.hubState ?? "not yet available");
  text("phone", state.phone ? `${state.phone.name} (${state.phone.id})` : "none");
  text("notice", state.notice ?? "");
  text("error", state.error ?? "");
  show("start", state.phase === "idle");
  show("pair", pair.showPair);
  show("pair-title", pair.showQr);
  show("qr", pair.showQr);
  show("pair-link", pair.showLink);
  text("code", pair.code);
  show("again", state.phase === "expired" || state.phase === "phone_left");
  show("live", state.phase !== "idle");
  show("end-button", !["ended", "error"].includes(state.phase));
  show("writes", state.phase === "confirmed");
  if (pair.uri && pair.uri !== lastUri) {
    lastUri = pair.uri;
    $("qr").replaceChildren(qrSvg(document, pair.uri, "Pairing code for the Syncky app"));
    $("link").href = pair.uri;
    text("link", pair.uri);
  }
  if (!pair.uri) {
    lastUri = null;
    $("qr").replaceChildren();
    $("link").href = "#";
    text("link", "pairing link");
  }
  $("commands").replaceChildren(
    ...state.commands.map((c) => {
      const li = document.createElement("li");
      li.textContent = `${c.label}: ${COMMAND_STATES[c.state] ?? c.state}${c.reason ? ` (${c.reason})` : ""}`;
      li.dataset.state = c.state;
      return li;
    }),
  );
  text("count", String(state.samples.length));
  $("samples").replaceChildren(
    ...state.samples.map((s) => {
      const tr = document.createElement("tr");
      for (const value of [s.type, s.time, s.value]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }),
  );
}

function main() {
  if (!supported()) {
    show("unsupported", true);
    show("start", false);
    return;
  }
  const session = new DemoSession({ relay: RELAY, onChange: render });
  render(session.state);
  $("start-button").addEventListener("click", () => session.start());
  $("again-button").addEventListener("click", () => session.pairAgain());
  $("end-button").addEventListener("click", () => session.end());
  for (const kind of Object.keys(WRITES)) $(`write-${kind}`).addEventListener("click", () => session.write(kind));
  addEventListener("pagehide", () => session.leaveOnUnload());
  // A page restored from the back-forward cache already left its hub on pagehide.
  addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
}

if (typeof document !== "undefined") main();
