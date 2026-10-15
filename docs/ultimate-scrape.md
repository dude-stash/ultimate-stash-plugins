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

Opened from a scene, the form is prefilled with the scene's title, its studio
name, a dropdown of its URLs, and its performers and tags. Switched filters
(text, studio, and the ones under **More options**) start **off** - flip the
switch to include them. Performers and tags have no switch: tick the ones you
want.

The modal's Search button sits in the footer. Close the dialog with the X
in the header.

## Scenes search

**File match** (only when opened from a scene, on by default) is the same
lookup as Stash's own **Scrape with**: the scene's file fingerprints (phash,
oshash, md5) are sent to the selected stash-box, and any scene it knows by
that file is listed first with a **File match** badge, followed by the filtered
results. With no other filter switched on, only the file match runs. A failed
lookup is noted next to the result count and does not hide the filtered
results.

Text and studio each have an on/off switch. Values are kept while the switch
is off, so you can turn a criterion back on without retyping it.

**Text** is one field with a choice of **Title only** or **Title and
description**.

**Studio** is a type-ahead picker, like the studio field when you edit a scene.
Start typing and pick from the list; parent networks are shown in brackets.
It is prefilled when the scene's studio is linked on the selected stash-box
(or has exactly one match by name). Picking a network includes its
sub-studios' scenes. Picking a studio switches the filter on, and clearing it
removes the filter. On ThePornDB, which has no studio search, it is a plain
name field (see below).

**Performers** are a tick list of the scene's performers plus a search box
above it. Type a name, pick a performer from the box you selected, and they
are added to the list already ticked - useful when the performer is not on
the scene yet. It also works on the standalone page, where there is no scene.
**Tags** are a tick list of the scene's tags. Nothing ticked means that filter
is omitted. The dropdown next to each is **all of these** or **any of
these**. Entries with no id on this stash-box are listed underneath, greyed
out. Performers you added stay in the list until you change the source box.

**More options** (collapsed by default, with a count of how many are on)
holds the rarer filters, each with its own switch:

- **Studio code** is the studio's catalog number for the scene (stash-box's
  `code` field), not the stash-box scene id. The modifier next to it is
  equals / not equals / includes / excludes.
- **URL** is a dropdown of the scene's URLs, plus **Custom…** if you need to
  type one.
- **Date** is equals / after / before.

Different filters are combined with AND, so each one you switch on narrows
the results.

**Sort** (field, direction) and **Limit** sit at the bottom. Limit is how
many results to fetch - there is no next-page control.

### ThePornDB

ThePornDB's stash-box endpoint does not implement the filtered scene query.
For it (and any box that behaves the same) the plugin runs a text search
instead, using Text, the studio name and the ticked performers' names, and applies the
other filters to the 100 best matches in the browser. A narrow filter on a
broad search can therefore come back empty - make the text more specific.
Title only / Title and description makes no difference there. Pairings search
is untested on it.

## Pairings search

The other way to find a scene: pick one performer and get the **scenes** they
share with co-performers. This is the same pairing query stash-box's own
Pairings tab uses, flattened into a scene list - stash-box has no scene
filter for "appeared with this person".

Choose a performer from the scene, optionally narrow co-performers by name
or gender, then search. Each row is a scene, with the same view/sync actions
as the scenes search. Useful when the title tells you nothing but you
recognise a face.

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
