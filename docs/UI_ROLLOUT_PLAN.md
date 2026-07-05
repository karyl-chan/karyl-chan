# `@karyl-chan/ui` rollout plan

Coordinated plan for evolving the shared UI library toward the end-state
in the agent-ergonomics audit, and rolling each change out across the bot
frontend and the standalone plugin SPAs without breakage.

> **Why:** the audit found the library is missing its *layout*, *provider*,
> *field*, and *composite* layers, so those responsibilities leak into every
> call site, and inconsistent names (`AppTabs` = shell, `AppSelect` = popover,
> `AppSelectField` = no label chrome) make the natural call the wrong call.
> This plan lands the layers back in the library, phase by phase.

## Who consumes `@karyl-chan/ui`

| Consumer | Repo | Depends via | Current pin |
|---|---|---|---|
| bot frontend | `karyl-chan` (this repo) | `workspace:*` | always local `HEAD` |
| plugin-radio | `plugin-radio` | published npm | `^0.3.0` |
| plugin-quest-game | `plugin-quest-game` | published npm | `^0.3.0` |
| plugin-xiangqi | `plugin-xiangqi` | published npm | `^0.1.0` ⚠ badly behind |
| aktest (artificial-karyl) | `artificial-karyl` | published npm | `^0.3.0` |

**Consequence for coordination:** the bot frontend is in-repo, so a *breaking*
ui change must migrate the bot in the **same PR** or the bot build breaks. The
plugins are separate repos pulling a **published** version, so they can only
migrate *after* a new ui version ships to npm — each plugin then bumps its pin,
migrates its code, and rebuilds/redeploys on its own cadence.

## Release mechanics

- **release-please** owns versions for `@karyl-chan/ui` (config in
  `release-please-config.json`, current version in
  `.release-please-manifest.json`, today `0.3.0`). Conventional-commit types
  drive the bump; `bump-minor-pre-major: true` means a `feat!` breaking change
  bumps the **minor** while pre-1.0 (so `0.3.0 → 0.4.0`, not `1.0.0`).
- On merge to `main`, release-please opens/updates a `chore(ui): release …`
  PR; merging **that** tags the release and `.github/workflows/release-please.yml`
  dispatches **`publish-ui.yml`**, which publishes to npm (`publishConfig.access:
  public`).
- There is already an **unreleased** `feat(ui)!: AppModal pads body by default`
  on `main`, so the next ui release is **0.4.0**. Phase 0 below folds into it.

**Versioning rule of thumb (pre-1.0):** additive → patch/minor; anything that
changes an existing component's contract → `feat(ui)!` (still a minor pre-1.0),
and every published-version consumer bumps in lockstep. We prefer breaking
changes + lockstep bumps over compatibility shims (no formal release yet).

---

## Phase 0 — Layout layer  ·  DONE (folds into ui 0.4.0)

Shipped on `feat/ui-layout-primitives`: `--space-0..8` scale in `tokens.css`;
`<Stack>`, `<Cluster>`, `<Spacer>`; `lib/space.ts`. **Additive / non-breaking.**

This alone dissolves the largest class of hand-written code (215 hand-rolled
flex-columns / 199 manual margins across 97 files) and **fixes the AppTabs
"flush" seed bug** without touching AppTabs: a view wraps its column in
`<Stack>` and the gap is owned by the layout, so `AppTabs`' `flex:1` is inert
in an unconstrained stack.

### Adoption (all optional / incremental — nothing breaks if deferred)

**Bot frontend** (`workspace:*`, gets it immediately):
- Replace hand-rolled `display:flex;flex-direction:column;gap:…` scoped blocks
  with `<Stack gap>` opportunistically (71 candidate `.vue` files — do it as
  files are touched, not in one sweep).
- Replace `margin-left:auto` push-to-end with `<Spacer/>` inside a `<Cluster>`.

**Plugins** (after 0.4.0 publishes): bump `@karyl-chan/ui` to `^0.4.0`, then:
- **plugin-radio** — wrap `ManageView` / `PersonalView` page bodies in
  `<Stack gap="4">` and **delete** the `.manage-tabs` / `.personal-tabs`
  `flex:0 0 auto` + `margin` overrides (and the `keep in sync` CSS note). This
  is the concrete fix for the `PersonalView` voice-card↔tabs flush that seeded
  the whole audit.
- **plugin-quest-game** — same treatment for `ManageView`'s `.tabs-row`
  (a `<Cluster>` with the tab strip + refresh button, then `<Stack>` below).
- **plugin-xiangqi** — bump `^0.1.0 → ^0.4.0` first (3 minors behind; do a
  smoke pass of every screen), then adopt as above where relevant.

**Checklist**
- [ ] Merge `feat/ui-layout-primitives` → release-please cuts ui 0.4.0 → publish.
- [ ] bot frontend: adopt `<Stack>`/`<Spacer>` as files are touched.
- [ ] radio / quest / xiangqi: bump pin to `^0.4.0`; wrap tab pages in `<Stack>`; drop tab overrides; rebuild + redeploy.
- [ ] Add a `<Stack>`/`<Cluster>`/`<Spacer>` section to `plugin-example`'s `ShowcaseView` so the primitives are discoverable.

---

## Phase 1 — Provider, field, and composite layers  ·  PLANNED

The high-value contract fixes. Each is a `feat(ui)!` (breaking) → ships in one
ui minor (**0.5.0**), then every published consumer bumps + migrates in lockstep.

### 1a. Provider layer — kill the silent-mount footguns
- Add **`<AppProvider>`** that mounts the toast host **and** the global confirm
  host together; document it as the one required mount in `main.ts`.
- Move the ergonomic **`useToast()`** wrapper (`ok/info/success/warn/error`,
  **no** error-default) into the library and map kinds to the existing
  `--success-*` / `--warn-*` tokens.
- Make **`confirm()`** accept an async `onConfirm` and surface
  `loading`/`error` in the global dialog; `console.warn` + resolve `false`
  when no host is mounted (never hang).
- **Migration:** delete the byte-identical `use-toast.ts` re-wrappers in
  plugin-radio and plugin-quest-game; replace two mandatory mounts with one
  `<AppProvider>`; point confirms at the sugar.

### 1b. Field layer — one labeled-control vocabulary
- Extract an internal **`AppField`** (label / hint / error / `fullWidth`)
  and compose it in `AppTextField`, `AppTextArea`, **and** `AppSelectField`
  so `<AppSelectField label=… :options=… v-model=…/>` matches its text twin.
- Rename **`AppSelect` → `AppDropdown`** (it's a popover menu, not a value
  picker); keep a deprecated `AppSelect` alias for one minor.
- Add **`AppToggleField`** (bare `AppToggle` + label/description row).
- Fix `AppTextField.fullWidth` → also set `width:100%` (or rename `spanRow`).
- **Migration:** delete the 6 hand-rolled `<label class="field"><span>…</span>`
  wrappers around `AppSelectField` in the bot's guild/behavior modals; adopt
  `AppToggleField` in the settings rows.

### 1c. `AppModal` actions footer
- Add a pinned (non-scrolling) `#footer` slot + a standard actions convention
  (promote the bar already baked into `AppConfirmDialog`).
- **Migration:** replace the ~10 hand-rolled `.actions` footers across bot
  modals + `plugin-radio/EditPlaylistModal` + `plugin-quest-game/ArtCropModal`.

### 1d. `AppTabs` split — finish the seed fix
- Split into **`AppTabs`** (pure nav bar — no `flex:1`, no panel, no outer
  margin) and **`AppTabLayout`** / `AppTabLayoutRouted` (the current
  nav + slotted `<slot>` panel + fill/scroll shell).
- Bridge: `AppTabs` used *with* slotted content keeps rendering the shell +
  a one-time `console.warn` pointing at `AppTabLayout`, so nothing breaks the
  instant this ships.
- **Migration:** bot's ~5 slotted `AppTabs`/`AppTabsRouted` pages →
  `AppTabLayout`/`AppTabLayoutRouted`; plugins already use it as a bare bar,
  so they just drop the leftover overrides.

**Lockstep order for Phase 1:** land 1a–1d on `main` (bot migrated in the same
PR) → release ui 0.5.0 → each plugin bumps `^0.5.0`, migrates, redeploys.

---

## Phase 2 — Consistency polish  ·  PLANNED

Small, independent, mostly one-component changes once the layers exist. Batch
into **ui 0.6.0**.

- `AppMenuItem`: add an `icon?: string` prop (siblings have one; the phantom
  prop currently renders nothing — even in the ShowcaseView demo).
- `AppMenu`: ship a built-in icon-button trigger for the overflow-menu case.
- `AppPopover`: make `referenceEl` mode own a working outside-dismiss; anchor
  the trigger to a real wrapper instead of `display:contents`.
- `Draggable`: add `v-model:position` (emit `{x,y}` on settle) so layouts can
  be seeded/persisted.
- `UserCard`: make `name` optional (allow loading/error without it); render
  `error` as a standalone state.
- `UserItem`: emit the native click event; use a focusable non-`<button>`
  container so the `#trailing` action buttons stay valid HTML.
- `AppButton`: add an `ariaLabel` prop to match `AppToggle`.
- Move `--unread-accent` from the bot's global CSS into `tokens.css`.

---

## Cross-cutting notes

- **Deprecation style:** for renames (`AppSelect`→`AppDropdown`) and the
  `AppTabs` split, ship the new API + keep the old one working for **one**
  minor with a `console.warn`, then remove in the following minor. This keeps
  each plugin's bump low-risk without a permanent compat shim.
- **Plugin bump discipline:** whenever a plugin bumps `@karyl-chan/ui`, run its
  build + a screen smoke pass before redeploy; the plugins are independently
  deployed Docker services.
- **xiangqi is the tail risk:** it sits on `^0.1.0`. Bring it to current on its
  own PR (expect the most drift) before layering Phase 1/2 changes on top.
