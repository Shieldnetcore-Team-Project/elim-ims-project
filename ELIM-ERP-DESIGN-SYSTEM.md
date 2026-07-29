# Design system

Modern, professional, minimal. Blue and white, light and dark, keyboard-first.

---

## Dark mode is not an inversion

Three things change beyond swapping black for white. Getting them wrong is what
makes most dark themes uncomfortable rather than merely dark.

**Elevation reverses.** In light mode a card is white on grey — it advances by
being *brighter* than the page. In dark mode it must be *lighter* than the page
for the same reason. Invert literally and raised surfaces become darker, which
reads as a hole rather than a card. Hence `--surface` `#071624` → `--card`
`#0E2334` → `--raised` `#16304A`.

**Saturated colour has to come down.** A fully saturated red on near-black
halates: the edges bloom and text inside it vibrates. Dark-mode semantic colours
are *lighter and less saturated* than their light counterparts, not darker.
`--stop` goes from `#B91C1C` to `#F87171`.

**Neither end is pure.** Black on white is about 21:1, which is genuinely tiring
over an eight-hour shift. The page is a very dark blue-grey; the text is a soft
off-white.

This matters here more than in most systems. Shift C runs 22:00 to 06:00 and the
people on it are reading this screen in a dark room.

### One set of classes, two sets of values

Every colour resolves to a CSS custom property. A component writes `bg-card` and
`text-ink-900` once and is correct in both themes — no `dark:` variants through
the markup, no element that stays stubbornly white because someone forgot one.

The trade-off, stated plainly: `ink-900` means "darkest brand navy" in light mode
and "primary text" in dark. The name is slightly wrong in one of the two. Renaming
it would have touched every component for a semantic tidy-up, and I judged that a
bad trade. The sidebar has its own `rail-*` scale precisely because it does *not*
invert — it is the brand anchor and stays the darkest surface in both themes.

An inline script in `index.html` applies the stored theme before first paint, so
a dark-mode user never gets a white flash on load.

---

## Charts

`ChartCard` + `TrendChart` + `ComparisonChart`, themed through `useChartTheme`,
which reads the live CSS variables so charts follow the theme rather than carrying
a second palette that drifts out of step.

Three deliberate choices:

- **No dots on trend lines.** Forty of them is noise.
- **Horizontal grid only.** Vertical lines fight the trend the eye is following.
- **The y-axis is not forced to zero.** For a yield figure living between 95% and
  99%, a zero baseline flattens the only variation that matters.

Bars are one colour. Cycling hues across categories implies the colour means
something when the only variable is height — and it spends the reader's attention
so that when a colour *does* mean something, they have stopped noticing.

**Every chart carries a data table.** Visually hidden on screen, revealed when
printing. A chart is an image to a screen reader and a blur on a fax. The numbers
must never be available only to someone looking at colour on a monitor.

---

## Export and print

CSV is generated inline. Excel and PDF are dynamic imports — SheetJS and pdfmake
are around 900kB together, more than the rest of the application, and someone who
never exports should never download them.

Two details that are painful to discover later:

**The byte order mark.** Excel opens a UTF-8 CSV as Windows-1252 without it, and
every ₦ becomes `â‚¦`. Three bytes prevents a support call per export.

**Formula injection.** A cell starting `=`, `+`, `-` or `@` is executed by Excel
on open. A customer named `=cmd|'/c calc'!A1` is a remote code execution vector in
your customer master. Leading characters are neutralised on the way out.

Printing gets a real stylesheet, not a screenshot: chrome stripped, table given
full width, rows kept off page breaks, `thead` repeated per page, link targets
shown, and dark mode forced to light — printing a dark theme empties the toner.
A printed report in Nigeria gets signed and filed, so it is a deliverable.

---

## Keyboard

`⌘K` opens the command palette; `/` focuses search; `?` lists every shortcut.

Two rules keep shortcuts from being actively harmful:

1. **Nothing fires while typing.** A store keeper entering a customer named
   "Ngozi" must not trigger whatever is bound to `n`.
2. **Nothing overrides a browser default except ⌘K,** which every application
   they already use binds to search. Stealing Ctrl+P from print or Ctrl+F from
   find makes the application feel broken, not fast.

The bindings that pay for themselves in an ERP are the repetitive ones — `n` for
new, `/` for search, during a run of forty goods receipts — not clever chords
nobody remembers. The palette lists only commands the user's permissions allow,
so it never advertises a screen that will refuse them.

---

## Responsive

Behaviour differs by kind, not just by width.

- **≥1024px** — persistent sidebar, collapsible to icons. Working a list all day
  wants horizontal room; navigating wants labels.
- **<1024px** — the sidebar becomes an overlay drawer. A 264px rail on a 768px
  screen leaves no usable table, and the plant floor runs on tablets.

The drawer closes on navigation and on Escape, traps the page scroll while open,
and the layout is usable down to 360px.

---

## Accessibility

- Skip link to main content, visible on focus
- `aria-live` region for async updates, so a refreshed table is announced
- Visible focus ring on every interactive element, never removed
- WCAG AA contrast in both themes, including the semantic colours
- Charts carry equivalent data tables
- Full keyboard operation: palette, menus, filters, pagination, dialogs
- Dialogs are labelled, close on Escape, and return focus to their trigger
- `prefers-reduced-motion` honoured globally
- `color-scheme` set per theme so native scrollbars and form controls follow

The permission checks in the UI hide what a user cannot use. They are documented
as cosmetic — the server re-checks everything, and hiding a button the API would
reject is a courtesy, not a boundary.
