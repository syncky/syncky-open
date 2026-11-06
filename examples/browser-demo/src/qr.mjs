import QRCode from "qrcode";

const SVG_NS = "http://www.w3.org/2000/svg";
const QUIET_ZONE = 4;

export function qrPath(text) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const parts = [];
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) if (modules.get(y, x)) parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
  }
  return { size: modules.size + 2 * QUIET_ZONE, d: parts.join("") };
}

// Built with DOM calls and presentation attributes only, so the page's CSP needs no inline style or data: image.
export function qrSvg(document, text, label) {
  const { size, d } = qrPath(text);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const bg = document.createElementNS(SVG_NS, "rect");
  for (const [k, v] of Object.entries({ width: size, height: size, fill: "#ffffff" })) bg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(bg, path);
  return svg;
}
