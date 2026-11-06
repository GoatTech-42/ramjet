import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, credit, buildArtistPage } from './artist.js';
import { buildAlbumPage } from './album.js';

// Edge pins for the Unicode-norm restoration on top of the base identity semantics:
// matching stays exact full-name comparison (the deliberate "Prince never fills with Prince Royce"
// behavior); the only change is that non-Latin and symbol-only names now normalize to themselves
// instead of "". No alias/parenthetical stripping: a bracketed qualifier is part of the name.
for (const [label, actual, want] of [
  // Unicode names match themselves and build pages (RED on the old [a-z0-9] norm)
  ['kanji name self credit', () => credit({ artist: '宇多田ヒカル' }, '宇多田ヒカル'), 2],
  ['kanji artist page builds', () => buildArtistPage([{ artist: '宇多田ヒカル', album: 'First Love' }, { artist: '宇多田ヒカル', album: 'Distance' }], '宇多田ヒカル').total, 2],
  ['cyrillic name self credit', () => credit({ artist: 'Кино' }, 'Кино'), 2],
  ['greek name self credit', () => credit({ artist: 'Ελένη Βιτάλη' }, 'Ελένη Βιτάλη'), 2],
  ['hangul name self credit', () => credit({ artist: '방탄소년단' }, '방탄소년단'), 2],
  ['kanji query finds featured row', () => credit({ artist: '宇多田ヒカル, 椎名林檎' }, '椎名林檎'), 1],
  // script distinctions are preserved (no cross-script folding)
  ['decomposed kana equals precomposed', () => norm('が'), norm('が')],
  ['kana remains distinct', () => credit({ artist: 'かく' }, 'がく'), 0],
  ['cyrillic versus latin', () => credit({ artist: 'АBBA' }, 'ABBA'), 0],
  ['greek versus latin', () => credit({ artist: 'ΑΒΒΑ' }, 'ABBA'), 0],
  ['hangul different', () => credit({ artist: '가' }, '나'), 0],
  ['fullwidth latin folds by NFKD', () => credit({ artist: 'ＢＴＳ' }, 'BTS'), 2],
  // symbol-only names fall back to their text instead of ""
  ['symbol name exact', () => credit({ artist: '!!!' }, '!!!'), 2],
  ['symbols not interchangeable', () => credit({ artist: '???' }, '!!!'), 0],
  ['empty input', () => buildArtistPage([], null).total, 0],
  // malformed bracket text is just text: it matches itself, never folds into a shorter name
  ['malformed name matches itself', () => credit({ artist: 'A ((B)' }, 'A ((B)'), 2],
  ['malformed name no fold into A', () => credit({ artist: 'A ((B)' }, 'A'), 0],
  ['stray closers no fold', () => credit({ artist: 'A ) (B)' }, 'A'), 0],
  ['stray square no fold', () => credit({ artist: 'A ] [B]' }, 'A'), 0],
  ['unclosed fullwidth no fold', () => credit({ artist: 'A （（B）' }, 'A'), 0],
  // disambiguated artists stay distinct (John Williams composer vs guitarist), both directions
  ['JW composer not guitarist', () => credit({ artist: 'John Williams (composer)' }, 'John Williams (guitarist)'), 0],
  ['JW guitarist not composer', () => credit({ artist: 'John Williams (guitarist)' }, 'John Williams (composer)'), 0],
  ['JW artist page excludes the other', () => buildArtistPage([{ artist: 'John Williams (composer)', album: 'Star Wars' }, { artist: 'John Williams (guitarist)', album: 'Cavatinas' }], 'John Williams (composer)').total, 1],
  ['JW album page excludes the other', () => buildAlbumPage([{ artist: 'John Williams (composer)', album: 'Duets' }, { artist: 'John Williams (guitarist)', album: 'Duets' }], 'John Williams (composer)', 'Duets').total, 1],
  // bare name does not merge a parenthetical qualifier (alias stripping descoped: identity-only)
  ['parenthetical qualifier not stripped', () => credit({ artist: 'BTS（방탄소년단）' }, 'BTS'), 0],
  ['parenthetical qualifier not stripped ascii', () => credit({ artist: 'BTS (Bangtan Boys)' }, 'BTS'), 0],
  // original controls from the defect report
  ['Prince lead exact', () => credit({ artist: 'Prince' }, 'Prince'), 2],
  ['Prince never fills with Prince Royce', () => credit({ artist: 'Prince Royce' }, 'Prince'), 0],
  ['featured credit still 1', () => credit({ artist: 'Daft Punk, Pharrell Williams' }, 'Pharrell Williams'), 1],
  // album grouping with non-Latin data
  ['nonLatin albums stay separate', () => buildArtistPage([{ artist: 'Кино', album: '音' }, { artist: 'Кино', album: '声' }], 'Кино').albums.length, 2],
  ['nonLatin album filters artist', () => buildAlbumPage([{ artist: 'Ария', album: '音' }, { artist: 'Кино', album: '音' }], 'Кино', '音').total, 1],
]) test(label, () => assert.deepEqual(actual(), want));
