// The image processor `read` prepares images with (pi-durable's Photon one, on WebAssembly): every image a script reads
// is decoded, turned upright by its EXIF orientation, converted when providers do not take its format (BMP becomes
// PNG), and shrunk to the model's image limits (by default 2000x2000 pixels and 4.5 MB of base64), with a note giving
// the scale for mapping coordinates back. Without one, pi-durable's `read` refuses an image over those limits ("too
// large to send, and no image processor is configured to shrink it").
//
// `/images/node` prepares images in a worker thread, so a large photo does not block the event loop, and the thread
// exits after 30 s without images, freeing Photon's memory. It loads Photon only at the first image; `imageProcessor`
// prepares one pixel at start, so a build that cannot load it fails there rather than at the first image.
//
// The worker is given a standalone copy of the bytes. pi-durable (1.5.2 still) copies them with `bytes.slice()` and
// transfers that copy's buffer, but a Node `Buffer`'s `slice()` is a view: a small Buffer lives in Node's shared pool,
// which cannot be transferred ("DataCloneError: Cannot transfer object of unsupported type"), and a larger one would be
// taken from the caller. The environment's `readBinaryFile` gives Buffers.
import { defineExtension, hook, ToolTask, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits, type ImageProcessor } from "@earendil-works/pi-durable/tools";

/** A 1x1 PNG. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** The processor for `read`, checked by preparing one pixel. Throws when Photon cannot be loaded. */
export async function imageProcessor(): Promise<ImageProcessor> {
	const photon = await createNodePhotonImages();
	const images: ImageProcessor = { prepare: (bytes, mimeType, limits) => photon.prepare(new Uint8Array(bytes), mimeType, limits) };
	const check = await images.prepare(PIXEL, "image/png", DEFAULT_IMAGE_LIMITS).catch((error: unknown) => {
		throw new Error(`the image processor (Photon) cannot be loaded: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	});
	if (check === undefined) throw new Error("the image processor (Photon) cannot prepare a PNG");
	return images;
}

/** Formats every provider takes inline (pi-durable's `INLINE_IMAGE_TYPES`, which it does not export). */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The width and height an image declares in its header, without decoding it: PNG's IHDR, GIF's screen, WebP's VP8,
 * VP8L or VP8X chunk, JPEG's first SOF segment. `undefined` when the header cannot be read.
 */
export function imageSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (at: number, text: string) => at + text.length <= bytes.length && [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
	const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
	try {
		if (bytes[0] === 0x89 && ascii(1, "PNG") && ascii(12, "IHDR")) return size(view.getUint32(16), view.getUint32(20));
		if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return size(view.getUint16(6, true), view.getUint16(8, true));
		if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
			if (ascii(12, "VP8 ")) return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
			if (ascii(12, "VP8L")) {
				const bits = view.getUint32(21, true);
				return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
			}
			// 24-bit little-endian width and height, less one, ending the 30-byte header.
			const u24 = (at: number) => view.getUint16(at, true) | (view.getUint8(at + 2) << 16);
			if (ascii(12, "VP8X")) return size(1 + u24(24), 1 + u24(27));
			return undefined;
		}
		if (bytes[0] === 0xff && bytes[1] === 0xd8) {
			let at = 2;
			while (at + 9 <= bytes.length) {
				if (bytes[at] !== 0xff) return undefined;
				const marker = bytes[at + 1]!;
				if (marker === 0xff) {
					at += 1;
					continue;
				}
				// Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(view.getUint16(at + 7), view.getUint16(at + 5));
				at += 2 + view.getUint16(at + 2);
			}
		}
	} catch {
		// A header shorter than it claims.
	}
	return undefined;
}

/** Whether an image cannot go to the model as it is: a type providers do not take inline, or over the limits. */
function overLimits(data: string, mimeType: string, limits: ImageLimits): boolean {
	if (!INLINE_IMAGE_TYPES.has(mimeType) || data.length > limits.maxBytes) return true;
	const size = imageSize(Buffer.from(data, "base64"));
	// An unreadable header is the image check's to refuse, not a reason to decode it here.
	return size !== undefined && (size.width > limits.maxWidth || size.height > limits.maxHeight);
}

/**
 * The images a call the model made gives it, fitted to the model's limits, as `read` fits the images it reads. In claw
 * that call is `codemode`, whose result holds every image the model sees: `image()` of a screenshot, a generated image,
 * an MCP tool's, a data URL. Only an image over the limits (pi-durable's defaults: no model in the catalog sets
 * `inputLimits`) goes to the processor, found from its type, size and header; every other image is left exactly as it
 * is. A fitted image is followed by a note with its scale, as `read`'s, and says the saved file (codemode's "[Image
 * saved to ...]") is the original. One that cannot be fitted becomes a text saying so.
 */
export async function fitImages(result: ToolExecutionResult, images: ImageProcessor, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): Promise<ToolExecutionResult | undefined> {
	const output = result.output;
	if (output === undefined || !output.some((block) => block.type === "image" && overLimits(block.data, block.mimeType, limits))) return undefined;
	const fitted: NonNullable<ToolExecutionResult["output"]>[number][] = [];
	for (const block of output) {
		if (block.type !== "image" || !overLimits(block.data, block.mimeType, limits)) {
			fitted.push(block);
			continue;
		}
		const prepared = await images.prepare(Buffer.from(block.data, "base64"), block.mimeType, limits).catch(() => undefined);
		if (prepared === undefined) {
			fitted.push({ type: "text", text: `[Image not shown to the model: this ${block.mimeType} could not be made to fit its limits (${limits.maxWidth}x${limits.maxHeight}, ${limits.maxBytes} bytes of base64).]` });
			continue;
		}
		fitted.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
		const notes = ["[Image shown to the model"];
		if (prepared.resized !== undefined) {
			const { from, to } = prepared.resized;
			notes[0] += ` resized from ${from.width}x${from.height} to ${to.width}x${to.height}`;
			notes.push(`Multiply coordinates by ${(from.width / to.width).toFixed(2)} to map them to the original.`);
		}
		if (prepared.convertedFrom !== undefined || prepared.mimeType !== block.mimeType) notes[0] += ` as ${prepared.mimeType}`;
		notes[0] += ", to fit its limits; a saved file is the original.";
		fitted.push({ type: "text", text: `${notes.join(" ")}]` });
	}
	return { ...result, output: fitted };
}

/** `fitImages` on the result of each call the model makes (not a script's nested calls: their images reach the model
 * only through the script's own result). */
export function imageFitExtension(images: ImageProcessor): Extension {
	return defineExtension({
		name: "image-fit",
		hooks: [hook(ToolTask, { afterTool: (call, result) => (call.parent === undefined ? fitImages(result, images) : undefined) })],
	});
}
