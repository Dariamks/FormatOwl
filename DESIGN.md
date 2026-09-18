# FormatOwl design system

FormatOwl is a calm, approachable file workspace: choose a file, adjust it, and download
its result. The homepage helps visitors understand the tools and inspect real examples;
working screens keep the file and its controls in focus.

## Brand identity

Use **FormatOwl** in both languages. The mark is a white owl with a folded-paper wing
on the existing blue rounded square. `assets/brand/formatowl-master.png` is the generated
source; `apps/web/src/app/icon.png`, the favicon, Apple touch icon, and social share card
use the same artwork. Research sources and the ImageGen prompt are in `assets/brand/README.md`.
Keep the mark legible at 16px and use the full wordmark in navigation and footers.

Public copy, emails, metadata, generated download names, and sample assets use this
identity. Internal package, database, queue, cookie, and browser-storage identifiers
remain stable so existing local services, sessions, and editing drafts keep working.

## Visual direction

The main reference is the [Intercom design analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/intercom/DESIGN.md):
warm surfaces, charcoal text, clear editorial sections, and useful product imagery.
Adapt that direction with FormatOwl blue and system fonts. The sample entry, comparisons,
and practical explanations draw on [VideoCompress](https://videocompress.ai/); all claims,
limits, fees, and sample measurements must describe FormatOwl itself.

| Role                                | Value                             |
| ----------------------------------- | --------------------------------- |
| Page / surface / inset              | `#F7F5F2` / `#FFFFFF` / `#F6F6F4` |
| Text / secondary / quiet            | `#20211F` / `#656760` / `#707268` |
| Border / strong border              | `#E5E3DE` / `#CCCFC4`             |
| Brand / hover / selected background | `#263BC4` / `#1F30A6` / `#EEF1FF` |
| Success / warning / error           | `#15803D` / `#B45309` / `#B91C1C` |

Use blue for primary actions, selection, focus, and links. Status colors communicate
real conditions. Preserve source media, document paper, subtitle colors, speaker colors,
and meaningful canvas overlays. New UI consumes semantic variables from globals.css.

## Type, spacing, and surfaces

- Use the system sans and Chinese font stack; no downloaded interface fonts.
- Hero: 48px desktop, 32px phone; Chinese line height 1.3. Section headings: 28px / 24px.
- Page headings: 32px / 28px. Cards: 18px. Workspace file titles: 16px.
- Body: 14–16px, line height 1.6–1.8; auxiliary information: 12–13px.
- Use tabular numbers for file sizes, prices, progress, and time. No negative Chinese tracking.
- Spacing follows 4px steps. Main section spacing: 64px desktop, 40px phone.
- Controls: 8px radius; content cards and dialogs: 16px. Main actions: 48px high;
  normal fields: 40px; compact toolbars: 32–36px; touch targets: at least 44px.
- Cards use a thin border. Hover changes border or background without moving the control.
  Menus and dialogs use shared shadows. Keep disabled text readable and focus clearly visible.
- Segmented controls use an inset track, white selected segment, and blue selected text.
  Loading and errors have text; statuses never rely on color alone.

## Page composition

- Header, footer, and public content align to a 1160px grid. Reading pages stay narrower;
  specialist editors preserve their full-width layouts and existing breakpoints.
- Homepage: introduction/upload → tools → format shortcuts → real samples → three steps →
  helpful guides → FAQ. Keep supporting content in server-rendered markup and real links.
- Tool grid: four columns above 1050px, two at 641–1050px, one at 640px and below.
  Format shortcuts follow the same grid. Guide cards use three / two / one columns.
- Sample comparisons have two columns, stacked below 641px. Videos never autoplay.
  Previews load on demand; image/PDF representations use lazy images.
- Tool descriptions use two overview panels, readable explanations, FAQ rows, related
  shortcuts and guide cards. Keep settings and processing order unchanged.
- Preserve equal reading columns, synchronized scrolling, crop canvases, timelines and
  narrow-screen panel switches. Long filenames and action groups must not overflow.

## Public sample contract

The three samples (video compression, WebP to JPG, PDF compression) are original public
assets made by `scripts/public-examples.ts`. This offline script calls existing worker
processors and writes static outputs and measured sizes to `apps/web/public/examples`.
Regenerate with `pnpm fixtures:public`. These are intentionally public product assets,
not user uploads or exports. The image conversion can increase size; display it honestly.

The typed content manifest contains allowed sources, target routes, localized descriptions,
actual sizes, and processing settings. Static preview/download needs no account, worker,
job, or credits. A validated `?sample=` loads the source into the existing tool; uploading
and processing only begin on the normal explicit action, under existing billing rules.

Never overwrite an existing selection silently. Confirm replacement in the sample dialog;
a late response must not replace a newer file. Abort on close/unmount and allow retry.
Preserve existing component interfaces through optional sample props. No sample billing
exemption, arbitrary source URL, public job endpoint, or database record is introduced.

## Implementation and verification

Shared controls and dialogs retain compatible interfaces. Keep rules with their component
owner and consolidate duplicates. Do not stack a replacement theme at the end of a file.
English and Chinese have equal coverage. No new library, font, or deployment is needed.

Check 1440 / 1024 / 768 / 390 / 320px, keyboard operation, loading/errors, long filenames,
empty/expired tasks, and touch controls. Save matched before/after screenshots, run relevant
browser checks and the real local upload/download flow. Use fixtures for AI workspaces;
visual QA must not trigger paid generation. Record actual coverage in `design-qa.md`.
