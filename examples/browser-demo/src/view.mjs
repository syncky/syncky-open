export function pairView({ phase, pairing }) {
  const showPair = phase === "pairing" || phase === "joined";
  const showQr = phase === "pairing";
  return {
    showPair,
    showQr,
    showLink: showQr,
    code: showPair ? pairing?.code ?? "" : "",
    uri: showQr ? pairing?.uri ?? null : null,
  };
}
