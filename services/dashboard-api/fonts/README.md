# Fonts

The dashboard page embeds two fonts as base64 in its `@font-face` rules, so it makes no
third-party requests and needs nothing from the server beyond `/`.

| Font | Use | Kept | Size |
|---|---|---|---|
| [Archivo](https://github.com/Omnibus-Type/Archivo) | display (expanded) and text | weight 300–800, width 100–125%, Latin | ~33 KB |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | data, labels, money | weight 400–700, Latin | ~24 KB |

Both are under the SIL Open Font License 1.1 ([OFL.txt](OFL.txt)); the copyright and licence
names are kept inside the embedded files.

To rebuild them (new characters, other weights): `python3 build_fonts.py`, see the script's
docstring.
