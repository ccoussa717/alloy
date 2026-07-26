import { fileURLToPath } from "node:url";

const asset = (language: string, name: "parser.wasm" | "highlights.scm") =>
  fileURLToPath(new URL(`../assets/parsers/${language}/${name}`, import.meta.url));

export default {
  parsers: [
    {
      filetype: "bash",
      aliases: ["sh", "shell", "zsh"],
      wasm: asset("bash", "parser.wasm"),
      queries: {
        highlights: [asset("bash", "highlights.scm")],
      },
    },
    {
      filetype: "c",
      aliases: ["h"],
      wasm: asset("c", "parser.wasm"),
      queries: {
        highlights: [asset("c", "highlights.scm")],
      },
    },
    {
      filetype: "cpp",
      aliases: ["c++", "cc", "cxx", "hpp"],
      wasm: asset("cpp", "parser.wasm"),
      queries: {
        highlights: [asset("c", "highlights.scm"), asset("cpp", "highlights.scm")],
      },
    },
    {
      filetype: "go",
      wasm: asset("go", "parser.wasm"),
      queries: {
        highlights: [asset("go", "highlights.scm")],
      },
    },
    {
      filetype: "java",
      wasm: asset("java", "parser.wasm"),
      queries: {
        highlights: [asset("java", "highlights.scm")],
      },
    },
    {
      filetype: "python",
      aliases: ["py", "pyi"],
      wasm: asset("python", "parser.wasm"),
      queries: {
        highlights: [asset("python", "highlights.scm")],
      },
    },
    {
      filetype: "rust",
      aliases: ["rs"],
      wasm: asset("rust", "parser.wasm"),
      queries: {
        highlights: [asset("rust", "highlights.scm")],
      },
    },
  ],
};
