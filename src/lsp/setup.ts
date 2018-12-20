import * as path from "path";
import { Writable } from "stream";
import * as vs from "vscode";
import { LanguageClient, LanguageClientOptions, StreamInfo } from "vscode-languageclient";
import * as WebSocket from "ws";
import { config } from "../config";
import { safeSpawn } from "../debug/utils";
import { dartVMPath } from "../sdk/utils";
import * as util from "../utils";

let lspClient: LanguageClient;

export function initLSP(context: vs.ExtensionContext, sdks: util.Sdks) {
	vs.window.showInformationMessage("LSP preview is enabled!");
	const client = startLsp(context, sdks);
	return {
		dispose: async (): Promise<void> => (await client).dispose(),
	};
}

async function startLsp(context: vs.ExtensionContext, sdks: util.Sdks): Promise<vs.Disposable> {
	const lspInspector = vs.extensions.getExtension("octref.lsp-inspector-webview");

	// Open the LSP Inspector if we have it installed.
	if (lspInspector) {
		await lspInspector.activate();
		await vs.commands.executeCommand("lspInspector.start");
	}

	// Create a web socket to the inspector to pipe the logs over.
	const websocketOutputChannel = lspInspector && await openLSPInspectorSocket();

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: "dart" }],
		outputChannel: websocketOutputChannel,
		synchronize: {
			// TODO: What are .clientrc? Should we replace this?
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: vs.workspace.createFileSystemWatcher("**/.clientrc"),
		},
	};

	lspClient = new LanguageClient(
		"dartAnalysisLSP",
		"Dart Analysis Server",
		() => spawn(sdks),
		clientOptions,
	);

	return lspClient.start();
}

function openLSPInspectorSocket(): Promise<vs.OutputChannel> {
	return new Promise((resolve, reject) => {
		// Read the inspectors config to see which port it's listening on.
		const socketPort = vs.workspace.getConfiguration("lspInspector").get("port");
		const socket = new WebSocket(`ws://localhost:${socketPort}`);

		let log = "";
		const websocketOutputChannel: vs.OutputChannel = {
			name: "websocket",
			// Only append the logs but send them later
			append(value: string) {
				log += value;
			},
			appendLine(value: string) {
				log += value;
				if (socket && socket.readyState === WebSocket.OPEN) {
					socket.send(log);
				}
				// console.log(log);
				log = "";
			},
			clear() { }, // tslint:disable-line:no-empty
			show() { }, // tslint:disable-line:no-empty
			hide() { }, // tslint:disable-line:no-empty
			dispose() { }, // tslint:disable-line:no-empty
		};

		socket.on("open", () => resolve(websocketOutputChannel));
		socket.on("error", (err: Error) => reject(err));
	});
}

function spawn(sdks: util.Sdks): Thenable<StreamInfo> {
	// TODO: Replace with constructing an Analyzer that passes LSP flag (but still reads config
	// from paths etc) and provide it's process.
	const vmPath = path.join(sdks.dart, dartVMPath);
	const args = config.previewLspArgs;

	const process = safeSpawn(undefined, vmPath, args);

	console.log(vmPath);
	console.log(args);
	process.stdout.on("data", (d) => console.log("<== " + (d && d.toString())));
	process.stderr.on("data", (d) => console.log("<== STDERR " + (d && d.toString())));

	const writeLogger = new Writable({
		write(chunk, encoding, callback) {
			console.log("==> " + chunk.toString());
			process.stdin.write(chunk, encoding, callback);
		},
	});

	return Promise.resolve({
		reader: process.stdout,
		writer: writeLogger,
	});
}
