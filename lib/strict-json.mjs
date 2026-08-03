import { FISSION_OUTPUT_LIMIT } from "./fission-packet.mjs";

const defaults = Object.freeze({
  outputBytes: FISSION_OUTPUT_LIMIT,
  depth: 64,
  nodes: 20_000,
  tokens: 50_000,
});

export function parseStrictJsonObject(input, limits = {}) {
  const bounds = { ...defaults, ...limits };
  if (typeof input !== "string") throw new Error("invalid_json");
  if (Buffer.byteLength(input) > bounds.outputBytes) throw new Error("output_limit");
  let text = input;
  if (text.startsWith("```json\n")) {
    if (!text.endsWith("\n```") || text.indexOf("```", 7) !== text.length - 3) {
      throw new Error("invalid_fence");
    }
    text = text.slice(8, -4);
  } else if (text.includes("```")) {
    throw new Error("invalid_fence");
  }

  let index = 0;
  let tokenCount = 0;
  let nodeCount = 0;

  const fail = (reason = "invalid_json") => {
    throw new Error(reason);
  };
  const consumeToken = () => {
    tokenCount += 1;
    if (tokenCount > bounds.tokens) fail("token_limit");
  };
  const consumeNode = () => {
    nodeCount += 1;
    if (nodeCount > bounds.nodes) fail("node_limit");
  };
  const whitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1;
  };
  const punctuation = (character) => {
    whitespace();
    if (text[index] !== character) fail();
    index += 1;
    consumeToken();
  };
  const string = () => {
    whitespace();
    if (text[index] !== '"') fail();
    index += 1;
    let value = "";
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') {
        consumeToken();
        return value;
      }
      if (character.charCodeAt(0) < 0x20) fail();
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escape = text[index++];
      const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (Object.hasOwn(simple, escape)) {
        value += simple[escape];
        continue;
      }
      if (escape !== "u") fail();
      const hex = text.slice(index, index + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
      const codeUnit = Number.parseInt(hex, 16);
      const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff;
      const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
      if (isLowSurrogate) fail("lone_surrogate");
      if (isHighSurrogate) {
        if (text.slice(index + 4, index + 6) !== "\\u") fail("lone_surrogate");
        const lowHex = text.slice(index + 6, index + 10);
        if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) fail("lone_surrogate");
        const lowUnit = Number.parseInt(lowHex, 16);
        if (lowUnit < 0xdc00 || lowUnit > 0xdfff) fail("lone_surrogate");
        value += String.fromCharCode(codeUnit, lowUnit);
        index += 10;
      } else {
        value += String.fromCharCode(codeUnit);
        index += 4;
      }
    }
    fail();
  };
  const scalar = () => {
    whitespace();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        consumeToken();
        return value;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) fail();
    index += match[0].length;
    consumeToken();
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  };
  const value = (depth) => {
    whitespace();
    consumeNode();
    if (text[index] === "{") return object(depth);
    if (text[index] === "[") return array(depth);
    if (text[index] === '"') return string();
    return scalar();
  };
  const nestedValue = (depth) => {
    whitespace();
    if ((text[index] === "{" || text[index] === "[") && depth + 1 > bounds.depth) {
      fail("depth_limit");
    }
    return value(depth + ((text[index] === "{" || text[index] === "[") ? 1 : 0));
  };
  const object = (depth) => {
    if (depth > bounds.depth) fail("depth_limit");
    punctuation("{");
    const result = {};
    const keys = new Set();
    whitespace();
    if (text[index] === "}") {
      punctuation("}");
      return result;
    }
    while (true) {
      const key = string();
      if (keys.has(key)) fail("duplicate_key");
      keys.add(key);
      punctuation(":");
      const parsed = nestedValue(depth);
      Object.defineProperty(result, key, {
        value: parsed,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      whitespace();
      if (text[index] === "}") {
        punctuation("}");
        return result;
      }
      punctuation(",");
    }
  };
  const array = (depth) => {
    if (depth > bounds.depth) fail("depth_limit");
    punctuation("[");
    const result = [];
    whitespace();
    if (text[index] === "]") {
      punctuation("]");
      return result;
    }
    while (true) {
      result.push(nestedValue(depth));
      whitespace();
      if (text[index] === "]") {
        punctuation("]");
        return result;
      }
      punctuation(",");
    }
  };

  whitespace();
  if (text[index] !== "{") fail("root_object_required");
  const result = value(1);
  whitespace();
  if (index !== text.length) fail("trailing_json");
  return result;
}
