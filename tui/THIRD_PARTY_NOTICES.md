# Third-Party Notices

## OpenCode 1.18.4

Copyright (c) 2025 opencode

Licensed under the MIT License. The complete notice is in `LICENSE.opencode`.
Source commit: `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`.

## OpenTUI 0.4.5

Copyright (c) 2025 opentui

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source commit: `0c8c4f7cff2927e3df63a9757a45eff9a343611c`.

## Tree-sitter language parsers

Alloy bundles the following MIT-licensed Tree-sitter parser WASM and highlight
queries so syntax highlighting remains offline and does not execute parser code
downloaded at runtime:

| Parser | Version | Source commit |
|---|---:|---|
| Bash | 0.25.0 | `56b54c61fb48bce0c63e3dfa2240b5d274384763` |
| C | 0.24.1 | `7fa1be1b694b6e763686793d97da01f36a0e5c12` |
| C++ | 0.23.4 | `f41e1a044c8a84ea9fa8577fdd2eab92ec96de02` |
| Go | 0.25.0 | `1547678a9da59885853f5f5cc8a99cc203fa2e2c` |
| Java | 0.23.5 | `94703d5a6bed02b98e438d7cad1136c01a60ba2c` |
| Python | 0.23.6 | `bffb65a8cfe4e46290331dfef0dbf0ef3679de11` |
| Rust | 0.24.0 | `18b0515fca567f5a10aee9978c6d2640e878671a` |

The exact upstream license for each parser is included at
`assets/parsers/<language>/LICENSE`. Asset provenance and SHA-256 hashes are
recorded in `assets/parsers/manifest.json` and enforced by the release gate and
source installer. Alloy corrects one malformed all-caps constant predicate in
the Rust highlight query; that local change is recorded in the manifest.

## SolidJS 1.9.12

Copyright (c) 2016-2025 Ryan Carniato

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
