/**
 * Offline unit tests for the journal OWNERSHIP CONTRACT helpers (src/page/journals.ts).
 *
 * These encode the two rules that a per-page grant alone gets wrong, and that cost a live campaign
 * a set of unreachable handouts:
 *   1. a player-visible PAGE inside a GM-only ENTRY is invisible — players never see the journal;
 *   2. a page at ownership -1 INHERITS the entry, so opening an entry can reveal pages nobody meant
 *      to reveal.
 * The page-coupled write paths themselves are exercised by scripts/verify-journal-tooling.mjs.
 */

import { describe, it, expect } from 'vitest';
import {
  isHandoutPage,
  applyEntryOwnershipContract,
  pinInheritingPages,
  appendPageOwnership,
  OWNERSHIP_OBSERVER,
  OWNERSHIP_GM_ONLY,
  OWNERSHIP_INHERIT,
} from './journals.js';

describe('isHandoutPage', () => {
  it('is true only at OBSERVER or better', () => {
    expect(isHandoutPage({ ownership: { default: OWNERSHIP_OBSERVER } })).toBe(true);
    expect(isHandoutPage({ ownership: { default: 3 } })).toBe(true);
    expect(isHandoutPage({ ownership: { default: OWNERSHIP_GM_ONLY } })).toBe(false);
    expect(isHandoutPage({ ownership: { default: 1 } })).toBe(false);
  });

  it('treats an inheriting or absent ownership as not-a-handout in its own right', () => {
    expect(isHandoutPage({ ownership: { default: OWNERSHIP_INHERIT } })).toBe(false);
    expect(isHandoutPage({})).toBe(false);
  });
});

describe('applyEntryOwnershipContract', () => {
  it('leaves a journal with no handouts entirely alone (GM-only entry, untouched pages)', () => {
    const pages = [{ name: 'GM Notes' }, { name: 'More notes' }];
    const out = applyEntryOwnershipContract(pages);
    expect(out.entryOwnership).toEqual({ default: OWNERSHIP_GM_ONLY });
    expect(out.pages).toEqual(pages);
  });

  it('opens the ENTRY when any page is a handout — else players never see the journal', () => {
    const out = applyEntryOwnershipContract([
      { name: 'GM Notes' },
      { name: 'Handout', ownership: { default: OWNERSHIP_OBSERVER } },
    ]);
    expect(out.entryOwnership).toEqual({ default: OWNERSHIP_OBSERVER });
  });

  it('pins the other pages GM-only so they cannot inherit the now-open entry', () => {
    const out = applyEntryOwnershipContract([
      { name: 'GM Notes' },
      { name: 'Handout', ownership: { default: OWNERSHIP_OBSERVER } },
    ]);
    expect(out.pages[0]!.ownership).toEqual({ default: OWNERSHIP_GM_ONLY });
    // an explicit grant is never rewritten
    expect(out.pages[1]!.ownership).toEqual({ default: OWNERSHIP_OBSERVER });
  });

  it('does not mutate the caller"s page objects', () => {
    const pages = [{ name: 'GM Notes' }, { name: 'H', ownership: { default: OWNERSHIP_OBSERVER } }];
    applyEntryOwnershipContract(pages);
    expect(pages[0]).toEqual({ name: 'GM Notes' });
  });
});

describe('pinInheritingPages', () => {
  it('pins every inheriting page to what it effectively is today', () => {
    const pins = pinInheritingPages(OWNERSHIP_GM_ONLY, [
      { id: 'a', ownership: { default: OWNERSHIP_INHERIT } },
      { id: 'b', ownership: { default: OWNERSHIP_OBSERVER } },
      { id: 'c' },
    ]);
    expect(pins).toEqual([
      { _id: 'a', 'ownership.default': OWNERSHIP_GM_ONLY },
      { _id: 'c', 'ownership.default': OWNERSHIP_GM_ONLY },
    ]);
  });

  it('pins to the entry level, so pages under an OPEN entry stay visible', () => {
    const pins = pinInheritingPages(OWNERSHIP_OBSERVER, [
      { id: 'a', ownership: { default: OWNERSHIP_INHERIT } },
    ]);
    expect(pins).toEqual([{ _id: 'a', 'ownership.default': OWNERSHIP_OBSERVER }]);
  });

  it('is a no-op when nothing inherits', () => {
    expect(
      pinInheritingPages(OWNERSHIP_GM_ONLY, [
        { id: 'a', ownership: { default: OWNERSHIP_GM_ONLY } },
      ])
    ).toEqual([]);
  });
});

describe('appendPageOwnership', () => {
  const openEntry = { ownership: { default: OWNERSHIP_OBSERVER } };
  const closedEntry = { ownership: { default: OWNERSHIP_GM_ONLY } };

  it('honours an explicit request unchanged', () => {
    expect(appendPageOwnership(closedEntry, { default: OWNERSHIP_OBSERVER })).toEqual({
      ownership: { default: OWNERSHIP_OBSERVER },
    });
  });

  it('pins an unspecified page GM-only when the entry is open (no accidental reveal)', () => {
    expect(appendPageOwnership(openEntry)).toEqual({ ownership: { default: OWNERSHIP_GM_ONLY } });
  });

  it('leaves an unspecified page to inherit a GM-only entry (nothing to leak)', () => {
    expect(appendPageOwnership(closedEntry)).toEqual({});
  });
});
