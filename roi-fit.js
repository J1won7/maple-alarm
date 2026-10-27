(() => {
  'use strict';

  // Scores four independent edges in a small search area around the selection.
  function fit(image, selection, offsetX, offsetY) {
    const { width, height, data } = image;
    const stride = width + 1;
    const rowSum = new Float32Array(height * stride);
    const rowHits = new Uint32Array(height * stride);
    const colSum = new Float32Array(width * (height + 1));
    const colHits = new Uint32Array(width * (height + 1));
    const colorDiff = (a, b) => (Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2])) / 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        const dx = x > 0 ? colorDiff(p, p - 4) : 0;
        const dy = y > 0 ? colorDiff(p, p - width * 4) : 0;
        const r = y * stride + x + 1, c = x * (height + 1) + y + 1;
        rowSum[r] = rowSum[r - 1] + dy;
        rowHits[r] = rowHits[r - 1] + (dy >= 16 ? 1 : 0);
        colSum[c] = colSum[c - 1] + dx;
        colHits[c] = colHits[c - 1] + (dx >= 16 ? 1 : 0);
      }
    }
    function horizontal(x, y, length) {
      const from = y * stride + x, to = from + length;
      return [(rowSum[to] - rowSum[from]) / length, (rowHits[to] - rowHits[from]) / length];
    }
    function vertical(x, y, length) {
      const from = x * (height + 1) + y, to = from + length;
      return [(colSum[to] - colSum[from]) / length, (colHits[to] - colHits[from]) / length];
    }
    const original = selection.w;
    const cx = selection.x + original / 2 - offsetX, cy = selection.y + original / 2 - offsetY;
    const step = Math.max(1, Math.floor(original / 45));
    const minSide = Math.max(8, Math.round(original * .7));
    const maxSide = Math.min(width - 2, height - 2, Math.round(original * 1.3));
    const shift = Math.max(3, Math.round(original * .22));
    let best = null;
    for (let side = minSide; side <= maxSide; side += step) {
      for (let y = Math.round(cy - side / 2 - shift); y <= Math.round(cy - side / 2 + shift); y += step) {
        if (y < 1 || y + side >= height) continue;
        for (let x = Math.round(cx - side / 2 - shift); x <= Math.round(cx - side / 2 + shift); x += step) {
          if (x < 1 || x + side >= width) continue;
          const edges = [horizontal(x, y, side), horizontal(x, y + side, side), vertical(x, y, side), vertical(x + side, y, side)];
          const minStrength = Math.min(...edges.map(edge => edge[0]));
          const minCoverage = Math.min(...edges.map(edge => edge[1]));
          if (minStrength < 9 || minCoverage < .3) continue;
          const distance = Math.hypot(x + side / 2 - cx, y + side / 2 - cy) / original;
          const sizeDifference = Math.abs(side - original) / original;
          const score = edges.reduce((sum, edge) => sum + Math.min(edge[0], 100) * edge[1], 0) / 4 - distance * 25 - sizeDifference * 15;
          if (!best || score > best.score) best = { x: x + offsetX, y: y + offsetY, w: side, h: side, score };
        }
      }
    }
    return best && best.score >= 12 ? best : null;
  }

  window.fitSkillRoi = fit;
})();
