# Ultimate Scrape - User Manual

Stash's built-in stash-box search only ever asks two questions: "any scene
matching this text?" or "any scene with this file's fingerprint?". Stash-box
itself can answer far more precise ones. This plugin asks those.

It reuses the endpoint and API key already set under **Settings > Metadata
Providers** - there is nothing to configure.

## Where it appears

- A **magnifying-glass icon in the top nav**, opening a standalone search page.
- A **magnifying-glass button in the scene page's tab strip**, opening the same
  search in a modal - seeded from that scene.

Opened from a scene, the form is prefilled with the scene's title, a
dropdown of its URLs, and its performers, tags and studio. Switched filters
(title, studio code, URL, date, studio) start **off** - flip the switch to
include them. Performers and tags have no switch: tick the ones you want.

The modal's Search button sits in the footer. Close the dialog with the X
in the header.

## Scenes search

Title, studio code, URL, date and studio each have an on/off switch. Values
are kept while the switch is off, so you can turn a criterion back on
without retyping it.

**Studio code** is the studio's catalog number for the scene (stash-box's
`code` field), not the stash-box scene id. The modifier next to it is
equals / not equals / includes / excludes.

**URL** is a dropdown of the scene's URLs, plus **Custom…** if you need to
type one.

**Performers** and **tags** are tick lists. Tick to include; nothing ticked
means that filter is omitted. Entries with no id on this stash-box are
listed underneath, greyed out. Date is equals / after / before.

**Sort** (field, direction) and **Limit** sit at the bottom. Limit is how
many results to fetch - there is no next-page control.

## Pairings search

The other way to find a scene: pick one performer and see everyone who has
worked with them. This is the same query stash-box's own Pairings tab uses.

Choose a performer from the scene, optionally filter co-performers by name or
gender, and tick **List the scenes they share** to expand each row into the
scenes the two actually appear in together. Useful when the title tells you
nothing but you recognise a face.

## Syncing a result onto your scene

Every result has a **view** link, which opens it on stash-box, and - when you
opened the search from a scene - a **sync** button.

Sync fetches that exact scene through your own Stash backend, so studios,
performers and tags come back already matched against your library, then opens
Stash's own scrape dialog: every field with its current value beside the
incoming one, and a tick per field. Nothing is written until you save.

Saving always records the stash-box link on the scene - the same link the
built-in tagger creates when you match a scene, so "already matched" badges,
draft submissions and re-scrapes all behave normally. Links to other stash-box
instances are preserved.

Performers, studios and tags that do not exist in your library are shown but
not created; that still needs the scene's own Edit tab.

- A result your scene already points at shows **linked** instead of a button.
- If your scene is linked to a *different* stash-box scene, the button is
  marked with an asterisk - saving replaces that link.

### One requirement

The scrape dialog is part of Stash itself and only recent builds let a plugin
open it. On a build without that, sync still records the link and tells you
that no fields were synced - you can then use **Scrape with...** on the scene's
Edit tab as usual. You never lose the link, only the dialog.

## If a search returns nothing

The plugin talks to stash-box directly from your browser, and Stash's
Content-Security-Policy only permits hosts listed in the plugin's yml. If your
stash-box is not one of the five common ones listed there, the request is
blocked with no visible error - add your host under `ui.csp.connect-src` in
`ultimateScrape.yml`.
