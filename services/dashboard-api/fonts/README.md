# Fonts

The dashboard page embeds three fonts as base64 in its `@font-face` rules, so it makes no
third-party requests and needs nothing from the server beyond `/`. Manrope and Inter are the
faces coderco.io uses; JetBrains Mono carries the data.

| Font | Use | Kept | Size |
|---|---|---|---|
| [Manrope](https://github.com/sharanda/manrope) | display, headings, big figures | weight 500–800, Latin | ~15 KB |
| [Inter](https://github.com/rsms/inter) | text and controls | weight 400–700 (optical size 14), Latin | ~20 KB |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | data, labels, money | weight 400–700, Latin | ~24 KB |

All three are under the SIL Open Font License 1.1 ([OFL.txt](OFL.txt)); the copyright and licence
names are kept inside the embedded files.

To rebuild them (new characters, other weights): `python3 build_fonts.py`, see the script's
docstring.
