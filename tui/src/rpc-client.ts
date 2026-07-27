import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redactDisplayText } from "./content";

export type RpcMessage = { type: string; [key: string]: unknown };

export type RpcResponse = RpcMessage & {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
};

export interface RpcClientOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	requestTimeoutMs?: number;
	stopTimeoutMs?: number;
	stderrLimitBytes?: number;
	stdoutRecordLimitBytes?: number;
}

export type RpcRequestOptions =
	| { timeoutMs?: undefined; observational?: boolean }
	| { timeoutMs: number; observational: true };

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

type PendingRequest = {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const DEFAULT_STDOUT_RECORD_LIMIT_BYTES = 1024 * 1024;

export class RpcClient {
	private readonly options: RpcClientOptions;
	private readonly listeners = new Set<(message: RpcMessage) => void>();
	private readonly pending = new Map<string, PendingRequest>();
	private child: ChildProcessWithoutNullStreams | null = null;
	private starting = false;
	private stopPromise: Promise<void> | null = null;
	private requestId = 0;
	private stderrBuffer = Buffer.alloc(0);
	private exitError: Error | null = null;

	constructor(options: RpcClientOptions) {
		if (!options.command) throw new Error("RPC command is required");
		this.options = options;
	}

	get stderr(): string {
		return this.stderrBuffer.toString("utf8");
	}

	private get displayStderr(): string {
		return redactDisplayText(this.stderr);
	}

	get running(): boolean {
		const child = this.child;
		return child !== null && this.exitError === null && child.exitCode === null && child.signalCode === null;
	}

	async start(): Promise<void> {
		if (this.starting || this.child !== null || this.stopPromise !== null) {
			throw new Error("RPC client already started");
		}

		this.starting = true;
		this.exitError = null;
		this.stderrBuffer = Buffer.alloc(0);

		try {
			const child = spawn(this.options.command, this.options.args ?? [], {
				cwd: this.options.cwd,
				env: this.buildEnvironment(),
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			this.child = child;
			this.attachChild(child);

			const response = await this.request(
				{ type: "get_state" },
				{
					observational: true,
					timeoutMs: this.positiveOption(this.options.requestTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
				},
			);
			if (!response.success || response.command !== "get_state") {
				throw new Error(
					`RPC child readiness check failed: ${redactDisplayText(response.error ?? `unexpected ${response.command} response`)}`,
				);
			}
		} catch (error) {
			const startError = this.toError(error);
			await this.stop();
			throw startError;
		} finally {
			this.starting = false;
		}
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;

		const child = this.child;
		if (!child) return Promise.resolve();

		this.stopPromise = this.stopChild(child).finally(() => {
			if (this.child === child) this.child = null;
			this.starting = false;
			this.stopPromise = null;
		});
		return this.stopPromise;
	}

	request(command: RpcExtensionUIResponse): Promise<void>;
	request(command: RpcMessage, options?: RpcRequestOptions): Promise<RpcResponse>;
	request(command: RpcMessage, options: RpcRequestOptions = {}): Promise<RpcResponse | void> {
		if (command.type === "extension_ui_response") {
			if (options.timeoutMs !== undefined) {
				return Promise.reject(new Error("RPC extension UI responses do not support timeout options"));
			}
			return this.write(command);
		}

		const id = `alloy_${++this.requestId}`;
		const message = { ...command, id };
		let child: ChildProcessWithoutNullStreams;
		let line: string;
		try {
			child = this.requireWritableChild();
			line = this.serialize(message);
			if (options.timeoutMs !== undefined) {
				if (options.observational !== true) {
					throw new Error("RPC request timeouts are only valid for observational requests");
				}
				if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
					throw new Error("RPC request timeoutMs must be a positive finite number");
				}
			}
		} catch (error) {
			return Promise.reject(this.toError(error));
		}
		const timeoutMs = options.timeoutMs === undefined ? undefined : Math.floor(options.timeoutMs);

		return new Promise<RpcResponse>((resolve, reject) => {
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							this.pending.delete(id);
							reject(
								new Error(`RPC observational request timed out: ${command.type}. Stderr: ${this.displayStderr}`),
							);
						}, timeoutMs);

			this.pending.set(id, {
				command: command.type,
				resolve: (response) => {
					if (timer) clearTimeout(timer);
					resolve(response);
				},
				reject: (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				},
			});

			this.writeTo(child, line).catch((error: Error) => {
				this.failStdin(child, error);
			});
		});
	}

	onMessage(listener: (message: RpcMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private attachChild(child: ChildProcessWithoutNullStreams): void {
		let stdoutBuffer = Buffer.alloc(0);
		let terminal = false;
		const recordLimit = this.positiveOption(
			this.options.stdoutRecordLimitBytes,
			DEFAULT_STDOUT_RECORD_LIMIT_BYTES,
		);

		const consume = (chunk: Buffer | string): void => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			let offset = 0;
			while (offset < bytes.length && !terminal) {
				const newline = bytes.indexOf(0x0a, offset);
				const end = newline === -1 ? bytes.length : newline;
				const part = bytes.subarray(offset, end);
				if (stdoutBuffer.length + part.length > recordLimit) {
					terminal = true;
					this.failProtocol(child, `stdout record exceeds ${recordLimit} bytes`);
					return;
				}

				if (part.length > 0) stdoutBuffer = Buffer.concat([stdoutBuffer, part]);
				if (newline === -1) return;

				const record = stdoutBuffer;
				stdoutBuffer = Buffer.alloc(0);
				if (!this.handleRecord(child, record)) {
					terminal = true;
					return;
				}
				offset = newline + 1;
			}
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			if (this.child === child && !terminal) consume(chunk);
		});
		child.stdout.on("end", () => {
			if (this.child !== child || terminal) return;
			if (stdoutBuffer.length > 0 && !this.handleRecord(child, stdoutBuffer)) terminal = true;
			stdoutBuffer = Buffer.alloc(0);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			if (this.child === child) this.appendStderr(chunk);
		});

		const fail = (error: Error, terminate: boolean): void => {
			if (terminal) return;
			terminal = true;
			if (this.child !== child) return;
			this.exitError = error;
			this.rejectPending(error);
			if (terminate) void this.stop();
			else this.child = null;
		};

		child.once("error", (error) => {
			fail(new Error(`RPC child process error: ${redactDisplayText(error.message)}. Stderr: ${this.displayStderr}`), true);
		});
		child.once("exit", (code, signal) => {
			if (this.child === child && !this.stopPromise) void this.terminateProcessTree(child);
		});
		child.once("close", (code, signal) => {
			if (this.stopPromise) return;
			fail(new Error(`RPC child exited (code=${code} signal=${signal}). Stderr: ${this.displayStderr}`), false);
		});
		child.stdin.on("error", (error) => this.failStdin(child, error));
	}

	private handleRecord(child: ChildProcessWithoutNullStreams, record: Buffer): boolean {
		if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
		const line = record.toString("utf8");

		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.failProtocol(child, "malformed JSON record");
			return false;
		}

		if (!this.isMessage(message)) {
			this.failProtocol(child, "record must be an object with a string type");
			return false;
		}
		if (message.type === "response") {
			const id = typeof message.id === "string" ? message.id : undefined;
			if (!id) {
				this.failProtocol(child, "response record is missing a string id");
				return false;
			}
			if (
				typeof message.command !== "string" ||
				typeof message.success !== "boolean" ||
				(message.error !== undefined && typeof message.error !== "string")
			) {
				this.failProtocol(child, "response record has an invalid command, success, or error field");
				return false;
			}
			const pending = this.pending.get(id);
			if (!pending) return true;
			if (message.command !== pending.command) {
				this.failProtocol(
					child,
					`response command mismatch for ${id}: expected ${pending.command}, received ${message.command}`,
				);
				return false;
			}
			this.pending.delete(id);
			this.notify(message as RpcResponse);
			pending.resolve(message as RpcResponse);
			return true;
		}

		this.notify(message);
		return true;
	}

	private notify(message: RpcMessage): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(message);
			} catch {
				// A consumer callback must not corrupt transport processing for other listeners.
			}
		}
	}

	private write(message: RpcMessage): Promise<void> {
		let child: ChildProcessWithoutNullStreams;
		let line: string;
		try {
			child = this.requireWritableChild();
			line = this.serialize(message);
		} catch (error) {
			return Promise.reject(this.toError(error));
		}

		return this.writeTo(child, line).catch((error: Error) => {
			this.failStdin(child, error);
			throw this.exitError ?? error;
		});
	}

	private writeTo(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				child.stdin.write(line, (error?: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			} catch (error) {
				reject(this.toError(error));
			}
		});
	}

	private serialize(message: RpcMessage): string {
		const json = JSON.stringify(message);
		if (json === undefined) throw new Error("RPC message is not JSON serializable");
		return `${json}\n`;
	}

	private requireWritableChild(): ChildProcessWithoutNullStreams {
		const child = this.child;
		if (!child) throw this.exitError ?? new Error("RPC client is not started");
		if (this.stopPromise) throw new Error("RPC client is stopping");
		if (this.exitError) throw this.exitError;
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(
				`RPC child exited (code=${child.exitCode} signal=${child.signalCode}). Stderr: ${this.displayStderr}`,
			);
		}
		if (child.stdin.destroyed || !child.stdin.writable) {
			const error = new Error("stdin is not writable");
			this.failStdin(child, error);
			throw this.exitError ?? error;
		}
		return child;
	}

	private failStdin(child: ChildProcessWithoutNullStreams, cause: Error): void {
		if (this.child !== child || this.exitError) return;
		const error = new Error(`RPC child stdin failure: ${redactDisplayText(cause.message)}. Stderr: ${this.displayStderr}`);
		this.exitError = error;
		this.rejectPending(error);
		void this.stop();
	}

	private failProtocol(child: ChildProcessWithoutNullStreams, detail: string): void {
		if (this.child !== child || this.exitError) return;
		const error = new Error(`RPC protocol error: ${detail}. Stderr: ${this.displayStderr}`);
		this.exitError = error;
		this.rejectPending(error);
		void this.stop();
	}

	private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
		this.rejectPending(new Error(`RPC client stopped. Stderr: ${this.displayStderr}`));
		await this.terminateProcessTree(child);
	}

	private async terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
		if (!this.processTreeRunning(child)) return;
		const timeoutMs = this.nonNegativeOption(this.options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
		this.signalProcessTree(child, "SIGTERM");
		if (await this.waitForProcessTree(child, timeoutMs)) return;
		this.signalProcessTree(child, "SIGKILL");
		await this.waitForProcessTree(child, timeoutMs);
	}

	private waitForProcessTree(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const deadline = Date.now() + timeoutMs;
			const check = (): void => {
				if (!this.processTreeRunning(child)) {
					resolve(true);
					return;
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					resolve(false);
					return;
				}
				setTimeout(check, Math.min(10, remaining));
			};
			check();
		});
	}

	private processTreeRunning(child: ChildProcessWithoutNullStreams): boolean {
		if (process.platform === "win32" || child.pid === undefined) {
			return child.exitCode === null && child.signalCode === null;
		}
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}

	private signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
		if (process.platform !== "win32" && child.pid !== undefined) {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			}
		}
		child.kill(signal);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private appendStderr(chunk: Buffer | string): void {
		const limit = this.nonNegativeOption(this.options.stderrLimitBytes, DEFAULT_STDERR_LIMIT_BYTES);
		if (limit === 0) {
			this.stderrBuffer = Buffer.alloc(0);
			return;
		}

		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (bytes.length >= limit) {
			this.stderrBuffer = Buffer.from(bytes.subarray(bytes.length - limit));
			return;
		}

		const combined = Buffer.concat([this.stderrBuffer, bytes]);
		this.stderrBuffer = combined.length > limit ? Buffer.from(combined.subarray(combined.length - limit)) : combined;
	}

	private buildEnvironment(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const [key, value] of Object.entries(this.options.env ?? {})) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
		return env;
	}

	private isMessage(value: unknown): value is RpcMessage {
		return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
	}

	private positiveOption(value: number | undefined, fallback: number): number {
		return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
	}

	private nonNegativeOption(value: number | undefined, fallback: number): number {
		return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
	}

	private toError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}
}
