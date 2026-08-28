// A detail panel that adapts to the viewport.
//
// Same content, two shapes, because the same shape does not work in both places:
//
//   narrow  -> a sheet that rises from the bottom over the map, the way a phone
//              app does it. The map is small on a phone, so covering most of it
//              is the right trade while you read.
//   wide    -> a column docked to the left edge, sliding in horizontally. The map
//              stays fully visible and keeps its context; a bottom sheet on a
//              1440-wide window would waste the width and hide the city.
//
// The breakpoint is the one the settings panel already uses, so the app has one
// idea of "narrow" rather than two.
//
// The shell knows nothing about vehicles or stations. It takes a title, an accent
// colour and a body element, and handles the parts that are easy to get wrong:
// Escape, the close button, scroll position, and not trapping the page when it is
// closed.

export interface PanelContent {
  /** Big line at the top — a line name, a stop name. */
  title: string
  /** Quieter line under it — a destination, a mode. */
  subtitle?: string
  /** Colour of the header strip. Usually the line colour. */
  accent?: string
  /** Text colour to use on `accent`. */
  accentText?: string
  /** The scrolling content. */
  body: HTMLElement
  /** Show the Back control — there is a previous panel of ours to return to. */
  canGoBack?: boolean
  /**
   * How much of a phone screen the sheet may take. Ignored on a wide window, where
   * the panel is a full-height column and its width is what matters.
   *
   * `'tall'` suits a list you read on its own, like a departure board — you want as
   * many rows at once as possible, and the map is not part of the answer.
   *
   * `'short'` suits content that is ABOUT something on the map. A vehicle's journey
   * is only half the story; the other half is where the vehicle is, and a sheet over
   * four fifths of a phone left too little map to see it in.
   */
  size?: 'tall' | 'short'
}

const COMPACT_MAX_WIDTH = 720

export class Panel {
  private readonly root: HTMLElement
  private readonly header: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly subtitleEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly closeBtn: HTMLButtonElement
  private readonly backBtn: HTMLButtonElement
  private open = false
  /** Called when the user closes it — by button, Escape or a tap outside. */
  onClose: (() => void) | null = null
  /** Called when the user presses Back. */
  onBack: (() => void) | null = null

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('aside')
    this.root.id = 'detail'
    this.root.hidden = true
    // A dialog by behaviour, so assistive tech announces it as one and does not
    // read the map underneath as part of it.
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'false')
    this.root.setAttribute('aria-label', 'Details')

    this.header = document.createElement('div')
    this.header.className = 'detail-head'
    const text = document.createElement('div')
    text.className = 'detail-headtext'
    this.titleEl = document.createElement('h2')
    this.titleEl.className = 'detail-title'
    this.subtitleEl = document.createElement('p')
    this.subtitleEl.className = 'detail-sub'
    text.append(this.titleEl, this.subtitleEl)

    /*
     * Back AND close, on both layouts.
     *
     * They do different things and both are needed. Following a stop's board into
     * a vehicle's journey and then into another stop's board is a natural path, so
     * Back has to step one link at a time. Close has to get out of all of it in one
     * press — a reader three levels deep should not have to tap Back three times to
     * see the map again.
     *
     * Back is only shown when there is somewhere of ours to go back to, so it is
     * never a dead control.
     */
    this.backBtn = document.createElement('button')
    this.backBtn.type = 'button'
    this.backBtn.className = 'detail-back'
    this.backBtn.setAttribute('aria-label', 'Back')
    this.backBtn.textContent = '‹'
    this.backBtn.hidden = true
    this.backBtn.onclick = () => this.onBack?.()

    this.closeBtn = document.createElement('button')
    this.closeBtn.type = 'button'
    this.closeBtn.className = 'detail-close'
    this.closeBtn.setAttribute('aria-label', 'Close')
    this.closeBtn.textContent = '✕'
    this.closeBtn.onclick = () => this.requestClose()

    this.header.append(this.backBtn, text, this.closeBtn)
    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'detail-body'
    this.root.append(this.header, this.bodyEl)
    parent.append(this.root)

    // Escape closes, but only when this panel is the thing on screen — otherwise
    // it would swallow the key from anything else that wants it.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.open) {
        e.stopPropagation()
        this.requestClose()
      }
    })
  }

  /** True while the panel is on screen. */
  get isOpen(): boolean {
    return this.open
  }

  /** True when the layout is the phone-style bottom sheet. */
  static get isCompact(): boolean {
    return matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`).matches
  }

  /**
   * Show `content`. Replaces whatever was shown; the scroll position resets, since
   * a new subject read from halfway down would be confusing.
   */
  show(content: PanelContent): void {
    this.titleEl.textContent = content.title
    this.subtitleEl.textContent = content.subtitle ?? ''
    this.subtitleEl.hidden = !content.subtitle
    const accent = content.accent ?? '#333333'
    this.header.style.background = accent
    this.header.style.color = content.accentText ?? '#ffffff'
    this.closeBtn.style.color = content.accentText ?? '#ffffff'
    this.backBtn.style.color = content.accentText ?? '#ffffff'
    this.backBtn.hidden = !content.canGoBack
    this.root.classList.toggle('is-short', content.size === 'short')
    this.bodyEl.replaceChildren(content.body)
    this.bodyEl.scrollTop = 0
    this.root.setAttribute('aria-label', content.title)
    if (!this.open) {
      this.root.hidden = false
      // one frame before adding the class, or the transition has nothing to run from
      requestAnimationFrame(() => this.root.classList.add('is-open'))
      this.open = true
      document.body.classList.add('detail-open')
    }
  }

  /** Replace only the body, keeping the header and the scroll position. */
  updateBody(body: HTMLElement): void {
    const top = this.bodyEl.scrollTop
    this.bodyEl.replaceChildren(body)
    this.bodyEl.scrollTop = top
  }

  /** The scrolling element, for content that wants to position itself in it. */
  get scroller(): HTMLElement {
    return this.bodyEl
  }

  /** Where the panel sits, so the map can keep clear of it. `null` when closed. */
  get occupies(): {left: number; top: number; right: number; bottom: number} | null {
    if (!this.open) return null
    const r = this.root.getBoundingClientRect()
    return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}
  }

  /** Close without telling the caller — for when the caller closed it. */
  hide(): void {
    if (!this.open) return
    this.open = false
    this.root.classList.remove('is-open')
    document.body.classList.remove('detail-open')
    // wait out the slide before removing it from the tree
    const done = () => { if (!this.open) this.root.hidden = true }
    setTimeout(done, 250)
  }

  private requestClose(): void {
    this.hide()
    this.onClose?.()
  }
}
