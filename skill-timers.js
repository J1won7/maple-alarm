(() => {
  'use strict';
  const root = document.getElementById('skillTimers');
  if (!root) return;
  const key = 'maple-skill-timers-v1';
  const cacheKey = 'maple-skill-ocr-cache-v1';
  const video = document.getElementById('captureVideo');
  const resolution = document.getElementById('resolution');
  const crop = document.createElement('canvas');
  const context = crop.getContext('2d', { willReadFrequently: true });
  let items = read(key, []);
  if (!Array.isArray(items)) items = [];
  let cache = read(cacheKey, {});
  if (!cache || typeof cache !== 'object') cache = {};
  const runtime = new Map();
  let workerPromise;
  let busy = false;
  let audioContext = null;
  let selecting = null;
  let selection = null;
  let start = null;

  function read(name, fallback) {
    try { return JSON.parse(localStorage.getItem(name)) ?? fallback; } catch { return fallback; }
  }
  function save() { localStorage.setItem(key, JSON.stringify(items)); }
  function state(item) {
    if (!runtime.has(item.id)) runtime.set(item.id, { samples: [], next: 0, timer: null, message: '감지 대기' });
    return runtime.get(item.id);
  }
  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  root.innerHTML = `<h2>스킬 타이머</h2>
    <label>검사 간격 (초)<input id="skillInterval" type="number" min="0.5" max="30" step="0.5" value="1"></label>
    <div id="skillList"></div><div class="actions"><button id="addSkill" type="button">스킬 추가</button></div>
    <p class="hint" id="skillStatus" role="status"></p>
    <dialog id="skillRoiDialog"><h2>스킬 영역 지정</h2><p class="hint">쿨타임 숫자가 나타나는 영역을 드래그하세요.</p><canvas class="bbox-canvas" id="skillRoiCanvas"></canvas><p class="hint" id="skillRoiStatus"></p><div class="actions"><button id="saveSkillRoi" type="button">저장</button><button id="cancelSkillRoi" type="button">취소</button></div></dialog>`;
  const list = root.querySelector('#skillList');
  const status = root.querySelector('#skillStatus');
  const interval = root.querySelector('#skillInterval');
  interval.value = localStorage.getItem(key + '.interval') || '1';
  const dialog = root.querySelector('#skillRoiDialog');
  const roiCanvas = root.querySelector('#skillRoiCanvas');
  const roiContext = roiCanvas.getContext('2d');
  const roiStatus = root.querySelector('#skillRoiStatus');

  function render() {
    list.innerHTML = items.map(item => {
      const st = state(item);
      const roi = item.rois?.[resolution.value];
      return `<div class="status" data-skill="${escapeText(item.id)}">
        <label>스킬 이름<input data-field="name" type="text" value="${escapeText(item.name)}" maxlength="40"></label>
        <label>쿨타임 (초)<input data-field="cooldown" type="number" min="1" max="86400" step="1" value="${item.cooldown}"></label>
        <label>지속시간 (초)<input data-field="duration" type="number" min="0" max="86400" step="1" value="${item.duration}"></label>
        <label><input data-field="enabled" type="checkbox" ${item.enabled ? 'checked' : ''}> 감지</label>
        <div class="actions"><button data-action="roi" type="button">영역 지정</button><button data-action="reset" type="button">다시 감지</button><button data-action="delete" type="button">삭제</button></div>
        <p class="hint">${roi ? '이 해상도에 영역 저장됨' : '이 해상도의 영역을 지정하세요'} · <span data-state>${escapeText(st.message)}</span></p></div>`;
    }).join('');
  }
  function setMessage(item, message) {
    state(item).message = message;
    const card = [...list.querySelectorAll('[data-skill]')].find(el => el.dataset.skill === item.id);
    if (card) card.querySelector('[data-state]').textContent = message;
  }
  root.querySelector('#addSkill').addEventListener('click', () => {
    items.push({ id: crypto.randomUUID(), name: '새 스킬', cooldown: 120, duration: 120, enabled: true, rois: {} });
    save(); render();
  });
  interval.addEventListener('change', () => {
    interval.value = String(Math.max(.5, Math.min(30, Number(interval.value) || 1)));
    localStorage.setItem(key + '.interval', interval.value);
    for (const st of runtime.values()) { st.samples = []; st.next = 0; }
  });
  document.getElementById('shareButton').addEventListener('click', () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext ||= new AudioContextClass();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  });
  list.addEventListener('change', event => {
    const card = event.target.closest('[data-skill]');
    const item = items.find(x => x.id === card?.dataset.skill);
    const field = event.target.dataset.field;
    if (!item || !field) return;
    if (field === 'enabled') item.enabled = event.target.checked;
    else if (field === 'name') item.name = event.target.value.trim() || '새 스킬';
    else {
      const value = Math.max(field === 'cooldown' ? 1 : 0, Math.min(86400, Number(event.target.value) || 0));
      if (field === 'cooldown' && item.duration === item.cooldown) item.duration = value;
      item[field] = value;
    }
    runtime.delete(item.id); save(); render();
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    const card = event.target.closest('[data-skill]');
    const item = items.find(x => x.id === card?.dataset.skill);
    if (!button || !item) return;
    if (button.dataset.action === 'delete') { items = items.filter(x => x !== item); runtime.delete(item.id); save(); render(); }
    if (button.dataset.action === 'reset') { runtime.delete(item.id); render(); }
    if (button.dataset.action === 'roi') openRoi(item);
  });
  resolution.addEventListener('change', () => { for (const st of runtime.values()) st.samples = []; render(); });

  function openRoi(item) {
    if (!video.srcObject || !video.videoWidth) { status.textContent = '먼저 화면 공유를 시작하세요.'; return; }
    selecting = { id: item.id, resolution: resolution.value };
    roiCanvas.width = video.videoWidth; roiCanvas.height = video.videoHeight;
    const old = item.rois?.[resolution.value];
    selection = old ? { x: old.x * roiCanvas.width, y: old.y * roiCanvas.height, w: old.w * roiCanvas.width, h: old.h * roiCanvas.height } : null;
    roiStatus.textContent = ''; drawRoi(); dialog.showModal();
  }
  function drawRoi() {
    roiContext.drawImage(video, 0, 0, roiCanvas.width, roiCanvas.height);
    if (selection) { roiContext.strokeStyle = '#57c5f5'; roiContext.lineWidth = Math.max(2, roiCanvas.width / 600); roiContext.strokeRect(selection.x, selection.y, selection.w, selection.h); }
  }
  function point(event) {
    const r = roiCanvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(roiCanvas.width, (event.clientX - r.left) * roiCanvas.width / r.width)), y: Math.max(0, Math.min(roiCanvas.height, (event.clientY - r.top) * roiCanvas.height / r.height)) };
  }
  function updateSelection(p) { selection = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; drawRoi(); }
  roiCanvas.addEventListener('pointerdown', event => { start = point(event); roiCanvas.setPointerCapture(event.pointerId); });
  roiCanvas.addEventListener('pointermove', event => { if (start) updateSelection(point(event)); });
  roiCanvas.addEventListener('pointerup', event => { if (start) { updateSelection(point(event)); start = null; } });
  roiCanvas.addEventListener('pointercancel', () => { start = null; });
  root.querySelector('#cancelSkillRoi').addEventListener('click', () => dialog.close());
  root.querySelector('#saveSkillRoi').addEventListener('click', () => {
    if (!selection || selection.w < 8 || selection.h < 8) { roiStatus.textContent = '영역을 충분히 크게 지정하세요.'; return; }
    const item = items.find(x => x.id === selecting?.id);
    if (!item) { dialog.close(); return; }
    item.rois ||= {};
    item.rois[selecting.resolution] = { x: selection.x / roiCanvas.width, y: selection.y / roiCanvas.height, w: selection.w / roiCanvas.width, h: selection.h / roiCanvas.height };
    runtime.delete(item.id); save(); dialog.close(); render();
  });

  function loadWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      script.onload = resolve; script.onerror = () => reject(new Error('OCR 라이브러리를 불러오지 못했습니다.'));
      document.head.appendChild(script);
    }).then(async () => {
      const worker = await Tesseract.createWorker('eng');
      await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
      return worker;
    }).catch(error => { workerPromise = null; throw error; });
    return workerPromise;
  }
  function prepareImage(roi) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const x = Math.max(0, Math.floor(roi.x * vw)), y = Math.max(0, Math.floor(roi.y * vh));
    const w = Math.min(vw - x, Math.max(1, Math.round(roi.w * vw))), h = Math.min(vh - y, Math.max(1, Math.round(roi.h * vh)));
    crop.width = w; crop.height = h;
    context.drawImage(video, x, y, w, h, 0, 0, w, h);
    const image = context.getImageData(0, 0, w, h);
    const data = image.data;
    let count = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    for (let i = 0; i < w * h; i++) {
      const p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2];
      const yellow = r > 145 && g > 115 && r > b * 1.25 && g > b * 1.2 && Math.abs(r - g) < 110;
      const value = yellow ? 0 : 255;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
      if (yellow) { const px = i % w, py = Math.floor(i / w); minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); count++; }
    }
    if (count < 8 || maxX < minX || maxY < minY) return null;
    context.putImageData(image, 0, 0);
    const out = document.createElement('canvas');
    const scale = Math.max(1, Math.min(5, 60 / (maxY - minY + 1)));
    out.width = Math.ceil((maxX - minX + 1) * scale) + 20; out.height = Math.ceil((maxY - minY + 1) * scale) + 20;
    const ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(crop, minX, minY, maxX - minX + 1, maxY - minY + 1, 10, 10, out.width - 20, out.height - 20);
    return { canvas: out, signature: out.toDataURL() };
  }
  async function recognize(image) {
    const cached = cache[image.signature];
    if (Number.isInteger(cached)) return cached;
    const worker = await loadWorker();
    const result = await worker.recognize(image.canvas);
    const text = result.data.text.trim().replace(/\s/g, '');
    if (!/^\d{1,5}$/.test(text) || result.data.confidence < 65) return null;
    return Number(text);
  }
  function confirm(item, st, samples) {
    const last = samples[samples.length - 1];
    const end = last.time + last.value * 1000;
    const used = end - item.cooldown * 1000;
    const alertAt = used + item.duration * 1000;
    st.timer = { end, alertAt, alerted: false };
    st.samples = [];
    for (const sample of samples) cache[sample.signature] = sample.value;
    const keys = Object.keys(cache);
    if (keys.length > 150) for (const k of keys.slice(0, keys.length - 150)) delete cache[k];
    try { localStorage.setItem(cacheKey, JSON.stringify(cache)); } catch { cache = {}; }
    updateTimer(item, st, Date.now());
  }
  function alertSkill(item) {
    const audio = new Audio('./띠링.mp3');
    const gain = Math.max(0, (Number(document.getElementById('alertVolume').value) || 0) / 100);
    audio.volume = Math.min(1, gain);
    if (gain > 1 && audioContext && audioContext.state === 'running') {
      const source = audioContext.createMediaElementSource(audio);
      const amplifier = audioContext.createGain();
      amplifier.gain.value = gain;
      source.connect(amplifier).connect(audioContext.destination);
      audio.addEventListener('ended', () => { source.disconnect(); amplifier.disconnect(); }, { once: true });
    }
    audio.play().catch(() => { status.textContent = '알림음을 재생하지 못했습니다. 브라우저의 소리 설정을 확인하세요.'; });
    if (document.getElementById('notifyPrimary').checked && 'Notification' in window && Notification.permission === 'granted') new Notification(item.name + ' 알림', { body: '스킬 지속시간이 끝났습니다.' });
  }
  function updateTimer(item, st, now) {
    const timer = st.timer;
    if (!timer) return;
    if (!timer.alerted && now >= timer.alertAt) { timer.alerted = true; alertSkill(item); }
    if (now >= timer.end && timer.alerted) { st.timer = null; st.next = now + Number(interval.value) * 1000; setMessage(item, '감지 대기'); return; }
    const remaining = timer.alerted ? Math.max(0, (timer.end - now) / 1000) : Math.max(0, (timer.alertAt - now) / 1000);
    setMessage(item, `${timer.alerted ? '쿨타임' : '알림까지'} ${remaining.toFixed(1)}초`);
  }
  async function tick() {
    const now = Date.now();
    for (const item of items) { const st = state(item); if (st.timer) updateTimer(item, st, now); }
    if (busy || !video.srcObject || !video.videoWidth || dialog.open) return;
    const item = items.find(x => x.enabled && x.rois?.[resolution.value] && !state(x).timer && now >= state(x).next);
    if (!item) return;
    const st = state(item); st.next = now + Math.max(.5, Number(interval.value) || 1) * 1000;
    const activeResolution = resolution.value;
    const stream = video.srcObject;
    const capturedAt = Date.now();
    let image;
    try { image = prepareImage(item.rois[activeResolution]); } catch { setMessage(item, '영역을 읽지 못했습니다'); return; }
    if (!image) { st.samples = []; setMessage(item, '숫자 찾는 중'); return; }
    busy = true;
    try {
      setMessage(item, '숫자 확인 중');
      const value = await recognize(image);
      if (!items.includes(item) || runtime.get(item.id) !== st || resolution.value !== activeResolution || video.srcObject !== stream) return;
      if (value === null || value > item.cooldown || value <= 0) { st.samples = []; setMessage(item, '숫자 확인 실패'); return; }
      const previous = st.samples.at(-1);
      if (previous) {
        const elapsed = (capturedAt - previous.time) / 1000;
        const difference = previous.value - value;
        if (difference === 0 && elapsed <= Math.max(3, Number(interval.value) * 2 + 1)) {
          setMessage(item, `${value}초 확인 (${st.samples.length}/3)`);
          return;
        }
        if (elapsed < .25 || difference <= 0 || Math.abs(difference - elapsed) > 1.2) st.samples = [];
      }
      st.samples.push({ value, time: capturedAt, signature: image.signature });
      if (st.samples.length >= 3) confirm(item, st, st.samples.slice(-3));
      else setMessage(item, `${value}초 확인 (${st.samples.length}/3)`);
    } catch (error) { st.samples = []; setMessage(item, '숫자 인식 오류'); status.textContent = error.message; }
    finally { busy = false; }
  }
  render();
  setInterval(tick, 200);
})();
