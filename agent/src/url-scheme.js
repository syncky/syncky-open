export function isUrlScheme(value, relayHost) {
  if (typeof value !== "string" || !/^syncky(?:-[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/.test(value)) return false;
  if (relayHost === undefined || value === "syncky") return true;
  const host = relayHost.toLowerCase();
  return !/(?:^|\.)syncky\.app\.?$/.test(host) || pairingSite(host) === `${value.slice(7)}.syncky.app`;
}
export function pairingSite(relayHost) {
  const label = /^relay-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.syncky\.app$/.exec(relayHost.toLowerCase())?.[1];
  return label ? `${label}.syncky.app` : "syncky.app";
}
