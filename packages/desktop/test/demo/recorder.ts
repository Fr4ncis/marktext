import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from 'playwright'

// Screen recording for issue walkthroughs.
//
// Playwright's `recordVideo` is accepted by `_electron.launch` but the app never
// finishes loading with it on, so video of an Electron window has to be built
// the long way: screenshot the page on a timer, then stitch the frames with
// ffmpeg. That has a second advantage for anything published — a frame only ever
// contains the app's own window, never whatever else is on the machine's screen.
//
// Captions are injected into the page rather than burned in afterwards, so they
// scroll with the recording and need no timing bookkeeping. Title cards are
// rendered by ffmpeg because at that point in a run there may be no window open.

const FONT = '/System/Library/Fonts/Menlo.ttc'
const BACKDROP = '0x0f1115'

type Segment =
  | { kind: 'frames'; dir: string; fps: number }
  | { kind: 'card'; file: string; seconds: number }

export interface CardOptions {
  /** Seconds the card stays on screen. Long enough to read, no longer. */
  seconds?: number
  fontSize?: number
  color?: string
}

export class Recorder {
  private readonly root: string
  private readonly fps: number
  private readonly segments: Segment[] = []
  private page: Page | null = null
  private timer: NodeJS.Timeout | null = null
  private clip: { dir: string; index: number } | null = null
  private busy = false
  private cards = 0

  constructor(root: string, fps = 6) {
    this.root = root
    this.fps = fps
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
  }

  /** Points the recorder at a window. Call again after a relaunch. */
  use(page: Page): void {
    this.page = page
  }

  async caption(text: string, sub?: string): Promise<void> {
    if (!this.page) return
    await this.page
      .evaluate(
        (args) => {
          const id = '__demo_caption__'
          let el = document.getElementById(id)
          if (!el) {
            el = document.createElement('div')
            el.id = id
            el.style.cssText = [
              'position:fixed',
              'left:0',
              'right:0',
              'bottom:0',
              'z-index:2147483647',
              'padding:14px 22px',
              'background:rgba(10,12,16,0.93)',
              'color:#f4f6fb',
              'font:600 19px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
              'pointer-events:none',
              'box-shadow:0 -1px 0 rgba(255,255,255,0.08)'
            ].join(';')
            document.body.appendChild(el)
          }
          el.textContent = ''
          const main = document.createElement('div')
          main.textContent = args.text
          el.appendChild(main)
          if (args.sub) {
            const sub = document.createElement('div')
            sub.textContent = args.sub
            sub.style.cssText =
              'margin-top:5px;font:400 14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa4b2'
            el.appendChild(sub)
          }
        },
        { text, sub }
      )
      // A window that closed mid-caption is not worth failing a recording over.
      .catch(() => {})
  }

  startClip(name: string): void {
    const dir = path.join(this.root, `clip-${String(this.segments.length).padStart(2, '0')}-${name}`)
    fs.mkdirSync(dir, { recursive: true })
    this.clip = { dir, index: 0 }
    this.timer = setInterval(() => {
      this.grab().catch(() => {})
    }, Math.round(1000 / this.fps))
  }

  async stopClip(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Let an in-flight screenshot finish before the directory is read.
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 30))
    if (this.clip && fs.readdirSync(this.clip.dir).length > 0) {
      this.segments.push({ kind: 'frames', dir: this.clip.dir, fps: this.fps })
    }
    this.clip = null
  }

  private async grab(): Promise<void> {
    if (this.busy || !this.page || !this.clip || this.page.isClosed()) return
    this.busy = true
    const file = path.join(this.clip.dir, `f-${String(this.clip.index++).padStart(5, '0')}.png`)
    try {
      await this.page.screenshot({ path: file, timeout: 5000 })
    } catch {
      // Dropped frames are fine; a window mid-teardown just yields fewer of them.
    } finally {
      this.busy = false
    }
  }

  /** Holds the current view on screen, so a viewer has time to read it. */
  async hold(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  card(lines: string[], options: CardOptions = {}): void {
    const { seconds = 3.5, fontSize = 30, color = 'white' } = options
    const file = path.join(this.root, `card-${String(this.cards++).padStart(2, '0')}.png`)
    const textFile = `${file}.txt`
    fs.writeFileSync(textFile, `${lines.join('\n')}\n`)
    const draw = [
      `fontfile=${FONT}`,
      `textfile=${textFile}`,
      `fontcolor=${color}`,
      `fontsize=${fontSize}`,
      'line_spacing=14',
      'x=70',
      'y=(h-th)/2'
    ].join(':')
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', `color=c=${BACKDROP}:s=1280x800:d=1`,
      '-vf', `drawtext=${draw}`,
      '-frames:v', '1',
      '-y', file
    ])
    this.segments.push({ kind: 'card', file, seconds })
  }

  /**
   * Encodes every segment to a common canvas and concatenates them.
   *
   * Per-segment encoding is what allows the two windows to be filmed in one
   * video: the main window is 1200x800 and preferences is 950x650, so each
   * segment is scaled and padded to the same frame rather than assuming one size.
   */
  assemble(outFile: string): string {
    const parts: string[] = []
    const fit =
      'scale=1280:800:force_original_aspect_ratio=decrease,' +
      `pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=${BACKDROP}`

    this.segments.forEach((segment, index) => {
      const part = path.join(this.root, `part-${String(index).padStart(2, '0')}.mp4`)
      if (segment.kind === 'frames') {
        execFileSync('ffmpeg', [
          '-v', 'error',
          '-framerate', String(segment.fps),
          '-pattern_type', 'glob',
          '-i', path.join(segment.dir, '*.png'),
          '-vf', fit,
          '-r', '30',
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-y', part
        ])
      } else {
        execFileSync('ffmpeg', [
          '-v', 'error',
          '-loop', '1',
          '-t', String(segment.seconds),
          '-i', segment.file,
          '-vf', fit,
          '-r', '30',
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-y', part
        ])
      }
      parts.push(part)
    })

    const list = path.join(this.root, 'concat.txt')
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'))
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', list,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', outFile
    ])
    return outFile
  }
}
