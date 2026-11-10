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
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";

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
