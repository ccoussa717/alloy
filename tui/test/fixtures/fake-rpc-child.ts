import { spawn } from "node:child_process";

const mode = process.env.RPC_FIXTURE_MODE ?? "normal";
let input = "";
let firstRequest: Record<string, unknown> | undefined;

if (mode === "ignore-term") {
	process.on("SIGTERM", () => {});
}

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(request: Record<string, unknown>, data?: unknown): void {
	send({
		id: request.id,
		type: "response",
		command: request.type,
		success: true,
		...(data === undefined ? {} : { data }),
	});
}

function handle(request: Record<string, unknown>): void {
	if (request.type === "get_state") {
		if (mode === "startup-fail") {
			process.stderr.write(`${"x".repeat(256)}startup failed\n`, () => process.exit(17));
			return;
		}

		if (mode === "startup-reject") {
			send({
				id: request.id,
				type: "response",
				command: "get_state",
				success: false,
				error: "state unavailable",
			});
			return;
		}

		const ready = `${JSON.stringify({
			id: request.id,
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "fixture" },
		})}\n`;

		if (mode === "process-group") {
			const descendant = spawn(
				process.execPath,
				[
					"-e",
					'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)',
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			descendant.stdout.once("data", () => {
				send({ type: "descendant_started", pid: descendant.pid });
				process.stdout.write(ready);
			});
			return;
		}

		if (mode !== "framing") {
			process.stdout.write(ready);
			return;
		}

		const messages =
			ready +
			`${JSON.stringify({ type: "notice", text: "coalesced" })}\n` +
			`${JSON.stringify({ type: "notice", text: "before\u2028after" })}\n`;
		const bytes = Buffer.from(messages);
		const separator = Buffer.from("\u2028");
		const separatorIndex = bytes.indexOf(separator);

		process.stdout.write(bytes.subarray(0, separatorIndex + 1));
		setTimeout(() => process.stdout.write(bytes.subarray(separatorIndex + 1)), 5);
		return;
	}

	if (request.type === "first") {
		firstRequest = request;
		return;
	}

	if (request.type === "second") {
		respond(request, { order: 2 });
		if (firstRequest) respond(firstRequest, { order: 1 });
		return;
	}

	if (request.type === "trigger_extension") {
		send({
			type: "extension_ui_request",
			id: "dialog-1",
			method: "confirm",
			title: "Continue?",
			message: "Confirm the operation.",
		});
		respond(request);
		return;
	}

	if (request.type === "extension_ui_response") {
		send({ type: "extension_response_received", response: request });
		return;
	}

	if (request.type === "exit_pending") {
		process.stderr.write("pending request failed\n", () => process.exit(23));
		return;
	}

	if (request.type === "delayed_observation") {
		setTimeout(() => respond(request, { delayed: true }), 100);
		return;
	}

	if (request.type === "delayed_mutation") {
		setTimeout(() => respond(request, { mutated: true }), 350);
		return;
	}

	if (request.type === "malformed_record") {
		process.stdout.write("{not-json}\n");
		return;
	}

	if (request.type === "non_object_record") {
		process.stdout.write("null\n");
		return;
	}

	if (request.type === "oversize_record") {
		process.stdout.write(`{"type":"notice","payload":"${"x".repeat(2_048)}`);
		return;
	}

	if (request.type === "mismatched_response") {
		send({ id: request.id, type: "response", command: "different_command", success: true });
		return;
	}

	if (request.type === "invalid_response") {
		send({ id: request.id, type: "response", command: request.type, success: "yes" });
		return;
	}

	if (request.type === "stderr_secret") {
		process.stderr.write("Authorization: Bearer backend-secret-token\n", () => process.exit(24));
		return;
	}

	respond(request);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	input += chunk;
	while (true) {
		const newline = input.indexOf("\n");
		if (newline === -1) break;
		let line = input.slice(0, newline);
		input = input.slice(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.length > 0) handle(JSON.parse(line) as Record<string, unknown>);
	}
});
