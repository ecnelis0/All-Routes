/**
 * Map icons drawn to a canvas at runtime.
 *
 * Generated rather than shipped as image assets so they scale with device
 * pixel ratio (a 1x PNG is visibly soft on a retina display) and so there
 * is no binary in the repo to keep in sync with the colours used
 * elsewhere.
 *
 * Both icons are drawn pointing UP, i.e. in the direction of travel.
 * MapLibre's `icon-rotate` then turns them to the feature's bearing, and
 * `icon-rotation-alignment: map` keeps them lying on the road rather than
 * facing the camera.
 */

export function makeCyclistIcon(size = 64, dpr = 2): ImageData | null {
  const px = size * dpr;
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(dpr, dpr);
  const m = size / 2;

  // Halo so the rider stays visible against both dark asphalt and pale
  // concrete - the same problem the route line has.
  g.beginPath();
  g.arc(m, m, size * 0.30, 0, Math.PI * 2);
  g.fillStyle = "rgba(15,23,42,0.45)";
  g.fill();

  g.beginPath();
  g.arc(m, m, size * 0.24, 0, Math.PI * 2);
  g.fillStyle = "#2563eb";
  g.fill();
  g.lineWidth = size * 0.055;
  g.strokeStyle = "#ffffff";
  g.stroke();

  // A chevron rather than a literal bicycle: at tour altitude a bike
  // silhouette is a few pixels of mush, whereas a pointer reads instantly
  // and also communicates heading.
  g.beginPath();
  g.moveTo(m, m - size * 0.135);
  g.lineTo(m + size * 0.105, m + size * 0.095);
  g.lineTo(m, m + size * 0.04);
  g.lineTo(m - size * 0.105, m + size * 0.095);
  g.closePath();
  g.fillStyle = "#ffffff";
  g.fill();

  return g.getImageData(0, 0, px, px);
}

export function makeCarIcon(oncoming: boolean, size = 28, dpr = 2): ImageData | null {
  const px = size * dpr;
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(dpr, dpr);

  const w = size * 0.34;
  const h = size * 0.62;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  const r = size * 0.08;

  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  // Oncoming traffic is tinted differently so direction of flow is
  // readable at a glance without needing to watch the cars move.
  g.fillStyle = oncoming ? "#e2e8f0" : "#64748b";
  g.fill();
  g.lineWidth = size * 0.045;
  g.strokeStyle = "rgba(15,23,42,0.55)";
  g.stroke();

  // Windscreen, which is what makes it read as a car rather than a dash.
  g.fillStyle = "rgba(15,23,42,0.35)";
  g.fillRect(x + w * 0.18, y + h * 0.16, w * 0.64, h * 0.2);

  return g.getImageData(0, 0, px, px);
}
