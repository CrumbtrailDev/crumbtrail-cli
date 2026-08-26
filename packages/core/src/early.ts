/**
 * Side-effect entry point: `import "crumbtrail-core/early";`
 *
 * Place it on the first line of the application entry file, above every other
 * import, so `fetch`, `XMLHttpRequest`, and page-load subresource errors are
 * observed before the main SDK chunk exists. Everything it records is handed
 * to `Crumbtrail.init()` when that runs; see ./early-capture for the queue, the
 * caps, and the 60s window.
 */
import { installEarlyCapture } from "./early-capture";

installEarlyCapture();
