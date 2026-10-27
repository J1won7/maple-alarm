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

  function validRoi(roi) {
    return !!roi && typeof roi === 'object' && !Array.isArray(roi) &&
      [roi.x, roi.y, roi.w, roi.h, roi.aspect].every(Number.isFinite) &&
      roi.x >= 0 && roi.y >= 0 && roi.w > 0 && roi.h > 0 &&
      roi.x + roi.w <= 1.000001 && roi.y + roi.h <= 1.000001 && roi.aspect > 0;
  }

  function validSkill(skill) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return false;
    const hasLegacyRoi = validRoi(skill.roi);
    const hasRois = !!skill.rois && typeof skill.rois === 'object' && !Array.isArray(skill.rois) &&
      Object.keys(skill.rois).length > 0 && Object.entries(skill.rois).every(([key, roi]) => /^\d{1,5}x\d{1,5}$/.test(key) && validRoi(roi));
    if (skill.rois !== undefined && !hasRois) return false;
    return typeof skill.id === 'string' && skill.id.length > 0 && skill.id.length <= 200 &&
      typeof skill.name === 'string' && skill.name.trim().length > 0 && skill.name.length <= 40 &&
      Number.isFinite(skill.cooldown) && skill.cooldown >= 1 && skill.cooldown <= 86400 &&
      Number.isFinite(skill.duration) && skill.duration >= 0 && skill.duration <= 86400 &&
      typeof skill.enabled === 'boolean' && (hasLegacyRoi || hasRois);
  }

  window.cooldownCore = { parseCooldown, validRoi, validSkill };
})();
