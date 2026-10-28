const assert = require('node:assert/strict')
const { coversDisplay, shouldHideForFullscreen } = require('../../dist-electron/window/fullscreen-detect.js')
const display = { x: 0, y: 0, width: 1707, height: 1067 }

// 矩形覆盖显示器
assert.equal(coversDisplay({ left: -7, top: -7, right: 1714, bottom: 1026 }, display), false, 'maximized work-area window')
assert.equal(coversDisplay({ left: 0, top: 0, right: 1707, bottom: 1067 }, display), true, 'fullscreen window')
assert.equal(coversDisplay({ left: 1707, top: 0, right: 3414, bottom: 1067 }, display), false, 'window on another display')
console.log('PASS maximized/fullscreen display bounds')

// 只有"真正的全屏应用"才隐藏小岛
const fullscreen = { className: 'GameWindow', exStyle: 0, owner: 0, visible: true, iconic: false, left: 0, top: 0, right: 1707, bottom: 1067 }
assert.equal(shouldHideForFullscreen(fullscreen, display), true, 'borderless fullscreen app')
assert.equal(shouldHideForFullscreen({ ...fullscreen, className: 'Progman' }, display), false, 'desktop shell (Progman)')
assert.equal(shouldHideForFullscreen({ ...fullscreen, className: 'WorkerW' }, display), false, 'desktop shell (WorkerW)')
assert.equal(shouldHideForFullscreen({ ...fullscreen, className: '360DirectUICls', exStyle: 0x80 }, display), false, 'desktop organizer tool window (WS_EX_TOOLWINDOW)')
assert.equal(shouldHideForFullscreen({ ...fullscreen, exStyle: 0x08000000 }, display), false, 'no-activate overlay')
assert.equal(shouldHideForFullscreen({ ...fullscreen, owner: 123 }, display), false, 'owned window')
assert.equal(shouldHideForFullscreen({ ...fullscreen, visible: false }, display), false, 'invisible window')
assert.equal(shouldHideForFullscreen({ ...fullscreen, iconic: true }, display), false, 'minimized window')
assert.equal(shouldHideForFullscreen({ ...fullscreen, bottom: 1026 }, display), false, 'maximized to work area only')
assert.equal(shouldHideForFullscreen({ ...fullscreen, left: 1707, right: 3414 }, display), false, 'fullscreen on another display')
assert.equal(shouldHideForFullscreen(null, display), false, 'no foreground window')
console.log('PASS fullscreen foreground filtering')
