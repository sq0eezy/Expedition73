const radians = Math.PI / 180;
const startLongitude = -127;
const startLatitude = 49;
const size = 400;
const center = size / 2;
const overviewRadius = 178;
const closeupRadius = 420;
const zoomRadii = [overviewRadius, 220, 275, 340, closeupRadius, 520, 640];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrap = (longitude) => ((longitude + 180) % 360 + 360) % 360 - 180;

export function createWeatherGlobe(canvas, status) {
  const context = canvas.getContext("2d");
  if (!context) {
    status.textContent = "The globe is unavailable in this browser. The regional readings are shown alongside it.";
    return null;
  }
  const surface = document.createElement("canvas");
  surface.width = surface.height = size;
  const paint = surface.getContext("2d");
  const pixels = paint.createImageData(size, size);
  let texture = null, longitude = startLongitude, latitude = startLatitude;
  let radius = overviewRadius;
  let regions = [], visible = false, animated = false, frame = 0, dirty = true;
  let lastTime = 0, drag = null;

  // Inverse orthographic projection. Precompute camera-space normals and lighting
  // so rotation only changes which pixels of the fixed Blue Marble map are read.
  const projections = new Map();
  function spherePixels() {
    if (projections.has(radius)) return projections.get(radius);
    const sphere = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const east = (x + .5 - center) / radius, north = (center - y - .5) / radius;
        const squared = 1 - east * east - north * north;
        if (squared < 0) continue;
        const front = Math.sqrt(squared);
        const light = .75 + .25 * clamp(-.34 * east + .28 * north + .88 * front, 0, 1);
        const alpha = 255 * clamp(.5 + radius * squared / 2, 0, 1);
        sphere.push([4 * (y * size + x), east, north, front, light, alpha]);
      }
    }
    if (projections.size === 2) projections.delete(projections.keys().next().value);
    projections.set(radius, sphere);
    return sphere;
  }

  function drawEarth() {
    const a = longitude * radians, b = latitude * radians;
    const sin = Math.sin(b), cos = Math.cos(b);
    const { width, height, data } = texture;
    for (const [offset, east, north, front, light, alpha] of spherePixels()) {
      const lat = Math.asin(clamp(north * cos + front * sin, -1, 1));
      const lon = a + Math.atan2(east, front * cos - north * sin);
      const x = ((Math.floor((lon / (2 * Math.PI) + .5) * width) % width) + width) % width;
      const y = clamp(Math.floor((.5 - lat / Math.PI) * height), 0, height - 1);
      const source = 4 * (y * width + x);
      pixels.data[offset] = data[source] * light + 3;
      pixels.data[offset + 1] = data[source + 1] * light + 8;
      pixels.data[offset + 2] = data[source + 2] * light + 17;
      pixels.data[offset + 3] = alpha;
    }
    paint.putImageData(pixels, 0, 0);
    dirty = false;
  }

  function project(lon, lat, altitude = 0) {
    const d = (lon - longitude) * radians, p = lat * radians, b = latitude * radians;
    const depth = Math.sin(b) * Math.sin(p) + Math.cos(b) * Math.cos(p) * Math.cos(d);
    const r = radius * (1 + altitude);
    return { x: center + r * Math.cos(p) * Math.sin(d),
      y: center - r * (Math.cos(b) * Math.sin(p) - Math.sin(b) * Math.cos(p) * Math.cos(d)), depth };
  }

  function drawPrecipitation(region, time) {
    const [west, south, east, north] = region.bounds;
    // The regional mean controls the amount of motion. Positions, trajectories
    // and heights are illustrative and are not sampled weather observations.
    const streaks = Math.ceil(34 * region.intensity);
    context.lineWidth = 1.25;
    context.lineCap = "round";
    for (let i = 0; i < streaks; i++) {
      const phase = (time / 1000 * (.62 + i % 5 * .065) + i * .381) % 1;
      const lon = west + (east - west) * ((.15 + i * .618) % 1);
      const lat = south + (north - south) * ((.24 + i * .414) % 1);
      const head = project(lon + .55 * phase, lat - .3 * phase, .15 * (1 - phase));
      if (head.depth <= 0) continue;
      const tail = project(lon + .55 * phase - .24, lat - .3 * phase + .15, .15 * (1 - phase) + .045);
      context.strokeStyle = `rgb(158 228 255 / ${.94 * Math.sin(Math.PI * phase)})`;
      context.beginPath();
      context.moveTo(tail.x, tail.y);
      context.lineTo(head.x, head.y);
      context.stroke();
    }
  }

  function drawRegion(region, time) {
    const [w, s, e, n] = region.bounds;
    const anchor = project((w + e) / 2, (s + n) / 2);
    if (anchor.depth <= 0) return;
    const corners = [[w, n], [e, n], [e, s], [w, s]].map(([lon, lat]) => project(lon, lat));
    if (corners.every(({ depth }) => depth > 0)) {
      context.beginPath();
      corners.forEach(({ x, y }, i) => i ? context.lineTo(x, y) : context.moveTo(x, y));
      context.closePath();
      context.fillStyle = region.fill;
      context.globalAlpha = .82;
      context.fill();
      context.globalAlpha = 1;
      context.lineWidth = 1.3;
      context.strokeStyle = "#f6fafb";
      context.stroke();
    }
    if (animated && region.intensity > 0) drawPrecipitation(region, time);

    const labelX = clamp(anchor.x + 19, 12, size - 12), labelY = clamp(anchor.y - 13, 12, size - 12);
    context.beginPath();
    context.moveTo(anchor.x, anchor.y);
    context.lineTo(labelX, labelY);
    context.strokeStyle = "#fff";
    context.lineWidth = 1;
    context.stroke();
    context.beginPath();
    context.arc(labelX, labelY, 9, 0, Math.PI * 2);
    context.fillStyle = "#142b40";
    context.fill();
    context.stroke();
    context.fillStyle = "#fff";
    context.font = "bold 10px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(region.id, labelX, labelY);
  }

  function schedule() {
    if (visible && texture && !frame) frame = requestAnimationFrame(draw);
  }

  function draw(time) {
    frame = 0;
    if (!visible) return;
    if (dirty || !animated || time - lastTime >= 32) {
      if (dirty) drawEarth();
      context.clearRect(0, 0, size, size);
      const halo = context.createRadialGradient(center, center, radius - 3, center, center, radius + 13);
      halo.addColorStop(0, "#5484a8aa");
      halo.addColorStop(1, "#5484a800");
      context.fillStyle = halo;
      context.fillRect(0, 0, size, size);
      context.drawImage(surface, 0, 0);
      for (const region of regions) drawRegion(region, time);
      lastTime = time;
    }
    if (animated && regions.some(({ intensity }) => intensity > 0)) schedule();
  }

  function orient(lon, lat, nextRadius = radius) {
    longitude = wrap(lon);
    latitude = clamp(lat, -85, 85);
    if (nextRadius !== radius) pixels.data.fill(0);
    radius = nextRadius;
    dirty = true;
    canvas.dataset.longitude = String(longitude);
    canvas.dataset.latitude = String(latitude);
    canvas.dataset.zoom = String(radius);
    schedule();
  }

  function zoom(direction) {
    const index = zoomRadii.indexOf(radius);
    const next = zoomRadii[clamp(index + direction, 0, zoomRadii.length - 1)];
    if (next !== radius) orient(longitude, latitude, next);
  }

  canvas.addEventListener("wheel", (event) => {
    if (!texture || !event.deltaY || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    zoom(-Math.sign(event.deltaY));
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, longitude, latitude };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId) return;
    orient(drag.longitude - (event.clientX - drag.x) * .42, drag.latitude + (event.clientY - drag.y) * .42);
  });
  canvas.addEventListener("lostpointercapture", () => { drag = null; });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      zoom(event.key === "-" ? -1 : 1);
      return;
    }
    const direction = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 8], ArrowDown: [0, -8], Home: [0, 0] }[event.key];
    if (!direction) return;
    event.preventDefault();
    if (event.key === "Home") orient(startLongitude, startLatitude, overviewRadius);
    else orient(longitude + direction[0], latitude + direction[1]);
  });

  const image = new Image();
  const failure = () => { status.textContent = "The NASA basemap could not be loaded. Regional readings are still available."; };
  image.addEventListener("error", failure);
  image.addEventListener("load", () => {
    try {
      const map = document.createElement("canvas");
      map.width = 1600;
      map.height = 800;
      const source = map.getContext("2d", { willReadFrequently: true });
      source.drawImage(image, 0, 0, map.width, map.height);
      texture = source.getImageData(0, 0, map.width, map.height);
      status.hidden = true;
      canvas.dataset.ready = "true";
      schedule();
    } catch { failure(); }
  });
  image.src = "./blue-marble.jpg";
  orient(startLongitude, startLatitude);
  return {
    show(value) {
      visible = value;
      if (value) schedule();
      else { cancelAnimationFrame(frame); frame = 0; }
    },
    update(values, motion) {
      regions = values;
      animated = motion;
      lastTime = -Infinity;
      schedule();
    },
    focus([w, s, e, n]) { orient((w + e) / 2, (s + n) / 2, closeupRadius); },
    reset() { orient(startLongitude, startLatitude, overviewRadius); },
  };
}
