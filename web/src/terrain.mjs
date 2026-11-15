import { relief } from "./terrain-data.mjs";

const verticalExaggeration = 18;
const radians = Math.PI / 180;

export function terrainWindow(id, bounds) {
  const terrain = relief[id];
  return terrain?.bounds?.every((value, i) => value === bounds[i]) ? terrain : null;
}

export function createTerrainView(canvas) {
  const surface = document.createElement("canvas");
  surface.width = canvas.width;
  surface.height = canvas.height;
  const scene = surface.getContext("2d"), visible = canvas.getContext("2d");
  if (!scene || !visible) return null;
  const { width, height } = canvas;
  let frame = null;

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function draw(terrain, degrees, slopeColor, intensity, animate) {
    stop();
    const [west, south, east, north] = terrain.bounds;
    const dy = north - south;
    const dx = (east - west) * Math.cos((north + south) / 2 * radians);
    const yaw = degrees * radians, tilt = 38 * radians;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const scale = Math.min(width * 0.84, height * 1.18) / Math.hypot(dx, dy);
    const project = (u, v, elevation) => {
      const x = (u - 0.5) * dx, y = (v - 0.5) * dy;
      const depth = x * sin + y * cos;
      const rise = Math.max(elevation, 0) / 111_195 * verticalExaggeration;
      return [width / 2 + (x * cos - y * sin) * scale,
        height * 0.55 + (depth * Math.sin(tilt) - rise * Math.cos(tilt)) * scale, depth];
    };
    const rows = terrain.elevation.length, cols = terrain.elevation[0].length;
    const points = terrain.elevation.map((row, y) => row.map((value, x) => project(x / (cols - 1), y / (rows - 1), value)));
    const faces = [];
    for (let y = 0; y < rows - 1; y++) {
      for (let x = 0; x < cols - 1; x++) {
        const u = (x + 0.5) / (cols - 1), v = (y + 0.5) / (rows - 1);
        const corners = [points[y][x], points[y][x + 1], points[y + 1][x + 1], points[y + 1][x]];
        const a = terrain.elevation[y][x], b = terrain.elevation[y][x + 1];
        const c = terrain.elevation[y + 1][x], d = terrain.elevation[y + 1][x + 1];
        const elevation = (a + b + c + d) / 4;
        const light = Math.max(-13, Math.min(13, (c - a + b - d) / 32));
        const fill = slopeColor?.(west + (east - west) * u, north - dy * v) ??
          (elevation < 0 ? "#49859c" : elevation > 3000 ? `hsl(43 28% ${78 + light}%)`
            : `hsl(${75 - Math.min(elevation, 3000) / 80} 25% ${49 + elevation / 175 + light}%)`);
        faces.push({ corners, fill, depth: corners.reduce((sum, point) => sum + point[2], 0) / 4 });
      }
    }
    const background = scene.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, "#edf3f6");
    background.addColorStop(1, "#d9e5e8");
    scene.fillStyle = background;
    scene.fillRect(0, 0, width, height);
    const polygon = (corners, color) => {
      scene.beginPath();
      corners.forEach(([x, y], i) => i ? scene.lineTo(x, y) : scene.moveTo(x, y));
      scene.closePath();
      scene.fillStyle = scene.strokeStyle = color;
      scene.lineWidth = 0.7;
      scene.fill();
      scene.stroke();
    };
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => project(u, v, 0));
    const base = corners.map(([x, y]) => [x, y + 15]);
    polygon(base, "#71858a");
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      polygon([corners[i], corners[next], base[next], base[i]], "#71858a");
    }
    faces.sort((a, b) => a.depth - b.depth);
    for (const face of faces) polygon(face.corners, face.fill);
    const rain = Array.from({ length: intensity > 0 ? Math.round(18 + 72 * intensity) : 0 }, (_, i) => {
      const x = (i * 47 % 101) / 101, y = (i * 61 % 103) / 103;
      const elevation = terrain.elevation[Math.round(y * (rows - 1))][Math.round(x * (cols - 1))];
      return { point: project(x, y, elevation), phase: (i * 73 % 109) / 109 };
    });
    const paint = (time) => {
      visible.drawImage(surface, 0, 0);
      visible.beginPath();
      for (const { point: [x, y], phase } of rain) {
        const z = ((time / 740 + phase) % 1) * 100;
        visible.moveTo(x - 3, y - 114 + z);
        visible.lineTo(x, y - 104 + z);
      }
      visible.strokeStyle = "#217bafaa";
      visible.lineWidth = 1.6;
      visible.stroke();
      if (animate && rain.length) frame = requestAnimationFrame(paint);
    };
    paint(0);
  }

  return { draw, stop };
}
