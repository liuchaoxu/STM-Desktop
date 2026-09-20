/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * End-to-end IPC check: boot the built app, then probe window.api from the
 * renderer to verify the preload bridge and every main-process handler.
 * Run with: npx electron scripts/ipc-check.cjs
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const out = path.join(__dirname, '..', 'out')
require(path.join(out, 'main', 'index.js')) // boots the app + registers IPC

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Save a PNG of the window, and report objective pixel statistics next to it.
 *
 * The stats matter because a structural assertion cannot tell whether the
 * backdrop is actually *visible*: `silkSd` samples a vertical strip of the
 * page's left padding (empty on every page), so a non-zero standard deviation
 * there means the animated backdrop is really painting, and comparing that strip
 * between two pages tells whether it is on or off.
 */
async function shot(win, name) {
  const dir = path.join(out, 'shots')
  fs.mkdirSync(dir, { recursive: true })
  const image = await win.webContents.capturePage()
  const file = path.join(dir, `${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  console.log(
    `SHOT ${name} ` +
      JSON.stringify({
        size: image.getSize(),
        ...stripStats(image),
        ...brandStats(image)
      })
  )
  return file
}

/** Luminance stats of the top-left brand mark (the metallic wordmark). */
function brandStats(image) {
  const { width, height } = image.getSize()
  const buf = image.toBitmap()
  const samples = []
  let max = 0
  for (let y = 6; y < Math.min(44, height); y += 2) {
    for (let x = 12; x < Math.min(62, width); x += 2) {
      const i = (y * width + x) * 4
      if (i + 2 >= buf.length) continue
      const lum = (buf[i] + buf[i + 1] + buf[i + 2]) / 3
      samples.push(lum)
      if (lum > max) max = lum
    }
  }
  if (samples.length === 0) return { brandMax: 0, brandMean: 0, brandSd: 0 }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length)
  return { brandMean: +mean.toFixed(1), brandMax: +max.toFixed(1), brandSd: +sd.toFixed(1) }
}

/** Luminance samples of a vertical strip inside the page's left padding. */
function stripSamples(image) {
  const { width, height } = image.getSize()
  const buf = image.toBitmap()
  const samples = []
  for (let y = Math.round(height * 0.2); y < height - Math.round(height * 0.06); y += 5) {
    for (let x = 4; x < 12; x++) {
      const i = (y * width + x) * 4
      if (i + 2 >= buf.length) continue
      samples.push((buf[i] + buf[i + 1] + buf[i + 2]) / 3)
    }
  }
  return samples
}

function stripStats(image) {
  const samples = stripSamples(image)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length)
  return {
    silkMean: +mean.toFixed(2),
    silkSd: +sd.toFixed(2),
    silkMin: +Math.min(...samples).toFixed(1),
    silkMax: +Math.max(...samples).toFixed(1)
  }
}

/** How much that strip changed between two captures: a non-zero result means the
 *  backdrop is animating rather than showing a frozen frame. */
function stripDiff(fileA, fileB) {
  const a = stripSamples(nativeImage.createFromPath(fileA))
  const b = stripSamples(nativeImage.createFromPath(fileB))
  const n = Math.min(a.length, b.length)
  let changed = 0
  let sumAbs = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i])
    sumAbs += d
    if (d > 1) changed++
  }
  return {
    meanAbsDiff: +(sumAbs / n).toFixed(3),
    changedPct: +((changed / n) * 100).toFixed(1),
    samples: n
  }
}

app.whenReady().then(async () => {
  try {
    let win = null
    for (let i = 0; i < 60; i++) {
      win = BrowserWindow.getAllWindows()[0] || null
      if (win) break
      await wait(100)
    }
    if (!win) throw new Error('no window created')

    // Chromium throttles requestAnimationFrame for a hidden window, which would
    // silently invalidate every animation assertion below (the marquee, the dock
    // magnification, the shader backdrops): the app shows its window on
    // ready-to-show, but Windows occlusion detection still reports it as hidden
    // as soon as another window covers it, so the probe pins it on top for the
    // run. Everything measured here must happen on a visible window.
    win.show()
    win.setAlwaysOnTop(true)
    win.focus()
    await wait(500)
    console.log(
      'WINDOW ' +
        JSON.stringify({
          visible: win.isVisible(),
          minimized: win.isMinimized(),
          focused: win.isFocused(),
          visibility: await win.webContents.executeJavaScript('document.visibilityState')
        })
    )

    // Poll until the renderer is ready to answer.
    let result = null
    for (let i = 0; i < 60; i++) {
      try {
        result = await win.webContents.executeJavaScript(
          `(async () => {
             const info = await window.api.app.info()
             const before = await window.api.config.get()
             const tunnels = await window.api.tunnel.list()
             const pathInfo = await window.api.config.getPath()
             const logs = await window.api.tunnel.logs('all', 10)

             // Prove the credential path end to end: save a password, read it
             // back from a fresh load (which can only work if it was stored and
             // decrypted again), then restore the original configuration.
             const probe = {
               defaults: {},
               groups: [
                 {
                   name: 'probe',
                   values: { server: 'srv', username: 'u', password: 'PROBE-SECRET-1234' }
                 }
               ],
               tunnels: [
                 {
                   group: 'probe',
                   name: 't',
                   values: { local_port: '1', remote_host: 'h', remote_port: '2' }
                 }
               ]
             }
             await window.api.config.save(probe)
             const reread = await window.api.config.reload()
             const roundTrip =
               !!reread.groups[0] && reread.groups[0].values.password === 'PROBE-SECRET-1234'
             await window.api.config.save(before)

             return {
               ok: true,
               platform: info.platform,
               ssh: !!info.sshPath,
               plink: !!info.plinkPath,
               secretsEncrypted: !!info.secretsEncrypted,
               secretRoundTrip: roundTrip,
               configPath: info.configPath,
               cfgDefaults: Object.keys(before.defaults).length,
               cfgGroups: before.groups.length,
               cfgTunnels: before.tunnels.length,
               tunnels: tunnels.length,
               logs: logs.length
             }
           })()`
        )
        if (result && result.ok) break
      } catch {
        result = null
      }
      await wait(250)
    }
    if (!result) throw new Error('renderer never answered')

    // UI probe: the config page must be a card overview that drills into a
    // group, with each tunnel inside it as its own expandable card.
    const ui = await win.webContents.executeJavaScript(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const tabs = [...document.querySelectorAll('.specular-btn')]
         const tab = tabs.find((t) => t.textContent.trim() === '配置')
         if (!tab) return { error: 'config tab not found', navLabels: tabs.map((t) => t.textContent.trim()) }
         const currentTab = () => tabs.findIndex((t) => t.getAttribute('aria-current') === 'page')
         const nav = {
           labels: tabs.map((t) => t.textContent.trim()),
           canvases: tabs.filter((t) => !!t.querySelector('canvas')).length,
           webgl2: tabs.every((t) => {
             const c = t.querySelector('canvas')
             return !!c && !!c.getContext('webgl2')
           }),
           sized: tabs.every((t) => {
             const c = t.querySelector('canvas')
             return !!c && c.width > 0 && c.height > 0
           }),
           activeBefore: currentTab()
         }

         // The left-hand brand block is now only the metallic wordmark; the
         // config path and the subtitle must be gone from the header.
         // NOTE: the canvas *is* the brand-mark element (class fall-through), and
         // its box matters: a canvas far wider than the artwork makes the
         // shader contain-fit shrink the wordmark to a sliver. No backticks in
         // here — this whole block is inside a template literal.
         const brandCanvas = document.querySelector('canvas.brand-mark')
         const brand = {
           canvas: !!brandCanvas,
           webgl2: brandCanvas ? !!brandCanvas.getContext('webgl2') : false,
           sized: brandCanvas ? brandCanvas.width > 0 && brandCanvas.height > 0 : false,
           box: brandCanvas
             ? brandCanvas.clientWidth + 'x' + brandCanvas.clientHeight
             : 'none',
           pathChipGone: !document.querySelector('.app-header')?.textContent.includes('.conf'),
           subtitleGone: !document.querySelector('.app-header')?.textContent.includes('隧道管理器')
         }

         // The header's status strip is a LogoLoop: the sequence is duplicated
         // (copies after the first are aria-hidden) and the track translates.
         const loopTrack = document.querySelector('.logoloop-track')
         const loopRoot = document.querySelector('.logoloop')
         const loopChips = [...document.querySelectorAll('.logoloop .meta-chip')]
         const loopItems = [...document.querySelectorAll('.logoloop-item')]
         const sample = loopChips[0] ? getComputedStyle(loopChips[0]) : null
         // Two chips with the same label fully inside the viewport would be a
         // visible repeat - the whole point of the fitContent width.
         const seen = {}
         if (loopRoot) {
           const rootRect = loopRoot.getBoundingClientRect()
           loopChips.forEach((chip) => {
             const r = chip.getBoundingClientRect()
             if (r.left >= rootRect.left - 1 && r.right <= rootRect.right + 1) {
               const text = chip.textContent.trim()
               seen[text] = (seen[text] || 0) + 1
             }
           })
         }
         const loop = {
           present: !!loopTrack,
           overflowY: loopRoot ? getComputedStyle(loopRoot).overflowY : '',
           vOverflow: loopRoot ? loopRoot.scrollHeight - loopRoot.clientHeight : 0,
           hOverflow: loopRoot ? loopRoot.scrollWidth - loopRoot.clientWidth : 0,
           copies: document.querySelectorAll('.logoloop-track > ul').length,
           hiddenCopies: document.querySelectorAll('.logoloop-track > ul[aria-hidden="true"]').length,
           chips: loopChips.length,
           labels: [...new Set(loopChips.map((chip) => chip.textContent.trim()))],
           width: loopRoot ? Math.round(loopRoot.getBoundingClientRect().width) : 0,
           gap: loopItems.length > 1 ? getComputedStyle(loopItems[0]).marginRight : '',
           itemClass: loopItems[0] ? loopItems[0].className : '',
           rootStyle: loopRoot ? loopRoot.getAttribute('style') : '',
           gapVar: loopRoot
             ? getComputedStyle(loopRoot).getPropertyValue('--logoloop-gap').trim()
             : '',
           // Does the Tailwind arbitrary-value utility apply at all in this setup?
           // (A detached probe isolates the utility from the marquee's own DOM.)
           gapProbe: (() => {
             const probe = document.createElement('li')
             probe.className = 'mr-[var(--logoloop-gap)]'
             probe.style.setProperty('--logoloop-gap', '33px')
             document.body.appendChild(probe)
             const value = getComputedStyle(probe).marginRight
             probe.remove()
             return value
           })(),
           maxVisibleRepeat: Math.max(0, ...Object.values(seen)),
           // Read both spellings: the CSS build prefixes this property, so the
           // standard one can be absent while the effect is live.
           glass: sample
             ? /blur/.test(
                 String(sample.backdropFilter || sample.webkitBackdropFilter || '')
               )
             : false,
           sheen: sample ? getComputedStyle(loopChips[0], '::after').animationName : '',
           startTransform: loopTrack ? loopTrack.style.transform : ''
         }

         // Anything inside the header that can actually show a scrollbar. The
         // marquee sets overflow-x to hidden, which computes overflow-y to auto,
         // so an item a couple of pixels taller silently becomes a vertical
         // scrollbar on the header. No backticks in here (template literal).
         const headerScrollers = []
         document.querySelectorAll('.app-header *').forEach((el) => {
           const oy = getComputedStyle(el).overflowY
           if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
             headerScrollers.push(
               String(el.className || el.tagName) + ':' + (el.scrollHeight - el.clientHeight)
             )
           }
         })

         // The action row is a Dock; its items carry the labels (pill variant).
         const dockPanel = document.querySelector('.dock-panel')
         const dock = {
           present: !!dockPanel,
           items: dockPanel ? dockPanel.querySelectorAll('.dock-item').length : 0,
           labels: dockPanel
             ? [...dockPanel.querySelectorAll('.dock-label')].map((l) => l.textContent.trim())
             : []
         }

         // The action row must stay put while the page scrolls.
         const toolbar = document.querySelector('.toolbar')
         const sticky = toolbar ? getComputedStyle(toolbar).position === 'sticky' : false

         // Silk backdrop (WebGL): present, sized, and actually holding a context.
         const canvas = document.querySelector('.silk-backdrop canvas')
         const backdrop = {
           present: !!canvas,
           webgl: canvas ? !!(canvas.getContext('webgl2') || canvas.getContext('webgl')) : false,
           sized: canvas ? canvas.width > 0 && canvas.height > 0 : false
         }

         tab.click()
         await sleep(700)
         const activeIndex = currentTab()

         const cards = [...document.querySelectorAll('.section-card')]
         const titles = cards.map((c) => c.querySelector('.section-title')?.textContent?.trim())
         const hasEditGroup = [...cards[1].querySelectorAll('button')].some(
           (b) => b.textContent.trim() === '编辑组'
         )

         // Enter the group.
         cards[1].querySelector('.section-body').click()
         await sleep(500)
         const inGroup = !!document.querySelector('.detail-head')
         const tunnelCards = document.querySelectorAll('.tunnel-card').length

         // Expand a tunnel card.
         document.querySelector('.tunnel-card .section-body')?.click()
         await sleep(500)
         const expanded = !!document.querySelector('.tunnel-card.is-open')
         const expandedFields = document.querySelectorAll('.tunnel-card.is-open .form-grid .field').length

         // Collapse, then go back to the overview.
         document.querySelector('.tunnel-card.is-open .section-body')?.click()
         await sleep(450)
         const collapsed = !document.querySelector('.tunnel-card.is-open')
         document.querySelector('.detail-head .btn')?.click()
         await sleep(500)
         const backToOverview = document.querySelectorAll('.section-card').length === cards.length

         // The backdrop is for 隧道 / 配置 only: it must be hidden on 日志.
         const logsTab = tabs.find((t) => t.textContent.trim() === '日志')
         logsTab?.click()
         await sleep(400)
         const backdropHiddenOnLogs =
           getComputedStyle(document.querySelector('.silk-backdrop')).display === 'none'

         return {
           nav,
           brand,
           loop,
           headerScrollers,
           dock,
           sticky,
           backdrop,
           activeIndex,
           cardTitles: titles,
           hasEditGroup,
           enteredGroup: inGroup,
           tunnelCards,
           expanded,
           expandedFields,
           collapsed,
           backToOverview,
           backdropHiddenOnLogs
         }
       })()`
    )

    console.log('IPC CHECK OK ' + JSON.stringify({ ...result, ui }))

    // Screenshot tour: lets a reviewer actually look at the result instead of
    // trusting a structural assertion.
    const goTo = async (body, ms = 900) => {
      await win.webContents.executeJavaScript(
        `(async () => { const sleep = (t) => new Promise((r) => setTimeout(r, t)); ${body}; await sleep(${ms}) })()`
      )
    }
    const clickTab = (label) =>
      `[...document.querySelectorAll('.specular-btn')].find((t) => t.textContent.trim() === '${label}')?.click()`
    const state = () =>
      win.webContents.executeJavaScript(`(() => {
        const tabs = [...document.querySelectorAll('.specular-btn')]
        const backdrop = document.querySelector('.silk-backdrop')
        // Count non-transparent pixels on a sampled grid: proves the canvas is not
        // just present and sized, but actually has a border drawn on it.
        const inkPixels = (canvas) => {
          const ctx = canvas.getContext('2d')
          if (!ctx || !canvas.width || !canvas.height) return -1
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
          let ink = 0
          for (let i = 3; i < data.length; i += 64) if (data[i] > 8) ink++
          return ink
        }
        // Electric borders: every tunnel row and log box is wrapped, but only the
        // running/connecting rows and non-empty log boxes are switched on.
        const rowHosts = [...document.querySelectorAll('.tunnel-row.electric-border')]
        const logHosts = [...document.querySelectorAll('.log-card .electric-border')]
        const liveCanvas = document.querySelector('.electric-border.is-active canvas')
        return {
          tab: tabs.findIndex((t) => t.getAttribute('aria-current') === 'page'),
          backdrop: backdrop ? getComputedStyle(backdrop).display : 'missing',
          cards: document.querySelectorAll('.section-card').length,
          tunnels: document.querySelectorAll('.tunnel-card').length,
          modal: document.querySelectorAll('.modal-wide').length,
          rowBorders: rowHosts.length,
          rowBordersActive: rowHosts.filter((el) => el.classList.contains('is-active')).length,
          logBorders: logHosts.length,
          logBordersActive: logHosts.filter((el) => el.classList.contains('is-active')).length,
          borderCanvas: liveCanvas
            ? { w: liveCanvas.width, h: liveCanvas.height, ink: inkPixels(liveCanvas) }
            : null
        }
      })()`)

    const tour = [
      ['01-tunnels-silk', clickTab('隧道')],
      ['02-config-overview', clickTab('配置')],
      ['03-group-detail', `document.querySelectorAll('.section-card .section-body')[1]?.click()`],
      ['04-tunnel-expanded', `document.querySelector('.tunnel-card .section-body')?.click()`],
      [
        '05-group-editor',
        `[...document.querySelectorAll('.detail-head button')].find((b) => b.textContent.trim() === '编辑组')?.click()`
      ],
      ['06-logs', clickTab('日志')]
    ]
    for (const [name, body] of tour) {
      await goTo(body)
      console.log(`STATE ${name} ${JSON.stringify(await state())}`)
      await shot(win, name)
    }

    // Hover a card's top edge so the BorderGlow is actually visible in a shot
    // (the plain captures never have the pointer over a card).
    await goTo(clickTab('配置'))
    const edge = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.section-card')
      if (!card) return null
      const r = card.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 3) }
    })()`)
    if (edge) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: edge.x, y: edge.y })
      await wait(800)
      await shot(win, '07-card-glow-hover')
    } else {
      console.log('SHOT 07-card-glow-hover skipped (no card found)')
    }

    // Hover a nav button so the specular light is visible in a shot, then scroll
    // the page to show the action row staying put.
    const tabBox = await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('.specular-btn')].find((b) => b.textContent.trim() === '配置')
      if (!t) return null
      const r = t.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (tabBox) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: tabBox.x, y: tabBox.y })
      await wait(900)
      await shot(win, '08-nav-specular-hover')
    }
    await goTo(`document.querySelector('.app-main').scrollTop = 400`, 600)
    await shot(win, '09-sticky-toolbar-scrolled')
    await goTo(`document.querySelector('.app-main').scrollTop = 0`, 400)

    // LogoLoop: the marquee has to actually be scrolling, not just be present.
    // Park the pointer in a far corner first: the loop pauses on hover, and the
    // previous step left the simulated pointer over a nav tab.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 700 })
    await wait(400)
    const loopInfo = () =>
      win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.logoloop')
        const track = document.querySelector('.logoloop-track')
        const slot = document.querySelector('.status-slot')
        const nav = document.querySelector('.app-header nav')
        const box = (n) => {
          if (!n) return null
          const b = n.getBoundingClientRect()
          return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]
        }
        return {
          hidden: document.hidden,
          reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches === true,
          hovered: el ? el.matches(':hover') : null,
          trackHovered: track ? track.matches(':hover') : null,
          nav: box(nav),
          slot: box(slot),
          loop: box(el),
          transform: track ? track.style.transform : ''
        }
      })()`)
    const loopT1 = await loopInfo()
    await wait(900)
    const loopT2 = await loopInfo()
    console.log(
      'LOGOLOOP MOVE ' +
        JSON.stringify({
          from: loopT1.transform,
          to: loopT2.transform,
          moved: !!loopT1.transform && loopT1.transform !== loopT2.transform,
          hidden: loopT1.hidden,
          reduced: loopT1.reduced,
          hovered: loopT1.hovered,
          trackHovered: loopT1.trackHovered,
          nav: loopT1.nav,
          slot: loopT1.slot,
          loop: loopT1.loop
        })
    )

    // Dock magnification: put the pointer on the first item and watch it grow.
    const dockBox = await win.webContents.executeJavaScript(`(() => {
      const item = document.querySelector('.dock-item')
      if (!item) return null
      const r = item.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (dockBox) {
      const heightOf = () =>
        win.webContents.executeJavaScript(`document.querySelector('.dock-item')?.clientHeight ?? 0`)
      const before = await heightOf()
      // What is actually under that point, and is the page still visible? A
      // magnification that "does not happen" has to be told apart from a pointer
      // that never arrived.
      const at = await win.webContents.executeJavaScript(`(() => {
        const el = document.elementFromPoint(${dockBox.x}, ${dockBox.y})
        const item = document.querySelector('.dock-item')
        const r = item ? item.getBoundingClientRect() : null
        return {
          hidden: document.hidden,
          under: el ? String(el.className || el.tagName) : null,
          itemBox: r
            ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
            : null
        }
      })()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: dockBox.x, y: dockBox.y })
      await wait(400)
      const mid = await heightOf()
      await wait(700)
      const after = await heightOf()
      console.log(
        'DOCK MAGNIFY ' +
          JSON.stringify({ baseHeight: before, midHeight: mid, hoveredHeight: after, at })
      )
      await shot(win, '10-dock-hover')
    } else {
      console.log('DOCK MAGNIFY skipped (no dock item found)')
    }

    // ElectricBorder on tunnel rows. Nothing runs in this probe — starting a
    // tunnel would open a real SSH connection to the user's server — so the app's
    // own "connecting" condition is fabricated instead: a state file whose pid is
    // alive (this very process) but whose local port never opened. That exercises
    // the real status pipeline, not a mock of it.
    const runtime = await win.webContents.executeJavaScript(`(async () => {
      const info = await window.api.app.info()
      const tunnels = await window.api.tunnel.list()
      return {
        dir: info.runtimeDir,
        first: tunnels[0] ? { key: tunnels[0].key, state: tunnels[0].state } : null
      }
    })()`)
    if (runtime.first) {
      const stem = String(runtime.first.key).replace(/[^A-Za-z0-9._-]/g, '_')
      const stateFile = path.join(runtime.dir, `${stem}.json`)
      const backup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null
      fs.mkdirSync(runtime.dir, { recursive: true })
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          pid: process.pid,
          client: 'ssh',
          startedAt: Date.now(),
          executable: 'ssh'
        })
      )
      await goTo(clickTab('隧道'), 2800) // the tunnel store refreshes every 2s
      const fabricated = await state()
      console.log(
        'ROW BORDER ' +
          JSON.stringify({ key: runtime.first.key, was: runtime.first.state, ...fabricated })
      )
      await shot(win, '11-row-electric-border')
      // Restore: this fabricated pid dies with the probe, and the app drops a
      // stale state file on its next refresh anyway.
      if (backup) fs.writeFileSync(stateFile, backup)
      else fs.rmSync(stateFile, { force: true })
      await goTo(`void window.api.tunnel.list()`, 300)
    } else {
      console.log('ROW BORDER skipped (no tunnel to point at)')
    }

    // Two captures of the same page, ~0.7 s apart: proves the shader animates.
    await goTo(clickTab('隧道'))
    const before = path.join(out, 'shots', 'silk-before.png')
    const after = path.join(out, 'shots', 'silk-after.png')
    fs.writeFileSync(before, (await win.webContents.capturePage()).toPNG())
    await wait(700)
    fs.writeFileSync(after, (await win.webContents.capturePage()).toPNG())
    console.log('SILK ANIMATION ' + JSON.stringify(stripDiff(before, after)))

    process.exitCode = 0
  } catch (error) {
    console.error('IPC CHECK FAILED: ' + (error && error.message ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
