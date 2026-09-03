/**
 * Classic-script entry for static HTML pages.
 *
 * The core package's normal `early` entry is an ES module. This entry is bundled
 * as a browser IIFE so a static page can load it with a parser-blocking classic
 * `<script src>` before any application script. It deliberately does not
 * initialize the SDK or make a request. The later core module finds the queue
 * on `globalThis` and drains it through the normal init path.
 */
import { installEarlyCapture } from "./early-capture";

installEarlyCapture();
