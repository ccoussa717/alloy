import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { RpcClient, type RpcMessage } from "../src/rpc-client.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-rpc-child.ts", import.meta.url));
const clients = new Set<RpcClient>();

function createClient(
	mode: string,
	options: Partial<ConstructorParameters<typeof RpcClient>[0]> = {},
): RpcClient {
	const client = new RpcClient({
		command: process.execPath,
		args: [fixture],
		env: { RPC_FIXTURE_MODE: mode },
		requestTimeoutMs: 1_000,
		stopTimeoutMs: 50,
		...options,
	});
	clients.add(client);
	return client;
}

function waitForMessage(client: RpcClient, type: string): Promise<RpcMessage> {
	return new Promise((resolve) => {
		const unsubscribe = client.onMessage((message) => {
			if (message.type === type) {
				unsubscribe();
				resolve(message);
			}
		});
	});
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processExists(pid) && Date.now() < deadline) await Bun.sleep(10);
	return !processExists(pid);
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.stop()));
	clients.clear();
});

describe("RpcClient", () => {
	test("parses split and coalesced LF records without splitting U+2028", async () => {
		const client = createClient("framing");
		const messages: RpcMessage[] = [];
		const received = new Promise<void>((resolve) => {
			client.onMessage((message) => {
				messages.push(message);
				if (messages.length === 2) resolve();
			});
		});

		await client.start();
		await received;

		expect(client.running).toBe(true);
		expect(messages).toEqual([
			{ type: "notice", text: "coalesced" },
			{ type: "notice", text: "before\u2028after" },
		]);
	});

	test("correlates out-of-order responses by request id", async () => {
		const client = createClient("normal");
		await client.start();

		const first = client.request({ type: "first" });
		const second = client.request({ type: "second" });
		const [firstResponse, secondResponse] = await Promise.all([first, second]);

		expect(firstResponse).toMatchObject({ command: "first", data: { order: 1 } });
		expect(secondResponse).toMatchObject({ command: "second", data: { order: 2 } });
	});

	test("emits extension UI requests and writes extension UI responses", async () => {
		const client = createClient("normal");
		await client.start();
		const extensionRequest = waitForMessage(client, "extension_ui_request");

		await client.request({ type: "trigger_extension" });
		expect(await extensionRequest).toMatchObject({
			type: "extension_ui_request",
			id: "dialog-1",
			method: "confirm",
		});

		const received = waitForMessage(client, "extension_response_received");
		const result = await client.request({
			type: "extension_ui_response",
			id: "dialog-1",
			confirmed: true,
		});

		expect(result).toBeUndefined();
		expect(await received).toMatchObject({
			response: { type: "extension_ui_response", id: "dialog-1", confirmed: true },
		});
	});

	test("rejects startup unless get_state succeeds", async () => {
		const rejected = createClient("startup-reject");
		await expect(rejected.start()).rejects.toThrow("state unavailable");
		expect(rejected.running).toBe(false);

		const exited = createClient("startup-fail", { stderrLimitBytes: 64 });
		await expect(exited.start()).rejects.toThrow(/code=17/);
		expect(exited.stderr).toEndWith("startup failed\n");
		expect(Buffer.byteLength(exited.stderr)).toBeLessThanOrEqual(64);
	});

	test("rejects pending requests when the child exits", async () => {
		const client = createClient("normal");
		await client.start();

		await expect(client.request({ type: "exit_pending" })).rejects.toThrow(/code=23.*pending request failed/s);
		expect(client.running).toBe(false);
	});

	test("supports a bounded timeout for an explicitly observational request", async () => {
		const client = createClient("normal");
		await client.start();

		await expect(
			client.request({ type: "delayed_observation" }, { observational: true, timeoutMs: 20 }),
		).rejects.toThrow("observational request timed out: delayed_observation");
		expect(client.running).toBe(true);
	});

	test("does not apply the startup timeout to a delayed mutation", async () => {
		const client = createClient("normal", { requestTimeoutMs: 250 });
		await client.start();

		await expect(client.request({ type: "delayed_mutation" })).resolves.toMatchObject({
			command: "delayed_mutation",
			data: { mutated: true },
		});
	});

	test("treats malformed JSON as a fatal protocol error", async () => {
		const client = createClient("normal");
		await client.start();

		await expect(client.request({ type: "malformed_record" })).rejects.toThrow(
			/RPC protocol error: malformed JSON/,
		);
		expect(client.running).toBe(false);
	});

	test("treats non-object records as a fatal protocol error", async () => {
		const client = createClient("normal");
		await client.start();

		await expect(client.request({ type: "non_object_record" })).rejects.toThrow(
			/RPC protocol error: record must be an object with a string type/,
		);
		expect(client.running).toBe(false);
	});

	test("treats malformed and command-mismatched responses as fatal protocol errors", async () => {
		const malformed = createClient("normal");
		await malformed.start();
		await expect(malformed.request({ type: "invalid_response" })).rejects.toThrow(
			/response record has an invalid command, success, or error field/,
		);
		expect(malformed.running).toBe(false);

		const mismatched = createClient("normal");
		await mismatched.start();
		await expect(mismatched.request({ type: "mismatched_response" })).rejects.toThrow(
			/expected mismatched_response, received different_command/,
		);
		expect(mismatched.running).toBe(false);
	});

	test("redacts backend stderr before including it in displayable errors", async () => {
		const client = createClient("normal");
		await client.start();

		await expect(client.request({ type: "stderr_secret" })).rejects.toThrow("[REDACTED]");
		await expect(client.request({ type: "after_exit" })).rejects.not.toThrow("backend-secret-token");
		expect(client.stderr).toContain("backend-secret-token");
	});

	test("bounds unterminated stdout records and fails fatally when oversized", async () => {
		const client = createClient("normal", { stdoutRecordLimitBytes: 256 });
		await client.start();

		await expect(client.request({ type: "oversize_record" })).rejects.toThrow(
			/RPC protocol error: stdout record exceeds 256 bytes/,
		);
		expect(client.running).toBe(false);
	});

	test("prevents double start", async () => {
		const client = createClient("normal");
		await client.start();

		await expect(client.start()).rejects.toThrow("already started");
	});

	test("stop is idempotent and bounds the SIGKILL fallback", async () => {
		const client = createClient("ignore-term");
		await client.start();

		await Promise.all([client.stop(), client.stop()]);
		await client.stop();

		expect(client.running).toBe(false);
	});

	test("stops the entire backend process group on POSIX", async () => {
		if (process.platform === "win32") return;

		const client = createClient("process-group");
		const started = waitForMessage(client, "descendant_started");
		await client.start();
		const pid = (await started).pid;
		expect(typeof pid).toBe("number");
		expect(processExists(pid as number)).toBe(true);

		await client.stop();

		expect(await waitForProcessExit(pid as number, 500)).toBe(true);
	});
});
