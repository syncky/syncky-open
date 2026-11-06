export const URL_SCHEMES = Object.freeze(["syncky", "syncky-dev", "syncky-staging"]);

export const isUrlScheme = (value) => URL_SCHEMES.includes(value);

export function inferUrlScheme(relayUrl) {
  const host = new URL(relayUrl).hostname;
  if (host === "relay-dev.syncky.app") return "syncky-dev";
  if (host === "relay-staging.syncky.app") return "syncky-staging";
  return "syncky";
}
