import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const opusTemplate = getBuiltinModel("anthropic", "claude-opus-4-8");

export const ALLOY_CLAUDE_OPUS_5_MODEL = Object.freeze({
  ...opusTemplate,
  id: "claude-opus-5",
  name: "Claude Opus 5",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  thinkingLevelMap: {
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsStrictTools: true,
  },
});

export function getAlloyTrustedModel(provider, modelId) {
  if (provider === "anthropic" && modelId === "claude-opus-5") {
    return ALLOY_CLAUDE_OPUS_5_MODEL;
  }
  return getBuiltinModel(provider, modelId);
}
