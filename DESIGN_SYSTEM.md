# Design System

## Purpose
This file defines the visual and structural rules for Dryad's public-facing editorial pages and one-pagers.

## Design Direction
- Tone: calm, literate, grounded, civic-minded
- Audience: intelligent non-specialists first; specialists second
- Interaction principle: explain first, expand second
- Density rule: main narrative should stay readable in one pass; specialist material belongs in appendices, details panels, or clearly marked deep dives

## Typography
- Display: `Instrument Serif`
  - Use for page titles and section titles only
  - Weight: 400
  - Tracking: slightly tight
- Body: `Manrope`
  - Default body size: `1rem`
  - Long-form body size target: `1rem` to `1.08rem`
  - Line height: `1.7` to `1.8`
- Labels and metadata: `Space Mono`
  - Use for eyebrows, pills, statistics labels, and compact metadata
  - Keep small, uppercase, and restrained

## Color Tokens
- Background base: `#171912`
- Background alt: `#1d2017`
- Surface: `rgba(31, 34, 24, 0.9)`
- Strong surface: `#23271c`
- Primary text: `#e2e6d5`
- Body text: `#cfd4c0`
- Muted text: `rgba(226, 230, 213, 0.72)`
- Accent green: `#8da667`
- Accent green light: `#b8d48c`
- Accent amber: `#e29e4b`
- Danger: `#cb5a43`

## Spacing
- Section padding desktop: `80px`
- Section padding tablet/mobile: `62px`
- Major card padding: `22px` to `28px`
- Standard grid gap: `16px`
- Tight gap: `10px` to `12px`
- Large layout gap: `24px` to `42px`

## Layout Rules
- Max content width: `1160px`
- Hero layout: asymmetric split, copy first, supporting panel second
- Main narrative order:
  1. Why the topic matters
  2. Public-interest standards
  3. Reader action
  4. Optional practical branch
  5. Publisher context
  6. Specialist appendix
- Avoid card-over-card saturation. Cards should clarify hierarchy, not become the default wrapper for every paragraph.

## Component Rules
- Hero:
  - Must state the page promise in plain language
  - Must include one clear primary CTA
  - Supporting stats should live in one summary panel, not scattered across the page
- Editorial photos:
  - Use documentary, landscape, infrastructure, or work-in-context photography; avoid generic corporate stock
  - Limit photos to moments that clarify the story, not every section by default
  - Every photo needs a substantive caption and a visible source / license line
  - Prefer public-domain, CC0, or clearly attributed Commons imagery that can be archived locally with the page
- Notes and callouts:
  - Use left-border callouts for framing, not as the dominant pattern
- Standards/questions:
  - Phrase standards as plain-language questions whenever possible
  - Each standard should include a simple "Ask:" line
- Deep dives:
  - Use progressive disclosure (`details` / appendix panels) for investor, policy, or other specialist material
- Forms and checklists:
  - Use native inputs for accessibility
  - Do not rely on hover-only explanations

## Accessibility Rules
- No emoji iconography
- No hover-only critical information
- Maintain strong contrast on dark backgrounds
- Focus styles must remain visible
- Mobile navigation may scroll horizontally, but core actions should be visible without perfect precision

## Motion
- Default motion level: low
- Prefer subtle hover and focus feedback over large entrance animations
- Avoid repeated reveal animations on long educational pages
