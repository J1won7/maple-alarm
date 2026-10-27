(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const storage = 'maple-skills-v2';
  const cacheKey = 'maple-ocr-cache-v2';
  const video = $('video');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const roiCanvas = $('roiCanvas');
  const roiCtx = roiCanvas.getContext('2d');
  const runtime = new Map();
  let skills = read(storage, []);
  if (!Array.isArray(skills)) skills = [];
  let cache = read(cacheKey, {});
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  let workerPromise, stream = null, editing = null, draftRoi = null, selection = null, pointer = null, busy = false, audioContext = null;
  $('interval').value = localStorage.getItem(storage + '.interval') || '1';
  $('volume').value = localStorage.getItem(storage + '.volume') || '100';
  $('notifications').checked = localStorage.getItem(storage + '.notifications') === 'true';

  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function save() { localStorage.setItem(storage, JSON.stringify(skills)); }
  function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function state(skill) {
    if (!runtime.has(skill.id)) runtime.set(skill.id, { samples: [], next: 0, timer: null, text: '감지 대기' });
    return runtime.get(skill.id);
  }
  function setText(skill, text) {
    state(skill).text = text;
    const card = [...$('list').querySelectorAll('[data-id]')].find(el => el.dataset.id === skill.id);
    if (card) card.querySelector('.timer').textContent = text;
  }
  function render() {
    $('list').innerHTML = skills.length ? skills.map(skill => `<article class="skill-card" data-id="${escapeText(skill.id)}">
      <div class="card-head"><strong>${escapeText(skill.name)}</strong><label><input data-action="enable" type="checkbox" ${skill.enabled ? 'checked' : ''}> 감지</label></div>
      <span class="timer">${escapeText(state(skill).text)}</span>
      <span class="hint">쿨타임 ${skill.cooldown}초 · 지속시간 ${skill.duration}초</span>
      <div class="card-actions"><button data-action="edit">수정</button><button data-action="reset">다시 감지</button><button data-action="delete">삭제</button></div></article>`).join('') : '<p class="empty">등록된 스킬이 없습니다.</p>';
  }
  function openEdit(skill) {
    editing = skill?.id || null;
    $('editTitle').textContent = skill ? '스킬 수정' : '스킬 추가';
    $('name').value = skill?.name || '';
    $('cooldown').value = skill?.cooldown ?? 120;
    $('duration').value = skill?.duration ?? 120;
    draftRoi = skill?.roi ? { ...skill.roi } : null;
    $('roiSummary').textContent = draftRoi ? '영역이 지정되었습니다.' : '영역을 지정해 주세요.';
    $('editError').textContent = '';
    $('editDialog').showModal();
  }
  $('add').addEventListener('click', () => openEdit(null));
  $('cancelEdit').addEventListener('click', () => $('editDialog').close());
  let oldCooldown = Number($('cooldown').value);
  $('cooldown').addEventListener('focus', () => { oldCooldown = Number($('cooldown').value); });
  $('cooldown').addEventListener('input', () => {
    if (Number($('duration').value) === oldCooldown) $('duration').value = $('cooldown').value;
    oldCooldown = Number($('cooldown').value);
  });
  $('editForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('name').value.trim();
    if (!name || !draftRoi) { $('editError').textContent = !name ? '스킬 이름을 입력하세요.' : 'ROI를 먼저 지정해 주세요.'; return; }
    const cooldown = Number($('cooldown').value), duration = Number($('duration').value);
    if (!Number.isFinite(cooldown) || cooldown < 1 || !Number.isFinite(duration) || duration < 0) return;
    const skill = skills.find(x => x.id === editing);
    if (skill) Object.assign(skill, { name, cooldown, duration, roi: draftRoi });
    else skills.push({ id: crypto.randomUUID(), name, cooldown, duration, roi: draftRoi, enabled: true });
    if (skill) runtime.delete(skill.id);
    save(); $('editDialog').close(); render();
  });
  $('list').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    const skill = skills.find(x => x.id === event.target.closest('[data-id]')?.dataset.id);
    if (!button || !skill) return;
    if (button.dataset.action === 'edit') openEdit(skill);
    if (button.dataset.action === 'reset') { runtime.delete(skill.id); render(); }
    if (button.dataset.action === 'delete') { skills = skills.filter(x => x.id !== skill.id); runtime.delete(skill.id); save(); render(); }
  });
  $('list').addEventListener('change', event => {
    if (event.target.dataset.action !== 'enable') return;
    const skill = skills.find(x => x.id === event.target.closest('[data-id]')?.dataset.id);
    if (skill) { skill.enabled = event.target.checked; runtime.delete(skill.id); save(); render(); }
  });
  $('interval').addEventListener('change', () => {
    $('interval').value = String(Math.max(.5, Math.min(30, Number($('interval').value) || 1)));
    localStorage.setItem(storage + '.interval', $('interval').value);
    for (const st of runtime.values()) { st.samples = []; st.next = 0; }
  });
  function volumeLabel() { $('volumeValue').textContent = $('volume').value + '%'; }
  $('volume').addEventListener('input', volumeLabel);
  $('volume').addEventListener('change', () => localStorage.setItem(storage + '.volume', $('volume').value));
  $('notifications').addEventListener('change', async () => {
    if ($('notifications').checked) {
      if (!('Notification' in window)) { $('notifications').checked = false; $('status').textContent = '이 브라우저는 알림을 지원하지 않습니다.'; }
      else if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') { $('notifications').checked = false; $('status').textContent = '브라우저 알림 권한이 허용되지 않았습니다.'; }
    }
    localStorage.setItem(storage + '.notifications', String($('notifications').checked));
  });
  function prepareAudio() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (Audio) { audioContext ||= new Audio(); if (audioContext.state === 'suspended') audioContext.resume().catch(() => {}); }
  }
  function sound() {
    const audio = new Audio('./띠링.mp3');
    const gain = Number($('volume').value) / 100;
    audio.volume = Math.min(1, gain);
    if (gain > 1 && audioContext?.state === 'running') {
      const source = audioContext.createMediaElementSource(audio), amp = audioContext.createGain();
      amp.gain.value = gain; source.connect(amp).connect(audioContext.destination);
      audio.addEventListener('ended', () => { source.disconnect(); amp.disconnect(); }, { once: true });
    }
    audio.play().catch(() => { $('status').textContent = '소리를 재생하지 못했습니다. 브라우저의 음소거 설정을 확인하세요.'; });
  }
  $('testSound').addEventListener('click', () => { prepareAudio(); sound(); });
  $('share').addEventListener('click', async () => {
    prepareAudio();
    try {
      const next = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', frameRate: { ideal: 2 } }, audio: false });
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = next; video.srcObject = stream; await video.play();
      next.getVideoTracks()[0].addEventListener('ended', () => { if (stream === next) stop(); }, { once: true });
      $('share').disabled = true; $('stop').disabled = false; $('status').textContent = '화면을 공유하고 있습니다.';
    } catch (error) { $('status').textContent = '화면 공유를 시작하지 못했습니다: ' + error.message; }
  });
  function stop() {
    const old = stream; stream = null;
    if (old) old.getTracks().forEach(track => track.stop());
    video.srcObject = null; $('share').disabled = false; $('stop').disabled = true;
    for (const st of runtime.values()) st.samples = [];
    $('status').textContent = '화면 공유가 중지되었습니다.';
  }
  $('stop').addEventListener('click', stop);
  $('selectRoi').addEventListener('click', () => {
    if (!stream || !video.videoWidth) { $('editError').textContent = 'ROI 지정을 위해 먼저 화면 공유를 시작하세요.'; return; }
    roiCanvas.width = video.videoWidth; roiCanvas.height = video.videoHeight;
    if (draftRoi) {
      const x = draftRoi.x * roiCanvas.width, y = draftRoi.y * roiCanvas.height;
      const side = Math.min(draftRoi.w * roiCanvas.width, draftRoi.h * roiCanvas.height, roiCanvas.width - x, roiCanvas.height - y);
      selection = { x, y, w: side, h: side };
    } else selection = null;
    $('roiZoom').value = '1'; $('roiZoomValue').textContent = '100%';
    $('roiError').textContent = ''; $('roiDialog').showModal(); resizeRoi(); draw();
  });
  function resizeRoi() {
    const viewport = $('roiViewport');
    const zoom = Number($('roiZoom').value);
    const fit = Math.min(viewport.clientWidth / roiCanvas.width, viewport.clientHeight / roiCanvas.height);
    roiCanvas.style.width = `${roiCanvas.width * fit * zoom}px`;
    roiCanvas.style.height = `${roiCanvas.height * fit * zoom}px`;
    $('roiZoomValue').textContent = `${Math.round(zoom * 100)}%`;
  }
  $('roiZoom').addEventListener('input', resizeRoi);
  window.addEventListener('resize', () => { if ($('roiDialog').open) resizeRoi(); });
  function draw() {
    roiCtx.drawImage(video, 0, 0, roiCanvas.width, roiCanvas.height);
    if (selection) { roiCtx.strokeStyle = '#35dcc1'; roiCtx.lineWidth = Math.max(2, roiCanvas.width / 600); roiCtx.strokeRect(selection.x, selection.y, selection.w, selection.h); }
  }
  function point(event) {
    const rect = roiCanvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(roiCanvas.width, (event.clientX - rect.left) * roiCanvas.width / rect.width)), y: Math.max(0, Math.min(roiCanvas.height, (event.clientY - rect.top) * roiCanvas.height / rect.height)) };
  }
  function squareSelection(origin, destination, width, height) {
    const dx = destination.x - origin.x, dy = destination.y - origin.y;
    const horizontal = dx < 0 ? -1 : 1, vertical = dy < 0 ? -1 : 1;
    const availableX = horizontal < 0 ? origin.x : width - origin.x;
    const availableY = vertical < 0 ? origin.y : height - origin.y;
    const side = Math.max(0, Math.min(Math.max(Math.abs(dx), Math.abs(dy)), availableX, availableY));
    return { x: horizontal < 0 ? origin.x - side : origin.x, y: vertical < 0 ? origin.y - side : origin.y, w: side, h: side };
  }
  function move(p) { selection = squareSelection(pointer, p, roiCanvas.width, roiCanvas.height); draw(); }
  roiCanvas.addEventListener('pointerdown', event => { pointer = point(event); roiCanvas.setPointerCapture(event.pointerId); });
  roiCanvas.addEventListener('pointermove', event => { if (pointer) move(point(event)); });
  roiCanvas.addEventListener('pointerup', event => { if (pointer) { move(point(event)); pointer = null; } });
  roiCanvas.addEventListener('pointercancel', () => { pointer = null; selection = null; draw(); });
  $('cancelRoi').addEventListener('click', () => $('roiDialog').close());
  $('saveRoi').addEventListener('click', () => {
    if (!selection || selection.w < 8 || selection.h < 8) { $('roiError').textContent = '영역을 충분히 크게 지정하세요.'; return; }
    draftRoi = { x: selection.x / roiCanvas.width, y: selection.y / roiCanvas.height, w: selection.w / roiCanvas.width, h: selection.h / roiCanvas.height, aspect: roiCanvas.width / roiCanvas.height };
    $('roiSummary').textContent = '영역이 지정되었습니다.'; $('editError').textContent = ''; $('roiDialog').close();
  });
  function loadWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      script.onload = resolve; script.onerror = () => reject(new Error('숫자 인식기를 불러오지 못했습니다.')); document.head.appendChild(script);
    }).then(async () => { const worker = await Tesseract.createWorker('eng'); await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' }); return worker; }).catch(error => { workerPromise = null; throw error; });
    return workerPromise;
  }
  function prepareImage(roi) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const x = Math.max(0, Math.floor(roi.x * vw)), y = Math.max(0, Math.floor(roi.y * vh));
    const w = Math.min(vw - x, Math.max(1, Math.round(roi.w * vw))), h = Math.min(vh - y, Math.max(1, Math.round(roi.h * vh)));
    canvas.width = w; canvas.height = h; ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h), data = image.data;
    let count = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    for (let i = 0; i < w * h; i++) {
      const p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2];
      const yellow = r > 145 && g > 115 && r > b * 1.25 && g > b * 1.2 && Math.abs(r - g) < 110;
      const v = yellow ? 0 : 255; data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255;
      if (yellow) { const px = i % w, py = Math.floor(i / w); minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); count++; }
    }
    if (count < 8) return null;
    ctx.putImageData(image, 0, 0);
    const out = document.createElement('canvas'), scale = Math.max(1, Math.min(5, 60 / (maxY - minY + 1)));
    out.width = Math.ceil((maxX - minX + 1) * scale) + 20; out.height = Math.ceil((maxY - minY + 1) * scale) + 20;
    const target = out.getContext('2d'); target.fillStyle = '#fff'; target.fillRect(0, 0, out.width, out.height); target.imageSmoothingEnabled = false;
    target.drawImage(canvas, minX, minY, maxX - minX + 1, maxY - minY + 1, 10, 10, out.width - 20, out.height - 20);
    return { canvas: out, signature: out.toDataURL() };
  }
  async function recognize(image) {
    if (Number.isInteger(cache[image.signature])) return cache[image.signature];
    const worker = await loadWorker(), result = await worker.recognize(image.canvas);
    const text = result.data.text.trim().replace(/\s/g, '');
    return /^\d{1,5}$/.test(text) && result.data.confidence >= 65 ? Number(text) : null;
  }
  function confirm(skill, st) {
    const samples = st.samples.slice(-3), last = samples[2];
    const end = last.time + last.value * 1000;
    st.timer = { end, alertAt: end - skill.cooldown * 1000 + skill.duration * 1000, alerted: false };
    st.samples = [];
    for (const sample of samples) cache[sample.signature] = sample.value;
    const keys = Object.keys(cache); for (const key of keys.slice(0, Math.max(0, keys.length - 150))) delete cache[key];
    try { localStorage.setItem(cacheKey, JSON.stringify(cache)); } catch { cache = {}; }
  }
  function updateTimer(skill, st, now) {
    const t = st.timer; if (!t) return;
    if (!t.alerted && now >= t.alertAt) {
      t.alerted = true; sound();
      if ($('notifications').checked && 'Notification' in window && Notification.permission === 'granted') new Notification(skill.name, { body: '스킬 지속시간이 끝났습니다.' });
    }
    if (now >= t.end && t.alerted) { st.timer = null; st.next = now + Number($('interval').value) * 1000; setText(skill, '감지 대기'); return; }
    setText(skill, `${t.alerted ? '쿨타임' : '알림까지'} ${Math.max(0, (t.alerted ? t.end - now : t.alertAt - now) / 1000).toFixed(1)}초`);
  }
  async function tick() {
    const now = Date.now();
    for (const skill of skills) { const st = state(skill); if (st.timer) updateTimer(skill, st, now); }
    if (busy || !stream || !video.videoWidth || $('roiDialog').open) return;
    const skill = skills.filter(x => x.enabled && x.roi && !state(x).timer && now >= state(x).next).sort((a, b) => state(a).next - state(b).next)[0];
    if (!skill) return;
    const st = state(skill), capturedStream = stream, capturedAt = Date.now();
    st.next = capturedAt + Math.max(.5, Number($('interval').value) || 1) * 1000;
    if (Math.abs(video.videoWidth / video.videoHeight / skill.roi.aspect - 1) > .03) { st.samples = []; setText(skill, '화면 비율이 변경됨: ROI 재지정'); return; }
    let image;
    try { image = prepareImage(skill.roi); } catch { setText(skill, '영역을 읽지 못함'); return; }
    if (!image) { st.samples = []; setText(skill, '숫자 찾는 중'); return; }
    busy = true;
    try {
      setText(skill, '숫자 확인 중');
      const value = await recognize(image);
      if (!skills.includes(skill) || runtime.get(skill.id) !== st || stream !== capturedStream) return;
      if (value === null || value > skill.cooldown || value <= 0) { st.samples = []; setText(skill, '숫자 확인 실패'); return; }
      const previous = st.samples.at(-1);
      if (previous) {
        const elapsed = (capturedAt - previous.time) / 1000, difference = previous.value - value;
        if (difference === 0 && elapsed <= Math.max(3, Number($('interval').value) * 2 + 1)) { setText(skill, `${value}초 확인 (${st.samples.length}/3)`); return; }
        if (elapsed < .25 || difference <= 0 || Math.abs(difference - elapsed) > 1.2) st.samples = [];
      }
      st.samples.push({ value, time: capturedAt, signature: image.signature });
      if (st.samples.length >= 3) { confirm(skill, st); updateTimer(skill, st, Date.now()); }
      else setText(skill, `${value}초 확인 (${st.samples.length}/3)`);
    } catch (error) { st.samples = []; setText(skill, '숫자 인식 오류'); $('status').textContent = error.message; }
    finally { busy = false; }
  }
  volumeLabel(); render(); setInterval(tick, 200);
})();
