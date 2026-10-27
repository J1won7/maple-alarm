(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const storage = 'maple-skills-v2';
  const cacheKey = 'maple-ocr-cache-v3';
  const video = $('video');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const roiCanvas = $('roiCanvas');
  const roiCtx = roiCanvas.getContext('2d');
  const roiFrame = document.createElement('canvas');
  const roiFrameContext = roiFrame.getContext('2d', { willReadFrequently: true });
  const runtime = new Map();
  const visiblePreviews = new Set();
  let skillsLocked = false;
  let skills;
  try {
    const raw = localStorage.getItem(storage);
    skills = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(skills)) throw new Error('invalid skill list');
  } catch {
    skills = [];
    skillsLocked = true;
  }
  let cache = read(cacheKey, {});
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  let workerPromise, stream = null, editing = null, draftRoi = null, selection = null, pointer = null, busy = false, audioContext = null;
  let draftResolution = null, activeResolution = null, roiFrameResolution = null;
  let beforeFit = null;
  $('interval').value = localStorage.getItem(storage + '.interval') || '1';
  $('volume').value = localStorage.getItem(storage + '.volume') || '100';
  $('notifications').checked = localStorage.getItem(storage + '.notifications') === 'true';

  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function save(next) {
    if (skillsLocked) {
      $('status').textContent = '기존 스킬 목록을 읽지 못해 덮어쓰기를 중지했습니다. 브라우저 저장소를 확인하세요.';
      return false;
    }
    try { localStorage.setItem(storage, JSON.stringify(next)); return true; }
    catch { $('status').textContent = '스킬 목록을 저장하지 못했습니다. 브라우저 저장 공간이나 권한을 확인하세요.'; return false; }
  }
  function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function videoResolution() { return video.videoWidth && video.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : null; }
  function currentRoi(skill) { return activeResolution && skill.rois ? skill.rois[activeResolution] || null : null; }
  function state(skill) {
    if (!runtime.has(skill.id)) runtime.set(skill.id, { samples: [], next: 0, timer: null, text: '감지 대기' });
    return runtime.get(skill.id);
  }
  function setText(skill, text) {
    state(skill).text = text;
    const card = [...$('list').querySelectorAll('[data-id]')].find(el => el.dataset.id === skill.id);
    if (card) card.querySelector('.timer').textContent = text;
  }
  function paintPreview(skill) {
    const card = [...$('list').querySelectorAll('[data-id]')].find(el => el.dataset.id === skill.id);
    if (!card) return;
    const enabled = visiblePreviews.has(skill.id);
    const preview = state(skill).preview;
    const area = card.querySelector('.roi-preview-area');
    area.hidden = !enabled;
    if (!enabled) return;
    const images = card.querySelector('.roi-previews');
    const raw = card.querySelector('.roi-preview-raw');
    const processed = card.querySelector('.roi-preview-processed');
    images.hidden = !preview;
    card.querySelector('.roi-preview-status').textContent = preview
      ? state(skill).timer ? '마지막 검출 이미지 · 타이머 진행 중' : '마지막 검출 시도'
      : '검출 이미지 대기 중';
    if (preview) {
      raw.src = preview.raw;
      if (preview.processed) { processed.src = preview.processed; processed.parentElement.hidden = false; }
      else { processed.removeAttribute('src'); processed.parentElement.hidden = true; }
    } else { raw.removeAttribute('src'); processed.removeAttribute('src'); }
  }
  function alertDescription(cooldown, duration) {
    if (!Number.isFinite(cooldown) || cooldown < 1 || !Number.isFinite(duration) || duration < 0) return '쿨타임과 지속시간을 입력하세요.';
    const remaining = cooldown - duration;
    if (remaining > 0) return `쿨타임 ${remaining}초 남았을 때 알림`;
    if (remaining === 0) return '쿨타임 종료 시 알림';
    return `쿨타임 종료 ${-remaining}초 후 알림`;
  }
  function updateAlertHint() { $('alertHint').textContent = alertDescription(Number($('cooldown').value), Number($('duration').value)); }
  function render() {
    $('list').innerHTML = skills.length ? skills.map(skill => `<article class="skill-card" data-id="${escapeText(skill.id)}">
      <div class="card-head"><strong>${escapeText(skill.name)}</strong><label><input data-action="enable" type="checkbox" ${skill.enabled ? 'checked' : ''}> 감지</label></div>
      <span class="timer">${escapeText(state(skill).text)}</span>
      <span class="hint">쿨타임 ${skill.cooldown}초 · 지속시간 ${skill.duration}초<br>${escapeText(alertDescription(skill.cooldown, skill.duration))}</span>
      <p class="hint">${activeResolution ? `${escapeText(activeResolution)} · ${currentRoi(skill) ? 'ROI 저장됨' : 'ROI 미설정'}` : '화면 공유 후 해상도별 ROI 확인'}</p>
      <label class="roi-preview-toggle"><input data-action="preview" type="checkbox" ${visiblePreviews.has(skill.id) ? 'checked' : ''}> 검출 이미지 보기</label>
      <div class="roi-preview-area" hidden><p class="hint roi-preview-status"></p><div class="roi-previews" hidden><figure><img class="roi-preview-raw" alt="검출한 ROI"><figcaption class="hint">ROI 원본</figcaption></figure><figure><img class="roi-preview-processed" alt="숫자 인식 입력 이미지"><figcaption class="hint">숫자 인식 입력</figcaption></figure></div></div>
      <div class="card-actions"><button data-action="edit">수정</button><button data-action="reset">다시 감지</button><button data-action="delete">삭제</button></div></article>`).join('') : '<p class="empty">등록된 스킬이 없습니다.</p>';
    for (const skill of skills) paintPreview(skill);
  }
  function openEdit(skill) {
    editing = skill?.id || null;
    $('editTitle').textContent = skill ? '스킬 수정' : '스킬 추가';
    $('name').value = skill?.name || '';
    $('cooldown').value = skill?.cooldown ?? 120;
    $('duration').value = skill?.duration ?? 120;
    updateAlertHint();
    const roi = skill ? currentRoi(skill) : null;
    draftRoi = roi ? { ...roi } : null;
    draftResolution = draftRoi ? activeResolution : null;
    updateRoiSummary();
    $('editError').textContent = '';
    $('editDialog').showModal();
  }
  function updateRoiSummary() {
    $('roiSummary').textContent = draftRoi
      ? `${draftResolution} 공유 화면의 영역이 지정되었습니다.`
      : activeResolution ? `${activeResolution} 공유 화면의 영역이 없습니다.` : '화면 공유를 시작한 뒤 영역을 지정해 주세요.';
  }
  $('add').addEventListener('click', () => openEdit(null));
  $('cancelEdit').addEventListener('click', () => $('editDialog').close());
  let oldCooldown = Number($('cooldown').value);
  $('cooldown').addEventListener('focus', () => { oldCooldown = Number($('cooldown').value); });
  $('cooldown').addEventListener('input', () => {
    if (Number($('duration').value) === oldCooldown) $('duration').value = $('cooldown').value;
    oldCooldown = Number($('cooldown').value);
    updateAlertHint();
  });
  $('duration').addEventListener('input', updateAlertHint);
  $('editForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('name').value.trim();
    if (!name || (!editing && !draftRoi)) { $('editError').textContent = !name ? '스킬 이름을 입력하세요.' : 'ROI를 먼저 지정해 주세요.'; return; }
    const cooldown = Number($('cooldown').value), duration = Number($('duration').value);
    if (!Number.isFinite(cooldown) || cooldown < 1 || !Number.isFinite(duration) || duration < 0) return;
    const skill = skills.find(x => x.id === editing);
    const rois = { ...(skill?.rois || {}) };
    if (draftRoi && draftResolution) rois[draftResolution] = draftRoi;
    const updated = skill ? { ...skill, name, cooldown, duration, ...(Object.keys(rois).length ? { rois } : {}) } : { id: crypto.randomUUID(), name, cooldown, duration, rois, enabled: true };
    const next = skill ? skills.map(x => x.id === editing ? updated : x) : [...skills, updated];
    if (!save(next)) { $('editError').textContent = '저장하지 못했습니다. 상태 메시지를 확인하세요.'; return; }
    skills = next;
    if (skill) runtime.delete(skill.id);
    $('editDialog').close(); render();
  });
  $('list').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    const skill = skills.find(x => x.id === event.target.closest('[data-id]')?.dataset.id);
    if (!button || !skill) return;
    if (button.dataset.action === 'edit') openEdit(skill);
    if (button.dataset.action === 'reset') { runtime.delete(skill.id); render(); }
    if (button.dataset.action === 'delete') { const next = skills.filter(x => x.id !== skill.id); if (save(next)) { skills = next; runtime.delete(skill.id); visiblePreviews.delete(skill.id); render(); } }
  });
  $('list').addEventListener('change', event => {
    const skill = skills.find(x => x.id === event.target.closest('[data-id]')?.dataset.id);
    if (!skill) return;
    if (event.target.dataset.action === 'preview') {
      if (event.target.checked) visiblePreviews.add(skill.id);
      else { visiblePreviews.delete(skill.id); state(skill).preview = null; }
      paintPreview(skill);
    }
    if (event.target.dataset.action === 'enable') { const next = skills.map(x => x.id === skill.id ? { ...x, enabled: event.target.checked } : x); if (save(next)) { skills = next; runtime.delete(skill.id); } render(); }
  });
  $('exportSkills').addEventListener('click', () => {
    if (skillsLocked) { $('status').textContent = '스킬 목록을 읽지 못해 백업을 만들 수 없습니다.'; return; }
    const blob = new Blob([JSON.stringify({ format: 'maple-skill-timers', version: 1, skills }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'maple-skills-backup.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('importSkills').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('백업 파일이 너무 큽니다.');
      const backup = JSON.parse(await file.text());
      if (backup?.format !== 'maple-skill-timers' || backup.version !== 1 || !Array.isArray(backup.skills) || backup.skills.length > 5000 || !backup.skills.every(window.cooldownCore.validSkill)) throw new Error('유효한 스킬 백업 파일이 아닙니다.');
      const ids = new Set(skills.map(skill => skill.id));
      const additions = [];
      for (const skill of backup.skills) {
        if (!ids.has(skill.id)) { ids.add(skill.id); additions.push(skill); }
      }
      if (additions.length && !save([...skills, ...additions])) return;
      skills = [...skills, ...additions]; render();
      $('status').textContent = `${additions.length}개의 스킬을 가져왔습니다. 기존 스킬은 유지했습니다.`;
    } catch (error) { $('status').textContent = error.message || '백업 파일을 읽지 못했습니다.'; }
    finally { input.value = ''; }
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
  function syncResolution() {
    const nextResolution = videoResolution();
    if (!stream || !nextResolution || nextResolution === activeResolution) return;
    activeResolution = nextResolution;
    const aspect = video.videoWidth / video.videoHeight;
    let migrated = 0;
    const next = skills.map(skill => {
      if (skill.rois || !window.cooldownCore.validRoi(skill.roi) || Math.abs(aspect / skill.roi.aspect - 1) > .03) return skill;
      migrated++;
      return { ...skill, rois: { [nextResolution]: { ...skill.roi } } };
    });
    if (migrated && save(next)) {
      skills = next;
      $('status').textContent = `기존 ROI ${migrated}개를 현재 공유 해상도 ${nextResolution}에 연결했습니다. 위치를 확인해 주세요.`;
    }
    for (const skill of skills) {
      const st = state(skill);
      st.samples = []; st.next = 0; st.preview = null;
      if (!st.timer) st.text = currentRoi(skill) ? '감지 대기' : '현재 해상도 ROI 미설정';
    }
    render();
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
      activeResolution = null; syncResolution();
    } catch (error) { $('status').textContent = '화면 공유를 시작하지 못했습니다: ' + error.message; }
  });
  function stop() {
    const old = stream; stream = null;
    if (old) old.getTracks().forEach(track => track.stop());
    video.srcObject = null; activeResolution = null; $('share').disabled = false; $('stop').disabled = true;
    for (const st of runtime.values()) { st.samples = []; st.preview = null; if (!st.timer) st.text = '화면 공유 대기'; }
    render();
    $('status').textContent = '화면 공유가 중지되었습니다.';
  }
  $('stop').addEventListener('click', stop);
  $('selectRoi').addEventListener('click', () => {
    if (!stream || !video.videoWidth) { $('editError').textContent = 'ROI 지정을 위해 먼저 화면 공유를 시작하세요.'; return; }
    try {
      roiCanvas.width = video.videoWidth; roiCanvas.height = video.videoHeight;
      roiFrame.width = video.videoWidth; roiFrame.height = video.videoHeight;
      roiFrameResolution = videoResolution();
      roiFrameContext.drawImage(video, 0, 0, roiFrame.width, roiFrame.height);
      beforeFit = null; $('undoRoiFit').disabled = true;
      const savedRoi = draftResolution === roiFrameResolution ? draftRoi : skills.find(skill => skill.id === editing)?.rois?.[roiFrameResolution];
      if (savedRoi) {
        const x = savedRoi.x * roiCanvas.width, y = savedRoi.y * roiCanvas.height;
        const side = Math.min(savedRoi.w * roiCanvas.width, savedRoi.h * roiCanvas.height, roiCanvas.width - x, roiCanvas.height - y);
        selection = { x, y, w: side, h: side };
      } else selection = null;
      $('roiZoom').value = '1'; $('roiZoomValue').textContent = '100%';
      $('roiError').textContent = '';
      $('editDialog').close();
      $('roiDialog').showModal(); resizeRoi(false); draw();
    } catch (error) {
      if ($('roiDialog').open) $('roiDialog').close();
      if (!$('editDialog').open) $('editDialog').showModal();
      $('editError').textContent = 'ROI 화면을 열지 못했습니다. 화면 공유를 다시 시작해 주세요.';
      console.error(error);
    }
  });
  function resizeRoi(preserveCenter = true) {
    const viewport = $('roiViewport');
    const zoom = Number($('roiZoom').value);
    const oldWidth = roiCanvas.getBoundingClientRect().width;
    const oldHeight = roiCanvas.getBoundingClientRect().height;
    const centerX = oldWidth ? (viewport.scrollLeft + viewport.clientWidth / 2) / oldWidth : .5;
    const centerY = oldHeight ? (viewport.scrollTop + viewport.clientHeight / 2) / oldHeight : .5;
    const fit = Math.min(viewport.clientWidth / roiCanvas.width, viewport.clientHeight / roiCanvas.height);
    if (!Number.isFinite(fit) || fit <= 0) return;
    roiCanvas.style.width = `${roiCanvas.width * fit * zoom}px`;
    roiCanvas.style.height = `${roiCanvas.height * fit * zoom}px`;
    if (preserveCenter) {
      viewport.scrollLeft = centerX * roiCanvas.width * fit * zoom - viewport.clientWidth / 2;
      viewport.scrollTop = centerY * roiCanvas.height * fit * zoom - viewport.clientHeight / 2;
    } else { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    $('roiZoomValue').textContent = `${Math.round(zoom * 100)}%`;
    $('roiZoomOut').disabled = zoom <= 1;
    $('roiZoomIn').disabled = zoom >= 4;
  }
  $('roiZoom').addEventListener('input', () => resizeRoi());
  for (const [id, delta] of [['roiZoomOut', -.2], ['roiZoomIn', .2]]) {
    $(id).addEventListener('click', () => {
      $('roiZoom').value = String(Math.max(1, Math.min(4, Math.round((Number($('roiZoom').value) + delta) * 10) / 10)));
      resizeRoi();
    });
  }
  window.addEventListener('resize', () => { if ($('roiDialog').open) resizeRoi(); });
  $('roiDialog').addEventListener('close', () => { if (!$('editDialog').open) $('editDialog').showModal(); });
  function draw() {
    roiCtx.drawImage(roiFrame, 0, 0);
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
  roiCanvas.addEventListener('pointerdown', event => { pointer = point(event); beforeFit = null; $('undoRoiFit').disabled = true; $('roiError').textContent = ''; roiCanvas.setPointerCapture(event.pointerId); });
  roiCanvas.addEventListener('pointermove', event => { if (pointer) move(point(event)); });
  roiCanvas.addEventListener('pointerup', event => { if (pointer) { move(point(event)); pointer = null; } });
  roiCanvas.addEventListener('pointercancel', () => { pointer = null; selection = null; draw(); });
  $('autoFitRoi').addEventListener('click', () => {
    if (!selection || selection.w < 8) { $('roiError').textContent = '먼저 스킬 아이콘 주변을 드래그하세요.'; return; }
    if (selection.w > 1000) { $('roiError').textContent = '자동 맞춤을 위해 스킬 아이콘에 더 가깝게 영역을 지정하세요.'; return; }
    const margin = Math.ceil(selection.w * .55) + 3;
    const x = Math.max(0, Math.floor(selection.x - margin));
    const y = Math.max(0, Math.floor(selection.y - margin));
    const right = Math.min(roiFrame.width, Math.ceil(selection.x + selection.w + margin));
    const bottom = Math.min(roiFrame.height, Math.ceil(selection.y + selection.h + margin));
    try {
      const image = roiFrameContext.getImageData(x, y, right - x, bottom - y);
      const result = window.fitSkillRoi(image, selection, x, y);
      if (!result) { $('roiError').textContent = '뚜렷한 사각형을 찾지 못했습니다. 영역을 더 정확히 지정해 주세요.'; return; }
      beforeFit = { ...selection };
      selection = { x: result.x, y: result.y, w: result.w, h: result.h };
      $('undoRoiFit').disabled = false;
      $('roiError').textContent = '자동 맞춤 결과를 확인하고 영역을 적용하세요.';
      draw();
    } catch (error) {
      $('roiError').textContent = '자동 맞춤에 실패했습니다. 선택한 영역을 그대로 사용할 수 있습니다.';
      console.error(error);
    }
  });
  $('undoRoiFit').addEventListener('click', () => {
    if (!beforeFit) return;
    selection = beforeFit; beforeFit = null; $('undoRoiFit').disabled = true;
    $('roiError').textContent = '자동 맞춤 전의 영역으로 되돌렸습니다.'; draw();
  });
  $('cancelRoi').addEventListener('click', () => $('roiDialog').close());
  $('saveRoi').addEventListener('click', () => {
    if (!selection || selection.w < 8 || selection.h < 8) { $('roiError').textContent = '영역을 충분히 크게 지정하세요.'; return; }
    draftRoi = { x: selection.x / roiCanvas.width, y: selection.y / roiCanvas.height, w: selection.w / roiCanvas.width, h: selection.h / roiCanvas.height, aspect: roiCanvas.width / roiCanvas.height };
    draftResolution = roiFrameResolution;
    updateRoiSummary(); $('editError').textContent = ''; $('roiDialog').close();
  });
  function loadWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      script.onload = resolve; script.onerror = () => reject(new Error('숫자 인식기를 불러오지 못했습니다.')); document.head.appendChild(script);
    }).then(async () => { const worker = await Tesseract.createWorker('eng'); await worker.setParameters({ tessedit_char_whitelist: '0123456789:', tessedit_pageseg_mode: '7' }); return worker; }).catch(error => { workerPromise = null; throw error; });
    return workerPromise;
  }
  function prepareImage(roi, showPreview) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const x = Math.max(0, Math.floor(roi.x * vw)), y = Math.max(0, Math.floor(roi.y * vh));
    const w = Math.min(vw - x, Math.max(1, Math.round(roi.w * vw))), h = Math.min(vh - y, Math.max(1, Math.round(roi.h * vh)));
    canvas.width = w; canvas.height = h; ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
    let rawPreview = null;
    if (showPreview) {
      const preview = document.createElement('canvas');
      const scale = Math.min(1, 160 / Math.max(w, h));
      preview.width = Math.max(1, Math.round(w * scale)); preview.height = Math.max(1, Math.round(h * scale));
      preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
      rawPreview = preview.toDataURL('image/png');
    }
    const image = ctx.getImageData(0, 0, w, h), data = image.data;
    let count = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    for (let i = 0; i < w * h; i++) {
      const p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2];
      const yellow = r > 145 && g > 115 && r > b * 1.25 && g > b * 1.2 && Math.abs(r - g) < 110;
      const v = yellow ? 0 : 255; data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255;
      if (yellow) { const px = i % w, py = Math.floor(i / w); minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); count++; }
    }
    if (count < 8) return { canvas: null, signature: null, rawPreview };
    ctx.putImageData(image, 0, 0);
    const out = document.createElement('canvas'), scale = Math.max(1, Math.min(5, 60 / (maxY - minY + 1)));
    out.width = Math.ceil((maxX - minX + 1) * scale) + 20; out.height = Math.ceil((maxY - minY + 1) * scale) + 20;
    const target = out.getContext('2d'); target.fillStyle = '#fff'; target.fillRect(0, 0, out.width, out.height); target.imageSmoothingEnabled = false;
    target.drawImage(canvas, minX, minY, maxX - minX + 1, maxY - minY + 1, 10, 10, out.width - 20, out.height - 20);
    return { canvas: out, signature: out.toDataURL(), rawPreview };
  }
  async function recognize(image) {
    if (Object.hasOwn(cache, image.signature) && Number.isInteger(cache[image.signature]) && cache[image.signature] >= 0 && cache[image.signature] <= 86400) return cache[image.signature];
    const worker = await loadWorker(), result = await worker.recognize(image.canvas);
    if (result.data.confidence < 65) return null;
    return window.cooldownCore.parseCooldown(result.data.text);
  }
  function confirm(skill, st) {
    const samples = st.samples.slice(-3), last = samples[2];
    const end = last.time + last.value * 1000;
    st.timer = { end, alertAt: end - skill.cooldown * 1000 + skill.duration * 1000, alerted: false };
    st.samples = [];
    for (const sample of samples) {
      if (sample.signature.length <= 100000) cache[sample.signature] = sample.value;
    }
    let keys = Object.keys(cache);
    let size = keys.reduce((sum, key) => sum + key.length + 16, 0);
    while (keys.length > 150 || size > 512000) {
      const key = keys.shift(); size -= key.length + 16; delete cache[key];
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { localStorage.setItem(cacheKey, JSON.stringify(cache)); break; }
      catch {
        keys = Object.keys(cache);
        if (!keys.length) break;
        for (const key of keys.slice(0, Math.max(1, Math.ceil(keys.length / 2)))) delete cache[key];
      }
    }
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
    syncResolution();
    const skill = skills.filter(x => x.enabled && currentRoi(x) && !state(x).timer && now >= state(x).next).sort((a, b) => state(a).next - state(b).next)[0];
    if (!skill) return;
    const st = state(skill), capturedStream = stream, capturedAt = Date.now(), capturedResolution = activeResolution;
    st.next = capturedAt + Math.max(.5, Number($('interval').value) || 1) * 1000;
    let image;
    try { image = prepareImage(currentRoi(skill), visiblePreviews.has(skill.id)); } catch { setText(skill, '영역을 읽지 못함'); return; }
    if (visiblePreviews.has(skill.id) && image.rawPreview) {
      st.preview = { raw: image.rawPreview, processed: image.signature };
      paintPreview(skill);
    }
    if (!image.canvas) { st.samples = []; setText(skill, '숫자 찾는 중'); return; }
    busy = true;
    try {
      setText(skill, '숫자 확인 중');
      const value = await recognize(image);
      if (!skills.includes(skill) || runtime.get(skill.id) !== st || stream !== capturedStream || videoResolution() !== capturedResolution) return;
      if (value === null || value > skill.cooldown || value <= 0) { st.samples = []; setText(skill, '숫자 확인 실패'); return; }
      const previous = st.samples.at(-1);
      if (previous) {
        const elapsed = (capturedAt - previous.time) / 1000, difference = previous.value - value;
        if (difference === 0 && elapsed <= Math.max(3, Number($('interval').value) * 2 + 1)) { setText(skill, `${value}초 확인 (${st.samples.length}/3)`); return; }
        if (elapsed < .25 || difference <= 0 || Math.abs(difference - elapsed) > 1.2) st.samples = [];
      }
      st.samples.push({ value, time: capturedAt, signature: image.signature });
      if (st.samples.length >= 3) { confirm(skill, st); updateTimer(skill, st, Date.now()); paintPreview(skill); }
      else setText(skill, `${value}초 확인 (${st.samples.length}/3)`);
    } catch (error) { st.samples = []; setText(skill, '숫자 인식 오류'); $('status').textContent = error.message; }
    finally { busy = false; }
  }
  volumeLabel(); render();
  if (skillsLocked) $('status').textContent = '기존 스킬 목록을 읽지 못해 덮어쓰기를 중지했습니다. 브라우저 저장소를 확인하세요.';
  setInterval(tick, 200);
})();
