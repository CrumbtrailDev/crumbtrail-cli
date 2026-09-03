const ENDPOINT = process.env.CRUMBTRAIL_ENDPOINT;
const API_KEY = process.env.CRUMBTRAIL_API_KEY;

let mod = null;
let loaded = false;

async function load() {
  if (loaded) return mod;
  loaded = true;
  if (!ENDPOINT) return null;
  try {
    mod = await import("crumbtrail-node");
  } catch {
    mod = null;
  }
  return mod;
}

export async function attachCrumbtrail(app) {
  const ct = await load();
  if (!ct) return false;
  app.use(
    ct.createCrumbtrailExpressMiddleware({
      endpoint: ENDPOINT,
      authToken: API_KEY,
    }),
  );
  return true;
}

export async function attachCrumbtrailErrors(app) {
  const ct = await load();
  if (!ct) return;
  app.use(
    ct.createCrumbtrailExpressErrorMiddleware({
      endpoint: ENDPOINT,
      authToken: API_KEY,
    }),
  );
}
