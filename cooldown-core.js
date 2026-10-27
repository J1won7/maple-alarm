(() => {
  'use strict';

  function parseCooldown(text) {
    const value = String(text).trim().replace(/\s/g, '');
    if (/^\d{1,2}$/.test(value)) {
      const seconds = Number(value);
      return seconds < 60 ? seconds : null;
    }
    const match = /^(\d{1,4}):(\d{2})$/.exec(value);
    if (!match) return null;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    return minutes >= 1 && seconds < 60 ? minutes * 60 + seconds : null;
  }

  function validSkill(skill) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return false;
    const roi = skill.roi;
    return typeof skill.id === 'string' && skill.id.length > 0 && skill.id.length <= 200 &&
      typeof skill.name === 'string' && skill.name.trim().length > 0 && skill.name.length <= 40 &&
      Number.isFinite(skill.cooldown) && skill.cooldown >= 1 && skill.cooldown <= 86400 &&
      Number.isFinite(skill.duration) && skill.duration >= 0 && skill.duration <= 86400 &&
      typeof skill.enabled === 'boolean' && roi && typeof roi === 'object' &&
      [roi.x, roi.y, roi.w, roi.h, roi.aspect].every(Number.isFinite) &&
      roi.x >= 0 && roi.y >= 0 && roi.w > 0 && roi.h > 0 &&
      roi.x + roi.w <= 1.000001 && roi.y + roi.h <= 1.000001 && roi.aspect > 0;
  }

  window.cooldownCore = { parseCooldown, validSkill };
})();
