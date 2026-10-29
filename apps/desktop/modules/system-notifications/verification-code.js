;(function (root) {
  'use strict'

  // Only accept a code directly associated with an explicit label. Multiple distinct
  // candidates are ambiguous, so leave them as ordinary notifications.
  function findVerificationCode(title, content) {
    const candidates = new Set()
    for (const text of [title, content]) {
      const pattern = /(?:验证码|校验码|驗證碼|校驗碼|verification code|security code|one[- ]time (?:password|code)|otp)(?:\s*(?:是|为|為|is))?\s*[:：=]?\s*[【\[（(]?([A-Za-z0-9]{4,8})(?![A-Za-z0-9]|[-/:.])(?:[】\]）)])?/gi
      for (const match of String(text || '').matchAll(pattern)) {
        if (/\d/.test(match[1])) candidates.add(match[1])
      }
    }
    return candidates.size === 1 ? [...candidates][0] : null
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = findVerificationCode
  if (root) root.findVerificationCode = findVerificationCode
})(typeof window !== 'undefined' ? window : null)
