# Restream brand: "Signal"

A new house style made for Restream: dark, technical and calm, with one bright signal colour. It reads like a broadcast control room: dark surfaces so video stands out, cyan for anything that carries signal, red only for "on air".

## Files

| File | Use |
| --- | --- |
| `tokens.css` | Colour, type and radius tokens as CSS variables. The web app imports this file directly. |
| `logo.svg` | App mark: one input fanning out to three outputs. |
| `favicon.svg` | Browser tab icon (same mark). |

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| `--rs-bg` | `#070A12` | Page background, with a faint 64 px cyan grid |
| `--rs-surface` | `#0D1220` | Cards and sidebar |
| `--rs-surface-2` | `#141C30` | Hover, active menu item |
| `--rs-border` | `#1E2740` | Hairlines |
| `--rs-text` | `#E8ECF6` | Primary text |
| `--rs-text-2` | `#B4BDD3` | Secondary text |
| `--rs-accent` | `#2EE6D6` | Signal cyan: primary buttons, focus, active state, links |
| `--rs-live` | `#FF3B5C` | On air / recording only |
| `--rs-ok` / `--rs-warn` / `--rs-danger` | `#3DDC97` / `#FFB547` / `#FF5C6C` | Status |

Platform colours (YouTube, Facebook, Twitch, Instagram, Kick) are only used as small markers next to a platform name, never as large fills.

## Type

- **Space Grotesk**: headings, the wordmark, large numbers.
- **Inter**: body text and UI.
- **JetBrains Mono**: technical values (stream keys, bitrates, versions, timecode) and small uppercase eyebrow labels with wide letter spacing.

All fonts are self-hosted (no Google Fonts requests from the server).

## Layout rules

- Admin navigation always sits in a fixed sidebar on the left; it collapses to a drawer on phones.
- Cards: `--rs-surface`, 1 px `--rs-border`, radius 16-20 px. No heavy shadows; a soft cyan glow is reserved for the primary action and live state.
- One primary (cyan) button per view. Destructive actions are outlined in `--rs-danger`.
- Minimum touch target 40 px; visible cyan focus ring on every interactive element.
