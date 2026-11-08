import { QrCode } from "./vendor/qrcodegen.js";

// The portal signs the compact token. Encode those exact bytes without parsing or reserializing it.
export function signedQrSvg(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error("A bound IRP signed QR is required");
  let qr;
  try {
    qr = QrCode.encodeBinary([...Buffer.from(token,"ascii")], QrCode.Ecc.MEDIUM);
  } catch {
    // ISO Model 2 L carries a longer signed token than M.
    qr = QrCode.encodeBinary([...Buffer.from(token,"ascii")], QrCode.Ecc.LOW);
  }
  const border = 4, size = qr.size + border * 2;
  const black = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.getModule(x,y)) { x++; continue; }
      const from = x++;
      while (x < qr.size && qr.getModule(x,y)) x++;
      black.push(`M${from+border} ${y+border}h${x-from}v1H${from+border}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size*6}" height="${size*6}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path fill="black" d="${black.join("")}"/></svg>`;
}
