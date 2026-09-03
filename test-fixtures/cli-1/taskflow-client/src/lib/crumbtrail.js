const ENDPOINT = import.meta.env.VITE_CRUMBTRAIL_ENDPOINT;
const API_KEY = import.meta.env.VITE_CRUMBTRAIL_API_KEY || undefined;
let logger = null;
export async function initCrumbtrail() {
  if (logger || !ENDPOINT) return logger;
  try {
    const { Crumbtrail, HttpTransport } = await import("crumbtrail-core");
    logger = Crumbtrail.init({
      transportInstance: new HttpTransport(ENDPOINT, { authToken: API_KEY }),
      httpEndpoint: ENDPOINT,
      // ...
      widget: false,
    });
  } catch (err) {
    /* ... */
  }
  return logger;
}
