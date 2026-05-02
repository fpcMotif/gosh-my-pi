import { getImageDimensions, TERMINAL } from "@oh-my-pi/pi-tui";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { Spacer } from "@oh-my-pi/pi-tui/components/spacer";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { TUI } from "@oh-my-pi/pi-tui/tui";

const testImagePath = Bun.argv[2] || "/tmp/test-image.png";

process.stdout.write(`Terminal capabilities: ${JSON.stringify(TERMINAL)}\n`);
process.stdout.write(`Loading image from: ${testImagePath}\n`);

async function loadImage(): Promise<Uint8Array | null> {
	try {
		const file = Bun.file(testImagePath);
		return await file.bytes();
	} catch {
		process.stderr.write(`Failed to load image: ${testImagePath}\n`);
		process.stderr.write("Usage: bun test/image-test.ts [path-to-image.png]\n");
		return null;
	}
}

const imageBuffer = await loadImage();
if (imageBuffer === null) {
	process.exitCode = 1;
} else {
	const base64Data = imageBuffer.toBase64();
	const dims = getImageDimensions(base64Data, "image/png");

	process.stdout.write(`Image dimensions: ${JSON.stringify(dims)}\n`);
	process.stdout.write("\n");

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	tui.addChild(new Text("Image Rendering Test", 1, 1));
	tui.addChild(new Spacer(1));

	if (dims === null) {
		tui.addChild(new Text("Could not parse image dimensions", 1, 0));
	} else {
		tui.addChild(
			new Image(base64Data, "image/png", { fallbackColor: s => `\x1b[33m${s}\x1b[0m` }, { maxWidthCells: 60 }, dims),
		);
	}

	tui.addChild(new Spacer(1));
	tui.addChild(new Text("Press Ctrl+C to exit", 1, 0));

	const editor: { handleInput: (data: string) => void } = {
		handleInput(data: string) {
			if (data.charCodeAt(0) === 3) {
				tui.stop();
				process.exitCode = 0;
			}
		},
	};

	tui.setFocus(editor as never);
	tui.start();
}
