# Emoji sources

Every PNG here was exported from the Dungeon Blitz client SWFs in
`private-dungeon-blitz-r/src/client/content/localhost/p/` with JPEXS FFDec 25.0.0 (CLI).
Each image was then trimmed to its alpha bounding box (alpha > 8), scaled to fit 124x124 with
its aspect ratio kept, and centered on a transparent 128x128 canvas (2 px margin).

"Char id" is the SWF character id (FFDec `-selectid`). "Frame" is the sprite frame FFDec wrote
(`<n>.png`). "Zoom" is the FFDec `-zoom` used for the source render.

| Emoji | Source SWF | Char id | Symbol class / context | Frame | Zoom |
|---|---|---|---|---|---|
| `class_mage` | `cbp/UI_0.swf` | 274 | Class crest from the class-select screen (frame 2 of the crest holder sprite 291, inside `a_ClassSelection_Screen`) | 1 | 4 |
| `class_paladin` | `cbp/UI_0.swf` | 282 | Class crest (frame 3 of sprite 291) | 1 | 4 |
| `class_rogue` | `cbp/UI_0.swf` | 290 | Class crest (frame 4 of sprite 291) | 1 | 4 |
| `disc_executioner` | `cbp/UI_4.swf` | 507 | `am_Portrait` in the Class Tower screen (`a_ScreenClassTower`), frame label `executioner` | 1 | 2 |
| `disc_flameseer` | `cbp/UI_4.swf` | 507 | same sprite, label `flameseer` | 2 | 2 |
| `disc_frostwarden` | `cbp/UI_4.swf` | 507 | same sprite, label `frostwarden` | 3 | 2 |
| `disc_justicar` | `cbp/UI_4.swf` | 507 | same sprite, label `justicar` | 4 | 2 |
| `disc_sentinel` | `cbp/UI_4.swf` | 507 | same sprite, label `sentinel` | 5 | 2 |
| `disc_shadowwalker` | `cbp/UI_4.swf` | 507 | same sprite, label `shadowwalker` | 6 | 2 |
| `disc_templar` | `cbp/UI_4.swf` | 507 | same sprite, label `templar` | 7 | 2 |
| `disc_soulthief` | `cbp/UI_4.swf` | 507 | same sprite, label `soulthief` | 8 | 2 |
| `disc_necromancer` | `cbp/UI_4.swf` | 507 | same sprite, label `necromancer` | 9 | 2 |
| `cur_gold` | `cbp/UI_2.swf` | 654 | `a_BasicGoldIcon` | 1 | 8 |
| `cur_idol` | `caa/UI_Library.swf` | 682 | `_DoodadMammothIdol` | 1 | 4 |
| `cur_dragon_key` | `cbp/UI_2.swf` | 522 | `a_Icon_LockboxKey` (the Dragon Key opens lockboxes) | 1 | 4 |
| `cur_dragon_ore` | `caa/UI_Library.swf` | 1052 | `_DoodadDragonOre1` | 1 | 4 |
| `cur_silver_sigil` | `cbp/UI_2.swf` | 416 | `a_RoyalEmblemIcon` (silver variant) | 1 | 4 |
| `cur_royal_sigil` | `cbp/UI_2.swf` | 414 | `a_RoyalEmblemIconGold` (gold variant) | 1 | 4 |
| `ui_level` | `caa/UI_Library.swf` | 597 | `_DoodadStarFull01` | 1 | 8 |
| `ui_quest` | `caa/UI_Library.swf` | 623 | `_DoodadQuestMarker02` (gold "!") | 1 | 4 |
| `ui_character` | `caa/UI_Library.swf` | 1227 | `_DoodadToBeHeadshot` (grey portrait silhouette) | 1 | 4 |
| `ui_delete` | `caa/UI_Library.swf` | 611 | `_DoodadSkull01` | 1 | 4 |

The frame-to-discipline mapping for sprite 507 comes from its `FrameLabel` tags
(`ffdec -dumpSWF cbp/UI_4.swf`). The labels match the `mMasterClass` strings the client uses.

## Not found

- `ui_rename`: the SWFs have no quill or pen art. The armory's `am_Rename` control
  (`cbp/UI_4.swf`, char 1266) is a text-only "Rename" button.

## Alternatives that were not used

- `cbp/UI_1.swf` `a_Icon_<name>` (chars 2521-2547) are square discipline/power-style icons.
  Their names are the old internal ones: `assassin`, `blademaster`, `cryomancer`/`pyromancer` in the
  `_Swap` variants. `frostwarden` and `flameseer` render as particle-effect frames. The class ones
  (`a_Icon_mage/rogue/paladin`) place art from `UI_Library.swf` by class name, so FFDec renders them
  as empty colored tiles.
- `caa/UI_Library.swf` `_DoodadGoldGroup01/02`, `_IconArtGoldPile01`: alternative gold art.
- `cbp/UI_2.swf` `a_RewardTypeIcon_Gold*`: gold piles on a purple tile.

## Reproduce

```sh
FFDEC="java -jar /Applications/FFDec.app/Contents/Resources/ffdec-cli.jar"
P=src/client/content/localhost/p   # in private-dungeon-blitz-r
$FFDEC -zoom 4 -format sprite:png -selectid 274,282,290 -export sprite out/ui0 $P/cbp/UI_0.swf
$FFDEC -zoom 2 -format sprite:png -selectid 507 -export sprite out/ui4 $P/cbp/UI_4.swf
$FFDEC -zoom 4 -format sprite:png -selectid 414,416,522 -export sprite out/ui2 $P/cbp/UI_2.swf
$FFDEC -zoom 8 -format sprite:png -selectid 654 -export sprite out/ui2_8 $P/cbp/UI_2.swf
$FFDEC -zoom 4 -format sprite:png -selectid 611,623,682,1052,1227 -export sprite out/uilib $P/caa/UI_Library.swf
$FFDEC -zoom 8 -format sprite:png -selectid 597 -export sprite out/uilib8 $P/caa/UI_Library.swf
# -> out/<dir>/DefineSprite_<id>[_<class>]/<frame>.png ; then trim alpha, fit 124px, pad to 128x128.
```

To find symbol names, run `$FFDEC -export symbolclass <outdir> <swf>`, which writes `symbols.csv`.
