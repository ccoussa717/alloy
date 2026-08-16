# Ollama Runtime Context and Reasoning Design

## Problem

Alloy discovers Ollama's model-native context limit from `/api/show` and advertises that value to Pi as the usable context window. On Chappie, Qwen 3.8 and Qwen 3.6 advertise 262,144 tokens but Ollama runs them with `OLLAMA_CONTEXT_LENGTH=8192`. Alloy therefore reports a 262K context window and a 32K output allowance while the server has only 8K total tokens.

The mismatch prevents Pi from budgeting or compacting against the real limit. Observed runs entered Ollama with 7,003 to 8,174 prompt tokens. The Qwen models consumed the remaining slot in hidden thinking, Ollama returned `finish_reason: length`, and Alloy displayed no final answer. A tool continuation also reached Ollama without a usable ordinary user query and failed with HTTP 500 after the context was already exhausted.

Alloy also marks every local OpenAI-compatible engine as not supporting reasoning effort. Ollama 0.32.13 supports `reasoning_effort` on `/v1/chat/completions`, including `none`, so Alloy currently cannot disable or tune thinking even when the user changes the thinking level.

## Goals

- Register Ollama models with the context window the server will actually use.
- Preserve explicit per-model `num_ctx` settings.
- Make Alloy's thinking controls effective for Ollama.
- Keep Chappie's benchmarked global 8K, eight-parallel Ollama configuration unchanged.
- Provide 32K Qwen profiles suitable for Alloy's system prompt, tool schemas, reasoning, and tool results.
- Verify real tool-call continuations complete with visible final answers.

## Non-Goals

- Changing global Ollama throughput tuning.
- Changing context detection for llama.cpp or LM Studio.
- Rewriting Pi's message history unless the 32K reproduction proves a separate serialization defect.
- Building the proposed multi-model benchmark feature.

## Design

### Context Precedence

Ollama discovery will resolve context in this order:

1. Explicit `num_ctx` in the model's `/api/show` `parameters` string.
2. Positive `OLLAMA_CONTEXT_LENGTH` from Alloy's environment.
3. Model architecture metadata such as `qwen35.context_length`.
4. Alloy's existing discovery default.

An explicit Modelfile setting is model-specific and wins over the service default. The service environment is the runtime default and wins over the architecture's theoretical maximum when no model-specific setting exists.

The resulting value remains bounded by the existing model-spec validation. `maxTokens` remains no greater than the resolved context window or Alloy's existing output cap.

### Ollama Compatibility

The generic local-engine compatibility object remains conservative for llama.cpp and LM Studio. Ollama receives a provider-specific compatibility object with:

- `supportsReasoningEffort: true`
- the existing OpenAI-compatible transport flags

Discovered reasoning-capable Ollama models receive a thinking-level map that sends:

- Alloy `off` as Ollama `none`
- `low`, `medium`, and `high` unchanged

Pi will consequently emit `reasoning_effort` on Ollama's `/v1/chat/completions` requests. Non-reasoning models remain unaffected.

### Chappie Model Profiles

Create two Ollama aliases that reuse existing model blobs:

- `qwen3.8-alloy:latest`, based on `qwen3.8:latest`
- `qwen3.6-alloy:27b`, based on `qwen3.6:27b`

Each alias sets `PARAMETER num_ctx 32768`. The original 8K models remain available for throughput-sensitive work. Chappie's Alloy default changes to `qwen3.8-alloy:latest`; the global systemd drop-in remains unchanged.

### Tool Continuation Failure

Verification will make a Qwen model call a real Alloy tool and then require a visible final answer. If the existing `no user query found in messages` failure disappears at 32K, it will be treated as a secondary consequence of the exhausted context and no message-rewriting code will be added.

If the failure persists with a non-overflowing 32K request, implementation stops for a focused history-serialization investigation. Any correction must preserve the original user turn and include a regression test for `user -> assistant tool call -> tool result -> assistant answer`.

## Error Handling

- Invalid or non-positive `num_ctx` and environment values are ignored using existing numeric validation.
- Malformed `/api/show` data retains the existing isolated discovery fallback.
- Context metadata never expands beyond an explicit model runtime setting or service runtime default.
- Reasoning controls are sent only for models Ollama reports as thinking-capable.

## Testing

### Unit Tests

- Explicit Modelfile `num_ctx` overrides `OLLAMA_CONTEXT_LENGTH` and architecture metadata.
- `OLLAMA_CONTEXT_LENGTH` overrides architecture metadata when `num_ctx` is absent.
- Architecture metadata is used when no runtime setting exists.
- Ollama model specs expose reasoning-effort support and the `off -> none` mapping.
- llama.cpp and LM Studio retain conservative compatibility settings.

### Integration Tests

- Capture a fake Ollama OpenAI-compatible request and assert the selected reasoning level reaches `reasoning_effort`.
- Run the full Alloy test suite.
- Run real Qwen 3.8 and Qwen 3.6 Alloy sessions that invoke a tool and produce a visible final answer.
- Confirm `/api/ps` reports a 32,768-token runtime context for each alias.
- Confirm `/etc/systemd/system/ollama.service.d/10-parallel.conf` remains unchanged at 8K and eight parallel slots.

## Success Criteria

- Alloy registers ordinary Qwen models at 8K on this host and the explicit Alloy aliases at 32K.
- Alloy `off` sends `reasoning_effort: none`; other supported levels are transmitted accurately.
- Both Qwen Alloy aliases complete a tool-using task without a hidden-thinking-only length stop.
- No unrelated local-engine behavior or global Ollama tuning changes.
